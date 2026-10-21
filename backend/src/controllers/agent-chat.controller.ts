/**
 * Agent chat controller — talks to the Claude Managed Agents "Billing Advisor
 * Agent" (Console-created, see AgentSession/managed-agent.service). Separate
 * from the plain /api/ai/chat endpoint: this one keeps conversation state in
 * the Managed Agents session itself, one session per user.
 */
import { asyncHandler } from "@/utils/asyncHandler";
import { AppError } from "@/utils/appError";
import { sendSuccess } from "@/utils/apiResponse";
import {
  sendAgentMessage,
  resetAgentSession,
} from "@/services/agent/managed-agent.service";
import { tryRouteDeterministically } from "@/services/ai/intent-router.service";
import type { AgentChatInput } from "@/validators/agent-chat.validator";

/** POST /api/agent/chat */
export const agentChat = asyncHandler(async (req, res) => {
  const user = req.user;
  const organization = req.organization;
  if (!user || !organization) {
    throw new AppError("Authentication required", 401);
  }

  const { message } = req.body as AgentChatInput;

  // WP-7 intent router (flow/04 §8) — tried BEFORE the credit reservation, on
  // purpose: a deterministic answer costs nothing and must still work for a
  // workspace that's genuinely out of AI credits. Falls through to the real
  // agent turn below (unchanged) on anything not confidently matched.
  const routed = await tryRouteDeterministically(organization._id.toString(), message);
  if (routed) {
    sendSuccess(res, 200, "Agent response generated", {
      message: { role: "assistant", content: routed.reply },
    });
    return;
  }

  // Credits are reserved inside sendAgentMessage (403 when out, 409 if this
  // chat already has a reply in progress, 429 over the workspace's
  // concurrency cap) — no separate pre-check needed here.
  const { reply, action } = await sendAgentMessage(user._id, organization._id, message);

  sendSuccess(res, 200, "Agent response generated", {
    message: { role: "assistant", content: reply, ...(action ? { action } : {}) },
  });
});

/** DELETE /api/agent/chat — ends the current conversation ("New Chat") for
 *  the currently active organization only (WP-7 — each organization has
 *  its own session; see agent-session.model.ts). */
export const resetAgentChat = asyncHandler(async (req, res) => {
  const user = req.user;
  const organization = req.organization;
  if (!user || !organization) {
    throw new AppError("Authentication required", 401);
  }

  await resetAgentSession(user._id, organization._id);
  sendSuccess(res, 200, "Conversation reset", null);
});
