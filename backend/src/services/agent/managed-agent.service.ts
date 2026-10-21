/**
 * Claude Managed Agents client — talks to the "Billing Advisor Agent" created
 * in the Anthropic Console. One persisted agent (config lives in the Console,
 * versioned there) + one persisted environment; this service only creates and
 * drives SESSIONS, which is the per-request/per-user data-plane work.
 *
 * One active session per user (see AgentSession) so a conversation continues
 * across turns instead of starting fresh every message.
 */
import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/config/env";
import { AppError } from "@/utils/appError";
import { AgentSession } from "@/models/agent-session.model";
import { executeCustomTool } from "@/services/agent/agent-tools";
import { sanitizeForAgentContext } from "@/utils/sanitize-untrusted-text";
import { reserveCredits, settleReservation } from "@/services/credits/credit-ledger.service";
import {
  tokensToCredits,
  AGENT_TURN_RESERVE_CREDITS,
  AGENT_TURN_TIMEOUT_MS,
  AGENT_INTERRUPT_DRAIN_MS,
} from "@/config/credits";
import { acquireAgentTurnSlot } from "@/services/agent/agent-concurrency";
import type { ConnectionRequirements } from "@/services/integrations/capability-resolver";
import type {
  ProposeUpdateStatusResult,
  ProposeDeleteResult,
} from "@/services/ai/tools/billing-actions.tool";
import type { Types } from "mongoose";

/**
 * Surfaced to the frontend when the agent confirms a platform CAN be
 * live-connected — lets the chat UI offer a one-click deep link straight into
 * the real, already-secure Connect flow (Platforms page). Metadata only; the
 * agent never sees or forwards a credential.
 */
export interface ConnectPlatformAction {
  type: "connect_platform";
  platform: string;
  displayName: string;
  source: "native" | "pipedream";
}

/** Surfaced when the agent has resolved a "mark as Paid/Pending/Overdue"
 *  request to one exact record — the chat UI renders a confirm button that
 *  calls the existing `PUT /api/billing/:id` itself; the agent never makes
 *  this change directly (see billing-actions.tool.ts). */
export interface UpdateBillingStatusAction {
  type: "update_billing_status";
  billingId: string;
  customerName: string;
  invoiceNumber: string;
  currentStatus: string;
  newStatus: string;
}

/** Same confirm-first pattern as above, for a delete request — the chat UI's
 *  confirm button calls the existing `DELETE /api/billing/:id`. */
export interface DeleteBillingRecordAction {
  type: "delete_billing_record";
  billingId: string;
  customerName: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
}

export type AgentAction =
  | ConnectPlatformAction
  | UpdateBillingStatusAction
  | DeleteBillingRecordAction;

export interface AgentReply {
  reply: string;
  action?: AgentAction;
}

/**
 * WP-7 fix — the tool-call loop in `sendAgentMessage` previously had no
 * bound at all: a model that kept calling tools (a genuine bug on
 * Anthropic's side, a confused reasoning loop, or a future tool with a
 * surprising result shape it reacts badly to) could run indefinitely,
 * burning real tokens/credits on a SINGLE user turn with nothing to stop
 * it. Two tiers: at `MAX_TOOL_ITERATIONS_SOFT`, the agent is told (via an
 * error tool result, the same pattern already used to decline an
 * irrelevant tool call) that it's hit the limit and should wrap up with
 * whatever it has — giving it a real chance to produce a normal, useful
 * reply instead of being cut off mid-thought. `MAX_TOOL_ITERATIONS_HARD`
 * is the actual guarantee: if the model ignores that and keeps calling
 * tools anyway, the loop is forced to stop regardless, so there is always
 * a real ceiling no model behavior can exceed.
 */
const MAX_TOOL_ITERATIONS_SOFT = 8;
const MAX_TOOL_ITERATIONS_HARD = 12;

let client: Anthropic | null = null;

/** Lazily constructs the Anthropic client — never at import time. */
function getClient(): Anthropic {
  if (!env.anthropicApiKey || !env.anthropicAgentId || !env.anthropicEnvironmentId) {
    throw new AppError(
      "The AI agent isn't configured on this server yet. Please try again later.",
      503
    );
  }
  if (!client) client = new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

/**
 * Returns a live session ID for this (user, organization) pair — reusing
 * the stored one if it's still usable, otherwise creating a fresh session
 * and persisting its ID. See agent-session.model.ts's docstring for why
 * this is scoped by organization, not just user.
 */
async function getOrCreateSessionId(
  userId: Types.ObjectId | string,
  organizationId: Types.ObjectId | string
): Promise<string> {
  const anthropic = getClient();
  const existing = await AgentSession.findOne({ user: userId, organization: organizationId });

  if (existing) {
    try {
      const session = await anthropic.beta.sessions.retrieve(existing.sessionId);
      if (session.status !== "terminated") return existing.sessionId;
    } catch {
      // Session no longer resolvable (deleted, archived environment, etc.) —
      // fall through and create a replacement below.
    }
  }

  const session = await anthropic.beta.sessions.create({
    agent: env.anthropicAgentId,
    environment_id: env.anthropicEnvironmentId,
    title: `Billing Advisor — user ${userId.toString()} — org ${organizationId.toString()}`,
  });

  await AgentSession.findOneAndUpdate(
    { user: userId, organization: organizationId },
    { sessionId: session.id },
    { upsert: true }
  );

  return session.id;
}

/**
 * Ends the user's current agent conversation for ONE organization
 * ("New Chat", or a deliberate fresh start on workspace switch — see
 * auth.controller.ts's `switchOrganization`) — archives the Managed
 * Agents session (tidy cleanup, not required for correctness) and drops
 * the local pointer, so the next message in THIS organization starts a
 * brand-new session. Other organizations' sessions are untouched — each
 * has its own row (see agent-session.model.ts).
 */
export async function resetAgentSession(
  userId: Types.ObjectId | string,
  organizationId: Types.ObjectId | string
): Promise<void> {
  const existing = await AgentSession.findOne({ user: userId, organization: organizationId });
  if (!existing) return;

  try {
    const anthropic = getClient();
    await anthropic.beta.sessions.archive(existing.sessionId);
  } catch {
    // Already gone/archived, or the agent isn't configured — fine either way,
    // the local pointer removal below is what actually matters.
  }

  await AgentSession.deleteOne({ _id: existing._id });
}

/**
 * Ends EVERY one of a user's agent conversations, across every
 * organization — used only by account deletion (auth.controller.ts),
 * where the whole account (and so every organization's conversation with
 * it) is going away, unlike a workspace switch or "New Chat" which only
 * ever touch one organization's session.
 */
export async function resetAllAgentSessionsForUser(userId: Types.ObjectId | string): Promise<void> {
  const sessions = await AgentSession.find({ user: userId });
  if (sessions.length === 0) return;

  const anthropic = getClient();
  await Promise.all(
    sessions.map((s) =>
      anthropic.beta.sessions.archive(s.sessionId).catch(() => {
        // Already gone/archived, or unreachable — the deleteMany below is
        // what actually matters for correctness.
      })
    )
  );

  await AgentSession.deleteMany({ user: userId });
}

const OUT_OF_CREDITS_MESSAGE =
  "This workspace has used all its credits. Add more credits to keep chatting with the Billing Advisor.";

/** Token/runtime usage accumulated across one turn's model requests. */
interface TurnUsage {
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

function emptyUsage(): TurnUsage {
  return {
    modelRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function addModelUsage(
  usage: TurnUsage,
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }
): void {
  usage.modelRequests++;
  usage.inputTokens += modelUsage.input_tokens;
  usage.outputTokens += modelUsage.output_tokens;
  usage.cacheCreationInputTokens += modelUsage.cache_creation_input_tokens;
  usage.cacheReadInputTokens += modelUsage.cache_read_input_tokens;
}

/** A turn's real cost in credits. A turn that never reached the model (it
 *  failed first) costs nothing, so its whole reservation is refunded. */
function actualTurnCredits(usage: TurnUsage, startedAt: number): number {
  if (usage.modelRequests === 0) return 0;
  return tokensToCredits(usage.inputTokens, usage.outputTokens, {
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    sessionSeconds: (Date.now() - startedAt) / 1000,
  });
}

const READ_TIMED_OUT = Symbol("read-timed-out");

/**
 * Reads a session's event stream under a deadline (CLAUDE.md §10.3 P1-10).
 * When the turn runs past AGENT_TURN_TIMEOUT_MS — or the caller calls
 * `interrupt()` (the tool-call hard limit) — it sends `user.interrupt`, so
 * the session genuinely stops on Anthropic's side instead of running on
 * uncharged, then keeps reading for up to AGENT_INTERRUPT_DRAIN_MS so the
 * final `span.model_request_end` usage events are still counted before
 * settling. `next()` returns null once the stream ends or the drain window
 * closes.
 */
function createTurnReader<E>(
  anthropic: Anthropic,
  sessionId: string,
  stream: AsyncIterable<E>,
  startedAt: number
) {
  const iterator = stream[Symbol.asyncIterator]();
  let deadline = startedAt + AGENT_TURN_TIMEOUT_MS;
  const state = { interrupted: false, timedOut: false };

  const interrupt = async (): Promise<void> => {
    if (state.interrupted) return;
    state.interrupted = true;
    deadline = Date.now() + AGENT_INTERRUPT_DRAIN_MS;
    await anthropic.beta.sessions.events
      .send(sessionId, { events: [{ type: "user.interrupt" }] })
      .catch(() => {
        // Best-effort — the drain window below still bounds the wait.
      });
  };

  // A read that lost the race to the deadline is kept and re-awaited on the
  // next call — never replaced by a fresh `iterator.next()`, which would
  // silently drop whatever event the first read eventually resolves with
  // (possibly the very usage event the drain window exists to catch).
  let pendingRead: Promise<IteratorResult<E>> | null = null;

  const nextBeforeDeadline = async (): Promise<IteratorResult<E> | typeof READ_TIMED_OUT> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return READ_TIMED_OUT;
    pendingRead ??= iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof READ_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(READ_TIMED_OUT), remaining);
    });
    try {
      const result = await Promise.race([pendingRead, timeout]);
      if (result !== READ_TIMED_OUT) pendingRead = null;
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  const next = async (): Promise<E | null> => {
    for (;;) {
      const result = await nextBeforeDeadline();
      if (result === READ_TIMED_OUT) {
        if (state.interrupted) return null; // drain window over
        state.timedOut = true;
        await interrupt();
        continue;
      }
      return result.done ? null : result.value;
    }
  };

  const close = (): void => {
    void Promise.resolve(iterator.return?.()).catch(() => {
      // Best-effort — closing an already-finished stream is fine.
    });
  };

  return { next, interrupt, close, state };
}

/**
 * Runs ONE prompt through the Billing Advisor Agent on a throwaway session —
 * created fresh and archived immediately after, never touching the user's
 * persisted `AgentSession` (the one their visible chat thread continues on).
 * Used by background/system callers (the recommendation engine) that need the
 * agent's reasoning without leaking generation prompts into that chat history.
 */
export async function runAgentPrompt(
  userId: Types.ObjectId | string,
  organizationId: Types.ObjectId | string,
  prompt: string
): Promise<string> {
  const anthropic = getClient();

  // CLAUDE.md §10.3 P1-10 — this background path used to have no credit
  // gate at all, so a workspace already at 0 kept paying for recommendation
  // refreshes. Reserve first; recommendation-engine.ts treats this 403 as
  // "skipped, out of credits".
  const reservation = await reserveCredits(
    organizationId,
    AGENT_TURN_RESERVE_CREDITS,
    "recommendation_generation",
    userId
  );
  if (!reservation) throw new AppError(OUT_OF_CREDITS_MESSAGE, 403);

  const sessionStartedAt = Date.now();
  const usage = emptyUsage();
  let sessionId: string | null = null;
  let reader: ReturnType<typeof createTurnReader> | null = null;
  try {
    const session = await anthropic.beta.sessions.create({
      agent: env.anthropicAgentId,
      environment_id: env.anthropicEnvironmentId,
      title: `Recommendation refresh — user ${userId.toString()}`,
    });
    sessionId = session.id;

    const stream = await anthropic.beta.sessions.events.stream(session.id);
    await anthropic.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    });
    const turnReader = createTurnReader(anthropic, session.id, stream, sessionStartedAt);
    reader = turnReader;

    let reply = "";
    for (let event = await turnReader.next(); event; event = await turnReader.next()) {
      if (event.type === "agent.message") {
        for (const block of event.content) {
          if (block.type === "text") reply += block.text;
        }
      } else if (event.type === "agent.custom_tool_use") {
        if (turnReader.state.interrupted) continue;
        // Not relevant to a one-shot generation task — decline so the session
        // can still terminate cleanly instead of waiting on a result forever.
        await anthropic.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: "Not available for this request." }],
              is_error: true,
            },
          ],
        });
      } else if (event.type === "span.model_request_end") {
        // Same accounting as a chat turn (see sendAgentMessage below) — a
        // background generation call costs real tokens too, and skipping
        // this tracking would leave it invisible on the workspace's ledger.
        addModelUsage(usage, event.model_usage);
      } else if (event.type === "session.status_terminated") {
        break;
      } else if (event.type === "session.status_idle") {
        if (event.stop_reason?.type !== "requires_action") break;
      } else if (event.type === "session.error") {
        throw new AppError("The AI agent failed to generate a response.", 502);
      }
    }

    if (!reply.trim()) {
      throw new AppError(
        turnReader.state.timedOut
          ? "The AI agent took too long to respond."
          : "The AI agent didn't return a response.",
        turnReader.state.timedOut ? 504 : 502
      );
    }
    return reply;
  } finally {
    reader?.close();
    // Settle AFTER the turn (actual cost is only known once it's done), even
    // if the loop above threw — the API call already happened either way.
    // settleReservation never throws, so this can't mask the real error.
    await settleReservation(reservation.reservationId, actualTurnCredits(usage, sessionStartedAt));
    if (sessionId) {
      await anthropic.beta.sessions.archive(sessionId).catch(() => {
        // Best-effort cleanup — a stray unarchived session is not fatal.
      });
    }
  }
}

/**
 * Sends one user message to the user's agent session and waits for the
 * agent's reply, returning the concatenated text of its response. Used by
 * both the web chat and Slack.
 *
 * CLAUDE.md §10.3 P1-10 / S-10 — spend controls, in order: one turn at a
 * time per chat session and a per-workspace concurrency cap
 * (agent-concurrency.ts, 409/429), then an atomic credit reservation (403
 * when the workspace is out), then the turn itself, then settlement to the
 * real cost — always, even when the turn throws.
 */
export async function sendAgentMessage(
  userId: Types.ObjectId | string,
  organizationId: Types.ObjectId | string,
  text: string
): Promise<AgentReply> {
  const anthropic = getClient();
  const releaseSlot = acquireAgentTurnSlot(userId, organizationId);
  try {
    const reservation = await reserveCredits(
      organizationId,
      AGENT_TURN_RESERVE_CREDITS,
      "agent_message",
      userId
    );
    if (!reservation) throw new AppError(OUT_OF_CREDITS_MESSAGE, 403);

    const turnStartedAt = Date.now();
    const usage = emptyUsage();
    try {
      return await runChatTurn(anthropic, userId, organizationId, text, usage, turnStartedAt);
    } finally {
      await settleReservation(reservation.reservationId, actualTurnCredits(usage, turnStartedAt));
    }
  } finally {
    releaseSlot();
  }
}

/**
 * One chat turn on the user's persisted session. Stream-first: the event
 * stream is opened before the message is sent, so no events are missed (see
 * Anthropic's Managed Agents client-patterns guide). Accumulates model usage
 * into `usage` as it goes, so the caller can settle even if this throws.
 */
async function runChatTurn(
  anthropic: Anthropic,
  userId: Types.ObjectId | string,
  organizationId: Types.ObjectId | string,
  text: string,
  usage: TurnUsage,
  turnStartedAt: number
): Promise<AgentReply> {
  const sessionId = await getOrCreateSessionId(userId, organizationId);

  const stream = await anthropic.beta.sessions.events.stream(sessionId);
  await anthropic.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  const reader = createTurnReader(anthropic, sessionId, stream, turnStartedAt);

  let reply = "";
  let action: AgentAction | undefined;
  let toolIterations = 0;
  try {
    for (let event = await reader.next(); event; event = await reader.next()) {
      if (event.type === "agent.message") {
        for (const block of event.content) {
          if (block.type === "text") reply += block.text;
        }
      } else if (event.type === "agent.custom_tool_use") {
        // Interrupted (hard limit or timeout): no more tool results — just
        // keep draining for the final usage events.
        if (reader.state.interrupted) continue;
        toolIterations++;

        // WP-7 — the hard ceiling: send no further tool results, regardless
        // of what the model does next. See MAX_TOOL_ITERATIONS_HARD's own
        // docstring. Interrupts the session (instead of just ceasing to
        // read, which left it running — and costing — unseen) and drains
        // the remaining usage events so they're still charged.
        if (toolIterations > MAX_TOOL_ITERATIONS_HARD) {
          await reader.interrupt();
          continue;
        }

        // The soft ceiling: tell the model it's out of room, the same
        // decline pattern runAgentPrompt already uses for an irrelevant tool
        // call, so it gets a real chance to produce a normal closing reply
        // instead of just being cut off.
        if (toolIterations > MAX_TOOL_ITERATIONS_SOFT) {
          await anthropic.beta.sessions.events.send(sessionId, {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: event.id,
                content: [
                  {
                    type: "text",
                    text: "Tool call limit reached for this turn. Stop calling tools and reply now with whatever you've already found, noting that the answer may be incomplete.",
                  },
                ],
                is_error: true,
              },
            ],
          });
          continue;
        }

        // A registered read-only/metadata-only tool — run it locally and hand
        // the result straight back so the session can continue.
        let resultText: string;
        let isError = false;
        try {
          const input = (event.input ?? {}) as Record<string, unknown>;
          // WP-7 org-id consolidation — pass the SAME organizationId this
          // whole turn already resolved, instead of letting each tool
          // independently re-derive it from userId (a real race if the user
          // switches workspaces mid-turn — see types.ts's own docstring).
          const result = await executeCustomTool(
            organizationId.toString(),
            event.name,
            input
          );
          // Task 9 (S-07) — a second, independent sanitization pass right at
          // the boundary where a tool result actually enters the model's
          // context, on top of ai-invoice-extractor.ts's own ingest-time pass.
          // Catches anything that reaches this point from a path the ingest
          // sanitizer doesn't cover (a future tool, a field it doesn't touch)
          // rather than relying on a single point of defense.
          resultText = JSON.stringify(sanitizeForAgentContext(result));

          // The agent confirmed a real, live-connectable platform — surface a
          // deep link the frontend can turn into a one-click "Connect now"
          // button straight into the existing secure Connect flow.
          if (
            event.name === "get_connection_requirements" &&
            result &&
            typeof result === "object" &&
            (result as ConnectionRequirements).supported
          ) {
            const requirements = result as ConnectionRequirements;
            action = {
              type: "connect_platform",
              platform: requirements.platform,
              displayName: (requirements.displayName ?? requirements.platform).trim(),
              source: requirements.source === "pipedream" ? "pipedream" : "native",
            };
          } else if (
            event.name === "propose_update_billing_status" &&
            result &&
            typeof result === "object" &&
            (result as ProposeUpdateStatusResult).found
          ) {
            const r = result as Required<ProposeUpdateStatusResult>;
            action = {
              type: "update_billing_status",
              billingId: r.billingId,
              customerName: r.customerName,
              invoiceNumber: r.invoiceNumber,
              currentStatus: r.currentStatus,
              newStatus: r.proposedStatus,
            };
          } else if (
            event.name === "propose_delete_billing_record" &&
            result &&
            typeof result === "object" &&
            (result as ProposeDeleteResult).found
          ) {
            const r = result as Required<ProposeDeleteResult>;
            action = {
              type: "delete_billing_record",
              billingId: r.billingId,
              customerName: r.customerName,
              invoiceNumber: r.invoiceNumber,
              amount: r.amount,
              currency: r.currency,
            };
          }
        } catch (err) {
          resultText =
            err instanceof Error ? err.message : "Failed to run this tool. Please try again.";
          isError = true;
        }
        await anthropic.beta.sessions.events.send(sessionId, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: resultText }],
              is_error: isError,
            },
          ],
        });
      } else if (event.type === "span.model_request_end") {
        // A turn can involve multiple model requests (e.g. one per tool round
        // trip) — accumulate across the whole turn, not just the first one.
        addModelUsage(usage, event.model_usage);
      } else if (event.type === "session.status_terminated") {
        break;
      } else if (event.type === "session.status_idle") {
        // requires_action after a custom_tool_use just means "waiting on the
        // result we already sent above" — keep reading, don't treat as done.
        if (event.stop_reason?.type !== "requires_action") break;
      } else if (event.type === "session.error") {
        throw new AppError(
          "The AI agent ran into a problem answering that. Please try again.",
          502
        );
      }
    }
  } finally {
    // Settlement (charging what the turn really used — including tokens
    // spent before a mid-turn `session.error`) happens in sendAgentMessage's
    // own `finally`, from the `usage` accumulated above.
    reader.close();
  }

  if (!reply.trim()) {
    throw new AppError(
      reader.state.timedOut
        ? "The AI agent took too long to answer. Please try again."
        : "The AI agent didn't return a response. Please try again.",
      reader.state.timedOut ? 504 : 502
    );
  }

  return { reply, action };
}
