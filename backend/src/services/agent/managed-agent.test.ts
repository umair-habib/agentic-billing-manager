import { Types } from "mongoose";
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";

import { env } from "@/config/env";
import { AgentSession } from "@/models/agent-session.model";
import { Organization } from "@/models/organization.model";

const sessionsCreateMock = vi.fn();
const eventsStreamMock = vi.fn();
const eventsSendMock = vi.fn();
const sessionsArchiveMock = vi.fn();
const sessionsRetrieveMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    beta = {
      sessions: {
        create: sessionsCreateMock,
        retrieve: sessionsRetrieveMock,
        archive: sessionsArchiveMock,
        events: { stream: eventsStreamMock, send: eventsSendMock },
      },
    };
  },
}));

// Hoisted above these imports by vitest, so the mocked SDK is what the
// service actually constructs its client from.
import {
  sendAgentMessage,
  resetAgentSession,
  resetAllAgentSessionsForUser,
  runAgentPrompt,
} from "@/services/agent/managed-agent.service";

/** A minimal async-iterable the service's `for await` loop can consume,
 *  yielding exactly the events a test wants, in order. */
function fakeStream(events: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function toolUseEvent(id: string, name = "unknown_test_tool") {
  return { type: "agent.custom_tool_use", id, name, input: {} };
}

/** A real workspace with credits — sendAgentMessage reserves credits before
 *  every turn (P1-10), so a made-up organization id is refused with 403. */
async function fundedOrgId(): Promise<Types.ObjectId> {
  const organization = await Organization.create({ name: "Funded Test Org", creditsBalance: 1000 });
  return organization._id;
}

describe("sendAgentMessage (WP-7 — MAX_ITERATIONS + org-scoped sessions)", () => {
  // Same cross-file leak risk as stripe-subscription.test.ts's identical
  // fix — `env`'s properties are mutated directly (not via vi.stubEnv), so
  // they must be explicitly restored or every test file that runs after
  // this one in the same worker inherits these fake values.
  const original = {
    anthropicApiKey: env.anthropicApiKey,
    anthropicAgentId: env.anthropicAgentId,
    anthropicEnvironmentId: env.anthropicEnvironmentId,
  };

  beforeAll(() => {
    (env as unknown as { anthropicApiKey: string }).anthropicApiKey = "sk-ant-test";
    (env as unknown as { anthropicAgentId: string }).anthropicAgentId = "agent_test";
    (env as unknown as { anthropicEnvironmentId: string }).anthropicEnvironmentId = "env_test";
  });

  afterAll(() => {
    (env as unknown as { anthropicApiKey: string }).anthropicApiKey = original.anthropicApiKey;
    (env as unknown as { anthropicAgentId: string }).anthropicAgentId = original.anthropicAgentId;
    (env as unknown as { anthropicEnvironmentId: string }).anthropicEnvironmentId =
      original.anthropicEnvironmentId;
  });

  beforeEach(() => {
    sessionsCreateMock.mockReset();
    eventsStreamMock.mockReset();
    eventsSendMock.mockReset();
    sessionsArchiveMock.mockReset();
    sessionsRetrieveMock.mockReset();
    sessionsCreateMock.mockResolvedValue({ id: `sesn_${Math.random()}` });
    eventsSendMock.mockResolvedValue(undefined);
  });

  it("stops calling the model's requested tools after the soft limit, and still returns a reply", async () => {
    // 10 tool-use events in a row (over the 8-call soft limit) followed by
    // a final text reply and termination.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => toolUseEvent(`call_${i}`)),
      { type: "agent.message", content: [{ type: "text", text: "Here's what I found." }] },
      { type: "session.status_terminated" },
    ];
    eventsStreamMock.mockResolvedValue(fakeStream(events));

    const userId = new Types.ObjectId();
    const orgId = await fundedOrgId();
    const result = await sendAgentMessage(userId, orgId, "do a lot of things");

    expect(result.reply).toBe("Here's what I found.");
    // Calls 1-8 get a normal tool_result send; calls 9-10 get the
    // "limit reached" decline send — both go through events.send, so the
    // call count itself should be 10 (one send per tool-use event, limit
    // or not) plus the original user.message send = 11.
    expect(eventsSendMock).toHaveBeenCalledTimes(11);
    const declineSends = eventsSendMock.mock.calls.filter((call) => {
      const payload = call[1] as { events: Array<{ content?: Array<{ text?: string }> }> };
      return payload.events[0]?.content?.[0]?.text?.includes("Tool call limit reached");
    });
    expect(declineSends).toHaveLength(2); // calls 9 and 10 (over the soft limit of 8)
  });

  it("the hard limit interrupts the session and sends no more tool results, even if the model keeps calling tools", async () => {
    // Far more tool-use events than even the hard limit (12) — a model
    // that never stops — then, once interrupted, the session's final usage
    // and idle events (P1-10: the interrupt actually stops the session, and
    // the drain still counts the tokens it used).
    const events = [
      ...Array.from({ length: 30 }, (_, i) => toolUseEvent(`call_${i}`)),
      {
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 5000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];
    eventsStreamMock.mockResolvedValue(fakeStream(events));

    const userId = new Types.ObjectId();
    const orgId = await fundedOrgId();

    // No text reply is ever produced, so this surfaces as the existing
    // "didn't return a response" error — what matters is that it finishes
    // at all, and how it stopped.
    await expect(sendAgentMessage(userId, orgId, "loop forever")).rejects.toThrow(
      "didn't return a response"
    );

    const sentTypes = eventsSendMock.mock.calls.map(
      (call) => (call[1] as { events: Array<{ type: string }> }).events[0]?.type
    );
    // 1 user.message + 12 tool results (8 normal + 4 "limit reached") + 1 interrupt.
    expect(sentTypes.filter((t) => t === "user.custom_tool_result")).toHaveLength(12);
    expect(sentTypes.filter((t) => t === "user.interrupt")).toHaveLength(1);

    // The drained usage was charged: 10,000 tokens = 10 credits, plus a
    // tiny session-runtime charge that tokensToCredits rounds up to 11.
    const reloaded = await Organization.findById(orgId);
    const charged = 1000 - (reloaded?.creditsBalance ?? 1000);
    expect(charged).toBeGreaterThanOrEqual(10);
    expect(charged).toBeLessThanOrEqual(11);
  });

  it("two different organizations for the same user get two independent session rows", async () => {
    const userId = new Types.ObjectId();
    const orgA = await fundedOrgId();
    const orgB = await fundedOrgId();

    sessionsCreateMock
      .mockResolvedValueOnce({ id: "sesn_org_a" })
      .mockResolvedValueOnce({ id: "sesn_org_b" });
    eventsStreamMock.mockImplementation(() =>
      Promise.resolve(
        fakeStream([
          { type: "agent.message", content: [{ type: "text", text: "ok" }] },
          { type: "session.status_terminated" },
        ])
      )
    );

    await sendAgentMessage(userId, orgA, "hello from org A");
    await sendAgentMessage(userId, orgB, "hello from org B");

    const sessions = await AgentSession.find({ user: userId }).sort({ organization: 1 });
    expect(sessions).toHaveLength(2);
    const sessionIds = sessions.map((s) => s.sessionId).sort();
    expect(sessionIds).toEqual(["sesn_org_a", "sesn_org_b"].sort());
  });

  it("resetAgentSession only clears the one organization's session, not the user's other organizations", async () => {
    const userId = new Types.ObjectId();
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    await AgentSession.create({ user: userId, organization: orgA, sessionId: "sesn_a" });
    await AgentSession.create({ user: userId, organization: orgB, sessionId: "sesn_b" });
    sessionsArchiveMock.mockResolvedValue(undefined);

    await resetAgentSession(userId, orgA);

    const remaining = await AgentSession.find({ user: userId });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.organization.toString()).toBe(orgB.toString());
  });

  /** CLAUDE.md §10.3 — consumeCredits used to be fire-and-forget (`void`,
   *  not awaited) and only ran on a clean loop exit, so a mid-turn
   *  `session.error` meant real, already-spent tokens were never charged
   *  at all. Now wrapped in `try/finally` and awaited. */
  describe("credits are consumed even when the stream errors mid-turn (CLAUDE.md §10.3)", () => {
    it("deducts credits for tokens already used before a session.error throw", async () => {
      const organization = await Organization.create({
        name: "Mid-Turn Error Org",
        creditsBalance: 100,
      });
      const userId = new Types.ObjectId();

      const events = [
        {
          type: "span.model_request_end",
          model_usage: {
            input_tokens: 500,
            output_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        { type: "session.error" },
      ];
      eventsStreamMock.mockResolvedValue(fakeStream(events));

      await expect(sendAgentMessage(userId, organization._id, "trigger a mid-turn failure")).rejects.toThrow();

      const reloaded = await Organization.findById(organization._id);
      // 1000 total tokens = 1 credit at the base rate — the exact amount
      // matters less than the fact that it's no longer 100 (unconsumed).
      expect(reloaded?.creditsBalance).toBeLessThan(100);
    });

    it("factors cache tokens and session duration into what gets consumed, not just input/output", async () => {
      const organization = await Organization.create({
        name: "Cache Tokens Org",
        creditsBalance: 1000,
      });
      const userId = new Types.ObjectId();

      const events = [
        {
          type: "span.model_request_end",
          model_usage: {
            input_tokens: 10,
            output_tokens: 10,
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 0,
          },
        },
        { type: "agent.message", content: [{ type: "text", text: "done" }] },
        { type: "session.status_terminated" },
      ];
      eventsStreamMock.mockResolvedValue(fakeStream(events));

      await sendAgentMessage(userId, organization._id, "use a lot of cache");

      const reloaded = await Organization.findById(organization._id);
      // A plain 20-token turn would cost exactly 1 credit — 50,000 cache
      // write tokens at a 1.25x weight must push this well above that.
      expect(1000 - (reloaded?.creditsBalance ?? 1000)).toBeGreaterThan(1);
    });
  });

  it("runAgentPrompt (background recommendation generation) also awaits credit consumption, including cache tokens", async () => {
    const organization = await Organization.create({
      name: "Background Prompt Org",
      creditsBalance: 1000,
    });
    const userId = new Types.ObjectId();
    sessionsCreateMock.mockResolvedValue({ id: "sesn_bg" });
    sessionsArchiveMock.mockResolvedValue(undefined);

    const events = [
      {
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 40_000,
          cache_read_input_tokens: 0,
        },
      },
      { type: "agent.message", content: [{ type: "text", text: "a recommendation" }] },
      { type: "session.status_terminated" },
    ];
    eventsStreamMock.mockResolvedValue(fakeStream(events));

    const reply = await runAgentPrompt(userId, organization._id, "generate a recommendation");
    expect(reply).toBe("a recommendation");

    const reloaded = await Organization.findById(organization._id);
    // Same property as sendAgentMessage's own cache-token test: a plain
    // 20-token turn costs 1 credit, 40,000 cache-write tokens must push
    // this well above that — proving runAgentPrompt uses the same fixed
    // accounting, not a separate, still-broken path.
    expect(1000 - (reloaded?.creditsBalance ?? 1000)).toBeGreaterThan(1);
    expect(sessionsArchiveMock).toHaveBeenCalledWith("sesn_bg");
  });

  it("resetAllAgentSessionsForUser clears every organization's session for that user", async () => {
    const userId = new Types.ObjectId();
    await AgentSession.create({ user: userId, organization: new Types.ObjectId(), sessionId: "sesn_a" });
    await AgentSession.create({ user: userId, organization: new Types.ObjectId(), sessionId: "sesn_b" });
    sessionsArchiveMock.mockResolvedValue(undefined);

    await resetAllAgentSessionsForUser(userId);

    const remaining = await AgentSession.find({ user: userId });
    expect(remaining).toHaveLength(0);
    expect(sessionsArchiveMock).toHaveBeenCalledTimes(2);
  });
});
