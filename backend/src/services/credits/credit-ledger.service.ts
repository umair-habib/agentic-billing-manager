/**
 * Credit ledger — the only place that mutates `Organization.creditsBalance`.
 * Every change writes a matching `CreditTransaction` so the balance is
 * always explainable, not just a bare number. Both directions use an atomic
 * `$inc` (never read-then-write) so concurrent turns for the same workspace
 * can't race each other into a wrong balance.
 *
 * Credits are scoped to the ORGANIZATION (whoever's plan is actually paying
 * for it), not the individual member whose action triggered the cost — an
 * optional `userId` is still recorded on the ledger entry purely as an audit
 * trail of which member did it, never as what the balance is tracked against.
 */
import type { Types } from "mongoose";

import { Organization } from "@/models/organization.model";
import { CreditReservation } from "@/models/credit-reservation.model";
import {
  CreditTransaction,
  type CreditTransactionType,
} from "@/models/credit-transaction.model";

async function applyDelta(
  organizationId: Types.ObjectId | string,
  type: CreditTransactionType,
  delta: number,
  reason: string,
  userId?: Types.ObjectId | string
): Promise<number | null> {
  const updated = await Organization.findByIdAndUpdate(
    organizationId,
    { $inc: { creditsBalance: delta } },
    { new: true }
  );
  if (!updated) return null;

  await CreditTransaction.create({
    organization: organizationId,
    user: userId,
    type,
    amount: delta,
    balanceAfter: updated.creditsBalance,
    reason,
  });
  return updated.creditsBalance;
}

/** Adds credits (signup grant, purchase, refund, manual top-up) to a workspace. */
export async function grantCredits(
  organizationId: Types.ObjectId | string,
  amount: number,
  reason: string,
  type: "grant" | "purchase" | "refund" = "grant",
  userId?: Types.ObjectId | string
): Promise<number | null> {
  return applyDelta(organizationId, type, Math.abs(amount), reason, userId);
}

/**
 * Deducts credits for actual usage (e.g. one Billing Advisor Agent turn) from
 * the workspace the acting member was in AT THE TIME. Best-effort: never
 * throws — a ledger-write failure must not break the response the user
 * already received. The balance can end up slightly below zero (the cost
 * already happened); the NEXT turn is what gets blocked, via
 * `assertCreditBalance` (see utils/credits.ts), not this call.
 */
export async function consumeCredits(
  organizationId: Types.ObjectId | string,
  amount: number,
  reason: string,
  userId?: Types.ObjectId | string
): Promise<void> {
  try {
    await applyDelta(organizationId, "consume", -Math.abs(amount), reason, userId);
  } catch {
    // Best-effort — see docstring.
  }
}

export interface CreditReservationHandle {
  reservationId: string;
  reserved: number;
}

/** Bounded retries for the compare-and-set below — only contended when
 *  several turns for the same workspace reserve in the same instant. */
const RESERVE_MAX_ATTEMPTS = 5;

/**
 * CLAUDE.md §10.3 P1-10 / S-10 — atomically takes `min(maxCredits, balance)`
 * credits from a workspace BEFORE an AI call, so N concurrent turns can't
 * all pass a "balance > 0" check and then each overspend. Returns null when
 * the workspace has less than 1 credit (nothing reserved, nothing written).
 *
 * Compare-and-set on the exact balance read, rather than an update pipeline:
 * the decrement only lands if nobody else changed the balance in between,
 * otherwise it re-reads and retries. Goes through the normal ledger (a
 * "consume" row), so sum(CreditTransaction) === creditsBalance still holds
 * at every moment (credit-reconciliation-scheduler.ts), and a crash mid-turn
 * leaves the customer charged the reservation only — never a stuck balance.
 */
export async function reserveCredits(
  organizationId: Types.ObjectId | string,
  maxCredits: number,
  reason: string,
  userId?: Types.ObjectId | string
): Promise<CreditReservationHandle | null> {
  for (let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt++) {
    const current = await Organization.findById(organizationId).select("creditsBalance");
    if (!current || current.creditsBalance < 1) return null;

    const reserved = Math.min(Math.abs(maxCredits), current.creditsBalance);
    const updated = await Organization.findOneAndUpdate(
      { _id: organizationId, creditsBalance: current.creditsBalance },
      { $inc: { creditsBalance: -reserved } },
      { new: true }
    );
    if (!updated) continue; // balance moved under us — re-read and retry

    const reservation = await CreditReservation.create({
      organization: organizationId,
      user: userId,
      reason,
      reserved,
    });
    await CreditTransaction.create({
      organization: organizationId,
      user: userId,
      type: "consume",
      amount: -reserved,
      balanceAfter: updated.creditsBalance,
      reason: `${reason} (reserved ${reservation._id.toString()})`,
    });
    // Crash-safety trail: an "open" reservation whose turn never settled
    // can be found from this line (or from CreditReservation itself).
    console.info(
      `[credits] reservation ${reservation._id.toString()} opened: org ${organizationId.toString()}, ${reserved} credits, ${reason}`
    );
    return { reservationId: reservation._id.toString(), reserved };
  }
  return null;
}

/**
 * Settles a reservation to the turn's real cost: refunds the unused part, or
 * charges the overage if the turn cost more than was reserved. Idempotent —
 * the "open" → "settled" flip is one atomic conditional update, so a second
 * call (a retry, a duplicate `finally`) finds nothing open and changes
 * nothing. Best-effort like `consumeCredits`: never throws.
 */
export async function settleReservation(
  reservationId: string,
  actualCredits: number
): Promise<void> {
  try {
    const actual = Math.max(0, actualCredits);
    const reservation = await CreditReservation.findOneAndUpdate(
      { _id: reservationId, status: "open" },
      { $set: { status: "settled", actual, settledAt: new Date() } },
      { new: true }
    );
    if (!reservation) return; // already settled (or unknown) — nothing to do

    const difference = reservation.reserved - actual;
    if (difference === 0) return;
    await applyDelta(
      reservation.organization,
      difference > 0 ? "refund" : "consume",
      difference,
      `${reservation.reason} (settled ${reservationId}: actual ${actual})`,
      reservation.user
    );
  } catch (error) {
    console.error(
      `[credits] settling reservation ${reservationId} failed:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Sets a workspace's balance to its plan's credit allowance for a fresh
 * cycle (see services/credits/credit-reset-scheduler.ts — cycle length
 * varies by plan tier, e.g. monthly for Free, yearly for Pro/Business) — a
 * hard reset, not a top-up: unused credits don't roll over, and a balance
 * left negative from the prior cycle is brought back to the fresh allowance
 * rather than staying negative forever. Uses a single atomic `$set` (not
 * `$inc`) so it can't race a concurrent `consumeCredits` call into an
 * inconsistent balance; the ledger entry's `amount` is derived from the
 * balance just before the set, read off the same atomic operation.
 * Best-effort, like `consumeCredits` — a missed reset is caught by the next
 * scheduled run. No single member triggers this, so no `userId` is recorded.
 */
export async function resetCreditsForNewCycle(
  organizationId: Types.ObjectId | string,
  targetBalance: number,
  reason: string
): Promise<void> {
  try {
    const previous = await Organization.findByIdAndUpdate(organizationId, {
      $set: { creditsBalance: targetBalance, lastCreditResetAt: new Date() },
    });
    if (!previous) return;

    await CreditTransaction.create({
      organization: organizationId,
      type: "reset",
      amount: targetBalance - previous.creditsBalance,
      balanceAfter: targetBalance,
      reason,
    });
  } catch {
    // Best-effort — see docstring.
  }
}
