/**
 * Concurrency guard for Billing Advisor Agent turns (CLAUDE.md §10.3 P1-10 /
 * S-10), shared by the web chat and Slack paths:
 *
 *  - One turn at a time per chat session (user + organization). Every turn
 *    for that pair runs on the SAME Managed Agents session, so two at once
 *    would read each other's events off the stream (mixed replies, usage
 *    counted twice). A second one gets 409.
 *  - At most AGENT_MAX_CONCURRENT_PER_WORKSPACE turns per workspace, so one
 *    organization's burst can't run unbounded parallel AI spend. Over the
 *    limit gets 429.
 *
 * ⚠️ SINGLE-INSTANCE ONLY. This state lives in this process's memory: two
 * backend instances would each allow their own quota, and a restart forgets
 * in-flight turns. It's correct today only because exactly one backend runs
 * (the schedulers live inside it). It must move to a shared store (Redis or
 * Mongo) together with STATUS-UPDATE.md task 3 (durable rate limiting) —
 * same store, same migration. Credit reservations (credit-ledger.service.ts)
 * are already DB-atomic and stay correct across instances regardless.
 */
import type { Types } from "mongoose";

import { AppError } from "@/utils/appError";
import { AGENT_MAX_CONCURRENT_PER_WORKSPACE } from "@/config/credits";

const activeSessions = new Set<string>();
const activeByOrganization = new Map<string, number>();

export const AGENT_BUSY_MESSAGE =
  "Still working on your previous question. Please wait for that reply, then try again.";

/** Claims a slot for one agent turn, or throws 409/429. Call the returned
 *  release function exactly once when the turn ends (it's safe to call
 *  again — later calls do nothing). */
export function acquireAgentTurnSlot(
  userId: Types.ObjectId | string,
  organizationId: Types.ObjectId | string
): () => void {
  const orgKey = organizationId.toString();
  const sessionKey = `${userId.toString()}:${orgKey}`;

  if (activeSessions.has(sessionKey)) {
    throw new AppError(AGENT_BUSY_MESSAGE, 409);
  }
  const running = activeByOrganization.get(orgKey) ?? 0;
  if (running >= AGENT_MAX_CONCURRENT_PER_WORKSPACE) {
    throw new AppError(
      "Your workspace already has several AI requests running. Please try again in a moment.",
      429
    );
  }

  activeSessions.add(sessionKey);
  activeByOrganization.set(orgKey, running + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSessions.delete(sessionKey);
    const remaining = (activeByOrganization.get(orgKey) ?? 1) - 1;
    if (remaining > 0) activeByOrganization.set(orgKey, remaining);
    else activeByOrganization.delete(orgKey);
  };
}
