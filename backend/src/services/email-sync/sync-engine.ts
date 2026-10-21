/**
 * Email-sync engine — scans ONE connected inbox (Gmail or Outlook) for
 * invoice-like messages and upserts parsed fields into the Billing
 * collection with `source: "email_sync"`. A fallback channel behind
 * services/billing-sync: only runs for platforms with no billing-sync
 * adapter coverage (see registry.ts). Idempotent and best-effort, mirroring
 * services/billing-sync/sync-engine.ts's safety guarantees — never throws,
 * one bad message never aborts the run.
 *
 * Provider-agnostic: everything specific to Gmail vs Outlook (search-query
 * syntax, raw API shape, message normalization) lives behind provider.ts's
 * EmailSyncProvider; this file only knows the loop (pagination, safety cap,
 * watermark, dedupe/upsert) plus the AI extraction step every candidate
 * message goes through.
 *
 * Called from two places: right after an email-sync connection is created
 * (one immediate pull) and by the recurring scheduler (scheduler.ts).
 */
import type { Types } from "mongoose";

import { Billing } from "@/models/billing.model";
import { Organization } from "@/models/organization.model";
import {
  ProcessedMessage,
  PROCESSED_MESSAGE_TTL_DAYS,
} from "@/models/processed-message.model";
import {
  PlatformConnection,
  type PlatformConnectionDocument,
} from "@/models/platform-connection.model";
import { emitBusinessDataChanged } from "@/services/events/event-bus";
import {
  getEmailSyncProvider,
  type EmailSyncProvider,
  type NormalizedEmailMessage,
} from "@/services/email-sync/provider";
import {
  parseSender,
  hasReplyToMismatch,
  applySenderTrustPenalty,
} from "@/services/email-sync/parser";
import {
  extractInvoiceFields,
  isAiExtractionConfigured,
  MODEL as EXTRACTION_MODEL,
} from "@/services/email-sync/ai-invoice-extractor";
import { consumeCredits } from "@/services/credits/credit-ledger.service";
import { resolveVendor } from "@/services/vendors/vendor-resolver.service";
import { recordBillingEvent } from "@/services/billing/billing-event-recorder.service";
import { isSenderSuppressed, isSenderTrusted } from "@/services/email-sync/sender-trust.service";
import { mapDerivedStatusToBillingStatus } from "@/services/billing/status-machine";
import type { BillingEventType } from "@/models/billing-event.model";
import type { BillingStatus } from "@/models/billing.model";
import { tokensToCredits } from "@/config/credits";
import {
  upsertNotification,
  getNotificationPrefs,
} from "@/services/notification/notification-engine";
import { sendSlackAlert, resolveSlackWebhookUrl } from "@/services/notifications/slack";

const MAX_MESSAGES_PER_RUN = 200;
const PAGE_SIZE = 50;
const OVERLAP_DAYS = 1;
/** Task 8 — a BillingEvent's `confidence` is required, but the AI
 *  extractor's own `confidence` field can legitimately be null (the model
 *  simply didn't return one). A moderate default rather than a fake 1.0 or
 *  0 — treated as "unknown, assume reasonably reliable" by the state
 *  machine, not as strong evidence either way. */
const DEFAULT_EVENT_CONFIDENCE = 0.7;
/** How far back a Paid/Overdue confirmation (no real invoice number) may
 *  reach to resolve an existing open invoice's status, instead of creating a
 *  new row — generous enough for common NET-30-with-grace terms, bounded so
 *  it can never reopen/misattribute a much older, unrelated billing cycle. */
const OPEN_INVOICE_MATCH_WINDOW_MS = 45 * 86_400_000;

/** Escapes regex metacharacters so a value can be safely used inside a
 *  `$regex` filter (a fallback externalId's amount segment can contain a
 *  literal "." — regex-special — from a decimal amount). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Records that a message was actually checked, so no future run — however
 *  many times this message reappears inside the rolling search window —
 *  ever pays for the AI extractor to look at it again. Upsert, not insert:
 *  a genuinely new-and-unique dedupe key per (connection, messageId) means
 *  this can only ever be called once per real message per outcome, but
 *  upserting keeps it safe against an unexpected re-run of the same commit. */
async function markMessageProcessed(
  connectionId: Types.ObjectId,
  messageId: string,
  outcome: "invoice" | "not_billing" | "suppressed_sender"
): Promise<void> {
  const now = new Date();
  await ProcessedMessage.updateOne(
    { connection: connectionId, messageId },
    {
      $set: {
        outcome,
        processedAt: now,
        expiresAt: new Date(now.getTime() + PROCESSED_MESSAGE_TTL_DAYS * 86_400_000),
      },
    },
    { upsert: true }
  ).catch(() => {
    // Best-effort — if this write fails, the worst case is the message gets
    // re-checked on a future run (paying for it again), never that a real
    // invoice silently gets skipped. Never let this abort the sync itself.
  });
}

interface EmailSyncState {
  lastSyncedAt?: string;
}
interface AccountMetadata {
  pipedreamAccountId?: string;
  emailSync?: EmailSyncState;
}

/** Alerts the connection's owner once when a sync is skipped purely because
 *  the workspace is out of credits — otherwise this has no visible symptom
 *  besides invoices quietly never showing up. Respects the same notification
 *  preferences (master switch) as every other alert in the app. */
async function notifyEmailSyncPaused(
  connection: PlatformConnectionDocument,
  organizationIncomingWebhookUrl: string | undefined
): Promise<void> {
  const prefs = await getNotificationPrefs(connection.user.toString());
  if (!prefs.enabled) return;

  const { created } = await upsertNotification(connection.organization.toString(), {
    signature: "system:email-sync-paused-no-credits",
    category: "system",
    severity: "warning",
    title: "Email sync paused — out of credits",
    message:
      "Your workspace has run out of credits, so scanning your inbox for new invoices has paused. Add credits to resume.",
  });

  // flow/extra-01 — the organization's own auto-captured webhook (from
  // "Add to Slack") takes priority over the older per-user manually-pasted
  // one.
  const webhookUrl = resolveSlackWebhookUrl(organizationIncomingWebhookUrl, prefs.slackWebhookUrl);
  if (created && webhookUrl) {
    await sendSlackAlert(
      webhookUrl,
      ":warning: *Email sync paused* — your workspace is out of credits, so invoice scanning has stopped until you add more."
    ).catch(() => {
      // Best-effort — the in-app notification above is the source of truth.
    });
  }
}

// In-process guard against two overlapping runs for the SAME connection —
// this can genuinely happen: the scheduler's `setInterval` fires every hour
// regardless of whether the previous pass finished (a large backlog can take
// longer than that), and the "sync once on connect" trigger could also land
// mid-pass. Two concurrent runs each read the organization's credits balance
// independently and wouldn't see each other's deductions, so the balance
// could go further negative than either run's own safety check intended.
// Process-local only (fine for this app's current single-instance
// deployment) — would need a real distributed lock if ever run on more than
// one server.
const connectionsInProgress = new Set<string>();

export async function syncConnectionEmail(
  connection: PlatformConnectionDocument
): Promise<void> {
  const connectionId = connection._id.toString();
  if (connectionsInProgress.has(connectionId)) return;
  connectionsInProgress.add(connectionId);
  try {
    await syncConnectionEmailInner(connection);
  } finally {
    connectionsInProgress.delete(connectionId);
  }
}

async function syncConnectionEmailInner(
  connection: PlatformConnectionDocument
): Promise<void> {
  const provider = getEmailSyncProvider(connection.platform);
  if (!provider) return;
  if (!isAiExtractionConfigured()) return;

  const meta = connection.metadata as AccountMetadata | undefined;
  const pipedreamAccountId = meta?.pipedreamAccountId;
  if (!pipedreamAccountId) return;

  // Reading each candidate email through the AI extractor costs the
  // workspace credits, exactly like a Billing Advisor Agent turn — so this
  // run never starts if it's already out (the next Agent message in this
  // workspace would be blocked the same way; the next successful sync just
  // resumes once it has credits again).
  const organization = await Organization.findById(connection.organization).select(
    "creditsBalance name slackWorkspace.incomingWebhookUrl"
  );
  if (!organization || organization.creditsBalance <= 0) {
    // Otherwise this fails completely silently — no error, no toast, nothing
    // in the UI — since a scheduled sync has no request/response to surface
    // one through. `upsertNotification` dedupes by (organization, signature),
    // so this only alerts once per organization until it's resolved (the
    // signature is reused, so it just refreshes quietly on every subsequent
    // paused run instead of re-notifying).
    if (organization) {
      void notifyEmailSyncPaused(connection, organization.slackWorkspace?.incomingWebhookUrl).catch(() => {
        // Best-effort — a failed alert must never break/retry the sync itself.
      });
    }
    return;
  }

  const externalUserId = connection.user.toString();
  const runStartedAt = new Date();
  const sinceDate = meta?.emailSync?.lastSyncedAt
    ? new Date(
        new Date(meta.emailSync.lastSyncedAt).getTime() - OVERLAP_DAYS * 86_400_000
      )
    : null;
  const query = provider.buildSearchQuery(sinceDate, connection.trackedSenders ?? []);

  let processed = 0;
  let created = 0;
  let hitCap = false;
  let outOfCredits = false;
  // Every candidate id the provider listed this run, across all pages —
  // compared against `provider.maxSearchResults` to detect a truncated search.
  let listedCount = 0;
  // Counts messages that couldn't actually be checked (a real API/network
  // failure from the AI extractor, or an unexpected bug) — as opposed to a
  // message that WAS successfully checked and simply wasn't a bill. If
  // EVERY attempted message fails this way (e.g. an expired Anthropic key,
  // or Anthropic itself down), the run must not be allowed to advance the
  // watermark: that would silently mark a whole backlog "checked" when
  // nothing in it actually was, permanently hiding real invoices from every
  // future sync. A single isolated bad message among many successes is not
  // treated as systemic — it's skipped, same as before.
  let extractionErrors = 0;
  // Tracked locally (not re-read from the DB) so a run stops the moment its
  // OWN deductions exhaust the balance, instead of only being caught by the
  // next run's pre-check after already processing an entire backlog page.
  let remainingCredits = organization.creditsBalance;
  let pageToken: string | undefined;
  // Extraction happens in whatever order the provider's search returns
  // messages — NOT guaranteed to be chronological (Gmail explicitly isn't).
  // Writing to Billing immediately would let an older message (e.g. the
  // original "your invoice" email) overwrite a newer one (e.g. "payment
  // received") for the same invoice if it happens to be processed second.
  // So every extraction is staged here and only committed after this whole
  // fetch pass, sorted oldest-to-newest, so the chronologically last email
  // for a given invoice always wins the final DB write.
  const pendingUpdates: Array<{
    dedupeQuery: Record<string, unknown>;
    setFields: Record<string, unknown>;
    receivedAt: Date;
    openInvoiceLookup: { externalIdPrefix: string } | null;
    messageId: string;
  }> = [];

  try {
    do {
      const page = await provider.listCandidateMessageIds(
        externalUserId,
        pipedreamAccountId,
        query,
        PAGE_SIZE,
        pageToken
      );
      listedCount += page.messageIds.length;
      for (const messageId of page.messageIds) {
        // Providers that can't filter by date server-side (Outlook): skip a
        // candidate received before the window, judged on its OWN received
        // time — never "stop at the first old one", since results aren't in
        // received-time order (P1-06). Skipped before any fetch, so it costs
        // nothing and doesn't count toward MAX_MESSAGES_PER_RUN.
        const listedReceivedAt = page.receivedAtById?.[messageId];
        if (
          provider.filtersSinceDateClientSide &&
          sinceDate &&
          listedReceivedAt &&
          listedReceivedAt.getTime() < sinceDate.getTime()
        ) {
          continue;
        }

        // The actual fix for the re-extraction loop: a message already
        // recorded here — from THIS run's own earlier page, or any previous
        // run, however many times it keeps reappearing inside the rolling
        // OVERLAP_DAYS search window — is skipped before it can cost
        // anything. Deliberately checked BEFORE the cap/credits gates below,
        // so a run doesn't burn its 200-message budget re-confirming old
        // ground; it reaches genuinely new candidates instead, which is what
        // lets backfill make real progress across runs (GM-004) instead of
        // re-fetching the identical first page forever.
        const alreadyProcessed = await ProcessedMessage.exists({
          connection: connection._id,
          messageId,
        });
        if (alreadyProcessed) continue;

        if (processed >= MAX_MESSAGES_PER_RUN) {
          hitCap = true;
          break;
        }
        if (remainingCredits <= 0) {
          outOfCredits = true;
          break;
        }
        processed++;
        try {
          const message = await provider.getMessage(
            externalUserId,
            pipedreamAccountId,
            messageId
          );
          if (!message) continue;

          // Fallback for a candidate the list call gave no received time for:
          // same per-message check, now on the fetched message — skip this
          // one only, keep going (never a run-ending break, see above).
          if (
            provider.filtersSinceDateClientSide &&
            sinceDate &&
            message.receivedAt.getTime() < sinceDate.getTime()
          ) {
            continue;
          }

          const extracted = await extractCandidateFields(
            connection,
            provider,
            message,
            organization.name
          );
          remainingCredits -= extracted.creditsUsed;
          if (extracted.fields) {
            pendingUpdates.push({
              dedupeQuery: extracted.fields.dedupeQuery,
              setFields: extracted.fields.setFields,
              receivedAt: message.receivedAt,
              openInvoiceLookup: extracted.fields.openInvoiceLookup,
              messageId,
            });
          } else {
            // Genuinely checked and confirmed not a billing email (or,
            // WP-11, skipped entirely because the sender is suppressed —
            // either way, no later commit step depends on this one, unlike
            // the "invoice" case below, which is only marked once its
            // Billing write actually lands).
            await markMessageProcessed(
              connection._id,
              messageId,
              extracted.suppressed ? "suppressed_sender" : "not_billing"
            );
          }
        } catch {
          // One bad/unreachable message must never abort the whole run —
          // but it DOES mean this message was never actually checked, so
          // it counts toward `extractionErrors` (see that variable's
          // docstring) for the watermark decision below.
          extractionErrors++;
        }
      }
      pageToken = hitCap || outOfCredits ? undefined : page.nextPageToken;
    } while (pageToken);

    // Commit oldest-first: within one run, a later email for the same
    // invoice (e.g. a payment confirmation) is written last and wins.
    pendingUpdates.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    for (const update of pendingUpdates) {
      let dedupeQuery = update.dedupeQuery;

      // No real invoice number, and this email reports an outcome (Paid/
      // Overdue) rather than a fresh bill: a real incident showed the plain
      // day-keyed fallback only merges same-day emails about one bill — a
      // "payment received" arriving days after its own invoice, with no
      // shared date reference between the two, hashed to a DIFFERENT day key
      // and created a second row instead of resolving the first one's
      // status. Before falling back to a brand-new row, look for the most
      // recent still-open (non-Paid) record for this same vendor+amount and
      // resolve onto it instead — but only within a bounded window, so this
      // never reaches back and reopens/misattributes an old, unrelated cycle.
      if (update.openInvoiceLookup) {
        const openMatch = await Billing.findOne({
          organization: connection.organization,
          platformConnection: connection._id,
          externalId: {
            $regex: `^${escapeRegExp(update.openInvoiceLookup.externalIdPrefix)}`,
          },
          status: { $ne: "Paid" },
        })
          .sort({ billingDate: -1 })
          .select("externalId billingDate");

        if (
          openMatch &&
          Math.abs(openMatch.billingDate.getTime() - update.receivedAt.getTime()) <=
            OPEN_INVOICE_MATCH_WINDOW_MS
        ) {
          dedupeQuery = { ...dedupeQuery, externalId: openMatch.externalId };
        }
      }

      const existing = await Billing.findOne(dedupeQuery).select("manuallyEditedAt amount");

      // A human corrected this exact record (e.g. via the Billing page or
      // the Billing Advisor Agent's confirm button) more recently than this
      // email was even sent — re-reading that same old email must never
      // silently revert their correction back to whatever it said before.
      // A genuinely NEWER email (received after the correction) still wins,
      // since that reflects real new information.
      if (existing?.manuallyEditedAt && existing.manuallyEditedAt > update.receivedAt) {
        continue;
      }

      const savedBilling = await Billing.findOneAndUpdate(
        dedupeQuery,
        { $set: update.setFields },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      );
      if (!existing) created++;

      // Task 8, cut over (narrow scope — see status-machine.ts's
      // mapDerivedStatusToBillingStatus docstring for why this stays a
      // 3-value mapping, not the full target vocabulary) — append the
      // evidence this write represents, re-derive status from the record's
      // WHOLE history, then overwrite the naive `status` just written above
      // (which only looked at THIS email) with the history-aware value.
      if (savedBilling) {
        const setFields = update.setFields as {
          status?: BillingStatus;
          amount?: number;
          extractionConfidence?: number;
          sourceMessageId?: string;
        };
        const status = setFields.status ?? "Pending";
        const confidence = setFields.extractionConfidence ?? DEFAULT_EVENT_CONFIDENCE;
        // Awaited (not fire-and-forget) and sequenced deliberately: each
        // call's own internal recompute reads the FULL event history at
        // that moment, so the amount_changed call (when it happens) must
        // run strictly after the status event's own insert has landed, or
        // its recompute could read a stale history and leave a stored
        // derivedStatus one event behind. `latestDerived` tracks the most
        // recent recompute so the status overwrite below reflects whichever
        // event was recorded last.
        let latestDerived = await recordBillingEvent({
          organization: connection.organization,
          billing: savedBilling._id,
          type: eventTypeForStatus(status, !existing),
          occurredAt: update.receivedAt,
          confidence,
          source: "email_sync",
          sourceMessageId: setFields.sourceMessageId,
        }).catch(() => null);
        if (
          existing &&
          typeof setFields.amount === "number" &&
          setFields.amount !== existing.amount
        ) {
          latestDerived = await recordBillingEvent({
            organization: connection.organization,
            billing: savedBilling._id,
            type: "amount_changed",
            occurredAt: update.receivedAt,
            confidence,
            source: "email_sync",
            amount: setFields.amount,
            sourceMessageId: setFields.sourceMessageId,
          }).catch(() => latestDerived);
        }

        // The actual bug fix (GM-027): a stale reminder, synced in a later
        // run than a genuine payment confirmation, used to overwrite
        // `status` straight back to "Pending" because the write above only
        // ever looks at the single email it just read. `deriveStatus()`
        // reads the record's ENTIRE event history instead, so a reminder
        // arriving after a `payment_confirmed` leaves the governing status
        // at "paid" — this overwrite is what makes that actually take
        // effect on the real `status` field, not just the comparison-only
        // `derivedStatus*` fields. Best-effort: if derivation failed, the
        // naive value already written above is kept rather than guessed.
        if (latestDerived) {
          const mappedStatus = mapDerivedStatusToBillingStatus(latestDerived.status);
          if (mappedStatus !== status) {
            await Billing.updateOne(
              { _id: savedBilling._id },
              { $set: { status: mappedStatus } }
            ).catch(() => {
              // Best-effort — see above.
            });
          }
        }
      }

      // Marked here, only once the Billing write actually lands — not when
      // the extraction was first staged above. If the process dies between
      // staging and this commit loop, this message has NO processed record,
      // so it's correctly re-attempted on the next run instead of being
      // permanently treated as "done" with no Billing row to show for it.
      await markMessageProcessed(connection._id, update.messageId, "invoice");
    }

    // Only advance the watermark when the search window was fully drained —
    // if the safety cap was hit, credits ran out mid-run, or every attempted
    // message failed to actually get checked (a systemic AI-extractor
    // failure, not a real "not a bill" verdict), leave it unchanged so the
    // next run resumes the same backlog instead of silently skipping
    // whatever didn't get through. A search truncated at the provider's own
    // result cap (Outlook `$search`: 1,000) is likewise NOT fully drained —
    // anything past that position was never listed — so it holds the
    // watermark too, same reasoning as `hitCap` below.
    //
    // `hitCap` deliberately still blocks the advance even now that
    // ProcessedMessage exists. Advancing it to "now" after a capped run
    // would narrow every future search window forward past whatever's still
    // unprocessed beyond message #200 — those messages would never be
    // searched for again and would be lost, not just delayed. Leaving the
    // watermark where it is means the *same* search window gets reissued on
    // the next run — but now the already-handled prefix is skipped almost
    // instantly via ProcessedMessage instead of being re-billed, so each run
    // reaches genuinely new candidates within its own 200-message budget.
    // That is what actually makes GM-004's "run 1: first 200, run 2: the
    // next 200, run 3: the final 100" backfill-completion behavior work.
    const allAttemptsFailed = processed > 0 && extractionErrors === processed;
    const searchCapReached =
      provider.maxSearchResults !== undefined && listedCount >= provider.maxSearchResults;
    if (searchCapReached) {
      console.warn(
        `[email-sync] connection ${connection._id.toString()} (${connection.platform}): search returned ${listedCount} results, the provider's cap of ${provider.maxSearchResults} — older matches beyond it may be missed; watermark not advanced.`
      );
    }
    if (!hitCap && !outOfCredits && !allAttemptsFailed && !searchCapReached) {
      await PlatformConnection.updateOne(
        { _id: connection._id },
        { $set: { "metadata.emailSync": { lastSyncedAt: runStartedAt.toISOString() } } }
      );
    }

    if (created > 0) {
      emitBusinessDataChanged({
        source: "billing",
        action: "create",
        triggeredBy: externalUserId,
      });
    }

    // Sync observability (S-17 fix) — records that a run actually happened
    // and what it did, separate from lastVerifiedAt/lastError (the
    // CREDENTIAL's own health). Written on every completed pass, whether or
    // not it fully drained the window (hitCap/outOfCredits are normal
    // operational states, not failures) — `lastSyncStatus: "error"` is
    // reserved for the catch block below, a genuine crash.
    await PlatformConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          messagesScanned: processed,
          invoicesFound: created,
        },
        $unset: { lastSyncError: "" },
      }
    ).catch(() => {
      // Best-effort — never let an observability write fail the sync itself.
    });
  } catch (error) {
    // Previously a bare `catch {}` — a provider outage, an expired token, or
    // an unexpected bug all produced literally no signal anywhere (S-17):
    // no log, no `lastSyncError`, no way to tell a broken integration from
    // an empty inbox. Still best-effort (a hiccup on one connection must
    // never affect others), but now actually visible to both the operator
    // (console) and the customer (`lastSyncError`, rendered in the UI).
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[email-sync] connection ${connection._id.toString()} (${connection.platform}) failed:`,
      message
    );
    await PlatformConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: "error",
          // A fixed, safe message — never the raw exception text, which
          // could in principle echo a URL/token fragment from a provider
          // error. The real message is already logged above for debugging.
          lastSyncError: "The last sync attempt failed. It will retry automatically.",
        },
      }
    ).catch(() => {
      // Best-effort — never let an observability write fail the sync itself.
    });
  }
}

/** Parses an AI-returned `YYYY-MM-DD` string; null/invalid → undefined
 *  (never a guessed date, since a wrong due/billing date is worse than none). */
function parseAiDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
}

/** Placeholder strings the AI has been observed to return in place of a real
 *  value — technically non-empty/truthy, but carry no real information. */
const MEANINGLESS_VALUES = new Set([
  "unknown",
  "<unknown>",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "-",
  "tbd",
]);

/** Rejects a meaningless placeholder the same way a genuinely missing value
 *  would be rejected. Hit a real bug from skipping this: the AI sometimes
 *  returns the literal string "<UNKNOWN>" for `invoiceNumber` — a normal
 *  truthy-string check treated that as a real invoice number, so it took
 *  the "dedupe by real invoice number" branch instead of falling back to
 *  the day-based one, silently merging every email that got this same
 *  placeholder (regardless of actual vendor or date) into ONE Billing row. */
function meaningfulString(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || MEANINGLESS_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** Maps an AI-observed status onto the richer BillingEvent vocabulary
 *  (Task 8). The AI extractor's schema has no way to distinguish an
 *  ORIGINAL invoice from a follow-up reminder — both come back as
 *  "Pending" — so this uses the one signal sync-engine.ts already has for
 *  free: whether a Billing record for this externalId existed before this
 *  write. The first-ever "Pending" observation for a record is its
 *  issuance; every later one is a reminder. */
function eventTypeForStatus(status: BillingStatus, isNewRecord: boolean): BillingEventType {
  switch (status) {
    case "Paid":
      return "payment_confirmed";
    case "Overdue":
      return "payment_failed";
    case "Pending":
    default:
      return isNewRecord ? "invoice_issued" : "reminder";
  }
}

const EVIDENCE_SNIPPET_MAX_CHARS = 300;
/** WP-11 — the minimum confidence a trusted sender's extraction is raised
 *  to (never lowered by this — see where it's applied). Below the
 *  extractor's own typical "confident" range, deliberately: trust narrows
 *  the range of plausible doubt, it doesn't manufacture certainty the
 *  model itself never reported. */
const TRUSTED_SENDER_CONFIDENCE_FLOOR = 0.75;

/** Bounded, sanitized excerpt of the source email's own text, stored as the
 *  record's `evidence` — deliberately derived here in code from the raw
 *  body, never asked of the AI model. Letting the model "quote" the email
 *  back would just reproduce whatever attacker-controlled text it contains
 *  into a NEW persisted field, one the agent later reads as context — a
 *  second injection surface for no real benefit, since a plain, deterministic
 *  prefix already answers "what did this record actually come from" just as
 *  well as an AI-picked quote would. */
function buildEvidenceSnippet(bodyText: string): string | null {
  const cleaned = bodyText
    // Strip control/non-printable characters (keep normal whitespace) before
    // collapsing it — this is stored text an operator or the agent will
    // read, not raw email bytes.
    // eslint-disable-next-line no-control-regex -- deliberately matching control chars to strip them
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > EVIDENCE_SNIPPET_MAX_CHARS
    ? `${cleaned.slice(0, EVIDENCE_SNIPPET_MAX_CHARS - 3)}...`
    : cleaned;
}

/** Extracts one candidate message's billing fields and prices the AI call
 *  against the workspace's credits, but does NOT touch the Billing
 *  collection — the caller commits the write, in chronological order across
 *  the whole run (see the `pendingUpdates` sort in `syncConnectionEmail`),
 *  so a later status (e.g. a payment confirmation) is never clobbered by an
 *  earlier one processed out of order. */
async function extractCandidateFields(
  connection: PlatformConnectionDocument,
  provider: EmailSyncProvider,
  message: NormalizedEmailMessage,
  organizationName: string
): Promise<{
  fields: {
    dedupeQuery: Record<string, unknown>;
    setFields: Record<string, unknown>;
    openInvoiceLookup: { externalIdPrefix: string } | null;
  } | null;
  creditsUsed: number;
  /** WP-11 — true when this message was skipped BEFORE the AI ever looked
   *  at it, because its sender is suppressed. Lets the caller mark it with
   *  a distinct outcome from "the AI looked and said no". */
  suppressed?: boolean;
}> {
  // WP-11 learning loop — checked BEFORE spending any credits. A sender
  // the workspace has already taught this pipeline to distrust (3+ deleted
  // false positives, 0 confirmed) is skipped entirely, not just downgraded
  // in confidence.
  const senderDomainForTrustCheck = parseSender(message.fromHeader ?? undefined).domain;
  if (senderDomainForTrustCheck) {
    const suppressed = await isSenderSuppressed(connection.organization, senderDomainForTrustCheck);
    if (suppressed) {
      return { fields: null, creditsUsed: 0, suppressed: true };
    }
  }

  const extraction = await extractInvoiceFields({
    subject: message.subject,
    fromHeader: message.fromHeader,
    bodyText: message.plainText,
  });

  // The API call itself costs tokens whether or not this turns out to be a
  // real invoice — deduct the same way a Billing Advisor Agent turn does,
  // regardless of the outcome below. Computed once so the caller can also
  // track the run's remaining balance without re-deriving it.
  const creditsUsed = tokensToCredits(extraction.inputTokens, extraction.outputTokens);
  void consumeCredits(
    connection.organization,
    creditsUsed,
    "email_invoice_extraction",
    connection.user
  );

  const fields = extraction.fields;
  // Not a real billing email (a promo that matched the search keywords), or
  // amount/currency couldn't be confidently read — guessing either wrong is
  // worse than skipping this message, so both must be present.
  if (!fields.isBillingEmail || fields.amount === null || fields.currency === null) {
    return { fields: null, creditsUsed };
  }

  const { displayName, email: senderEmail, domain } = parseSender(
    message.fromHeader ?? undefined
  );
  const vendorSlug =
    (domain ?? "unknown")
      .replace(/\.(com|net|org|io|co)$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase() || "unknown";
  // The AI reads the email's own branding, so its vendor name is generally
  // more accurate than a domain-derived guess — prefer it when present. This
  // is who the bill is FROM (Netflix, Spotify, ...) — shown as "platform"
  // (see billing.serializer.ts), never confused with `customerName` below,
  // which is who the bill is TO (this workspace, not the vendor).
  const vendorNameFromAi = meaningfulString(fields.customerName);
  const invoiceNumberFromAi = meaningfulString(fields.invoiceNumber);
  const vendorName =
    vendorNameFromAi ??
    displayName ??
    (vendorSlug !== "unknown" ? vendorSlug[0].toUpperCase() + vendorSlug.slice(1) : "Email invoice");
  const invoiceNumber = invoiceNumberFromAi ?? `EMAIL-${message.id.slice(0, 10).toUpperCase()}`;
  const billingDate = parseAiDate(fields.billingDate) ?? message.receivedAt;
  const dueDate = parseAiDate(fields.dueDate);

  // Real vendor identity (Task 7) — resolved by domain, the reliable key for
  // an email-derived vendor, so the SAME vendor across many emails (and even
  // across a separate billing-sync connection to the same vendor) collapses
  // onto one Vendor document instead of staying three disconnected strings.
  const vendorDoc = await resolveVendor(connection.organization, {
    name: vendorName,
    domain,
  });

  // Task 9 — sender verification. DMARC failing is real, mail-server-
  // verified evidence the From: address may be spoofed; a Reply-To/From
  // domain mismatch is a second, independent BEC signal. Either one
  // downgrades this extraction's confidence rather than rejecting the
  // email outright — a legitimate vendor can genuinely have DMARC
  // misconfigured, so this is a trust signal for the user/agent to weigh,
  // not an automatic block.
  const senderAuthResult = message.authResults.dmarc;
  const senderReplyToMismatch = hasReplyToMismatch(
    message.fromHeader ?? undefined,
    message.replyToHeader ?? undefined
  );
  const penalizedConfidence = applySenderTrustPenalty(
    fields.confidence,
    message.authResults,
    senderReplyToMismatch
  );
  // WP-11 — the OTHER direction: a sender this workspace has taught the
  // pipeline to trust (3+ confirmed invoices, never deleted) gets a
  // confidence FLOOR raised, same spirit as Task 9's penalty but the
  // positive case. Applied after the penalty, not instead of it — a
  // trusted sender whose DMARC genuinely fails this one time is still
  // worth flagging, just not all the way back down to "low confidence".
  const adjustedConfidence =
    penalizedConfidence !== null &&
    domain &&
    (await isSenderTrusted(connection.organization, domain))
      ? Math.max(penalizedConfidence, TRUSTED_SENDER_CONFIDENCE_FLOOR)
      : penalizedConfidence;

  // Prefer a semantic dedupe key (vendor + invoice number) over the raw message
  // id: an initial "your invoice" email and a later "payment received" receipt
  // for the SAME invoice then update ONE record's status instead of creating
  // two disconnected rows. Namespaced by vendor domain to avoid cross-vendor
  // invoice-number collisions, and by provider to avoid cross-provider ones.
  //
  // When there's no invoice number at all, the fallback used to be keyed by
  // the raw message id — which seemed safe (one Billing row per email) but
  // broke badly in practice: a real inbox had dozens of separate, genuinely
  // distinct emails about what was really the SAME recurring charge (same
  // vendor, same amount, same day) with no invoice number in any of them —
  // each got its own row, and the AI cost of scanning them all emptied the
  // workspace's credits in one run. Keying by vendor + amount + day instead
  // collapses same-day repeats of the same charge into one record, the same
  // way a real invoice number would — while still keying by day so distinct
  // billing cycles (different days) each still get their own row.
  // Defensive: an Invalid Date here (a malformed provider timestamp that
  // slipped past the providers' own guards) would throw on `.toISOString()`
  // and abort this message — falling back to "now" is a far better outcome
  // than losing the whole message over an unparseable date.
  const billingDateKey = Number.isNaN(billingDate.getTime())
    ? new Date().toISOString().slice(0, 10)
    : billingDate.toISOString().slice(0, 10);
  const externalId = invoiceNumberFromAi
    ? `${provider.dedupePrefix}-inv-${vendorSlug}-${invoiceNumberFromAi.replace(/[^A-Za-z0-9-]/g, "").toLowerCase()}`
    : `${provider.dedupePrefix}-day-${vendorSlug}-${fields.amount}-${billingDateKey}`;

  const dedupeQuery = {
    organization: connection.organization,
    platformConnection: connection._id,
    externalId,
  };

  const evidenceSnippet = buildEvidenceSnippet(message.plainText);

  // No real invoice number, and this email is reporting a Paid/Overdue
  // OUTCOME rather than a fresh bill: the day-keyed externalId above only
  // catches same-day repeats, so hand the caller a vendor+amount prefix (day
  // segment stripped) it can use to find an already-open invoice from a
  // different day and resolve onto that instead of creating a new row — see
  // the commit loop's `openInvoiceLookup` handling in `syncConnectionEmail`.
  const openInvoiceLookup =
    !invoiceNumberFromAi && (fields.status === "Paid" || fields.status === "Overdue")
      ? { externalIdPrefix: `${provider.dedupePrefix}-day-${vendorSlug}-${fields.amount}-` }
      : null;

  return {
    fields: {
      dedupeQuery,
      openInvoiceLookup,
      setFields: {
        organization: connection.organization,
        user: connection.user,
        platformConnection: connection._id,
        source: "email_sync",
        externalId,
        vendorName,
        vendor: vendorDoc._id,
        ...(vendorDoc.domain ? { vendorDomain: vendorDoc.domain } : {}),
        customerName: organizationName,
        invoiceNumber,
        amount: fields.amount,
        currency: fields.currency,
        billingDate,
        ...(dueDate ? { dueDate } : {}),
        status: fields.status ?? "Pending",
        notes: provider.notesText,
        // Provenance trail (Task 6) — lets a user or the agent verify where
        // this record actually came from instead of taking one AI guess on
        // faith. `evidence`/`extractionConfidence` are omitted rather than
        // set to a fake default when unavailable, matching every other
        // optional field's pattern in this object.
        sourceMessageId: message.id,
        ...(message.threadId ? { sourceThreadId: message.threadId } : {}),
        ...(senderEmail ? { senderEmail } : {}),
        ...(domain ? { senderDomain: domain } : {}),
        receivedAt: message.receivedAt,
        ...(message.subject ? { subject: message.subject } : {}),
        ...(adjustedConfidence !== null ? { extractionConfidence: adjustedConfidence } : {}),
        extractionModel: EXTRACTION_MODEL,
        extractedAt: new Date(),
        ...(evidenceSnippet ? { evidence: [evidenceSnippet] } : {}),
        senderAuthResult,
        senderReplyToMismatch,
      },
    },
    creditsUsed,
  };
}
