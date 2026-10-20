import { Types } from "mongoose";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { Billing } from "@/models/billing.model";
import { BillingEvent } from "@/models/billing-event.model";
import { Organization } from "@/models/organization.model";
import { PlatformConnection } from "@/models/platform-connection.model";
import { ProcessedMessage } from "@/models/processed-message.model";
import { SenderProfile } from "@/models/sender-profile.model";
import { syncConnectionEmail } from "@/services/email-sync/sync-engine";
import type { EmailSyncProvider, NormalizedEmailMessage } from "@/services/email-sync/provider";

vi.mock("@/services/email-sync/provider", async () => {
  const actual = await vi.importActual<typeof import("@/services/email-sync/provider")>(
    "@/services/email-sync/provider"
  );
  return { ...actual, getEmailSyncProvider: vi.fn() };
});

vi.mock("@/services/email-sync/ai-invoice-extractor", async () => {
  const actual = await vi.importActual<typeof import("@/services/email-sync/ai-invoice-extractor")>(
    "@/services/email-sync/ai-invoice-extractor"
  );
  return {
    ...actual,
    isAiExtractionConfigured: vi.fn(() => true),
    extractInvoiceFields: vi.fn(),
  };
});

import { getEmailSyncProvider } from "@/services/email-sync/provider";
import { extractInvoiceFields } from "@/services/email-sync/ai-invoice-extractor";

const AWS_FROM = "AWS Billing <billing@aws.amazon.com>";

/** Builds a minimal fake provider whose `listCandidateMessageIds` returns
 *  exactly the given messages (one page, no pagination) and whose
 *  `getMessage` looks them up by id — enough surface for
 *  syncConnectionEmail's real loop/commit logic to run unmodified, without
 *  touching a real Gmail/Outlook/Pipedream call. */
function fakeProvider(messages: NormalizedEmailMessage[]): EmailSyncProvider {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    dedupePrefix: "gmail",
    notesText: "Synced from Gmail",
    filtersSinceDateClientSide: false,
    buildSearchQuery: () => "q",
    listCandidateMessageIds: async () => ({ messageIds: [...byId.keys()] }),
    getMessage: async (_u, _a, messageId) => byId.get(messageId) ?? null,
  };
}

function message(partial: Partial<NormalizedEmailMessage> & Pick<NormalizedEmailMessage, "id" | "receivedAt">): NormalizedEmailMessage {
  return {
    threadId: null,
    subject: "Invoice",
    plainText: "body",
    fromHeader: AWS_FROM,
    replyToHeader: null,
    authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ...partial,
  };
}

/** Real-DB-backed invoice field extraction stub — keyed by subject so each
 *  mocked message can report a different AI outcome, exactly like a real
 *  extraction call would for a different email. */
function mockExtraction(bySubject: Record<string, { status: "Pending" | "Paid" | "Overdue"; confidence: number }>) {
  vi.mocked(extractInvoiceFields).mockImplementation(async (input) => {
    const outcome = bySubject[input.subject ?? ""];
    return {
      fields: {
        isBillingEmail: true,
        amount: 42,
        currency: "USD",
        invoiceNumber: "INV-100",
        customerName: "AWS",
        billingDate: "2026-01-01",
        dueDate: null,
        status: outcome?.status ?? "Pending",
        confidence: outcome?.confidence ?? 0.9,
      },
      inputTokens: 50,
      outputTokens: 20,
    };
  });
}

/**
 * GM-027, end-to-end through the real syncConnectionEmail pipeline (not just
 * the pure deriveStatus() function — see status-machine.test.ts for that
 * layer). This is what actually proves the narrow cutover (the user's
 * explicit "fix the bug only" scope choice) works through the real commit
 * loop in email-sync/sync-engine.ts, including the manuallyEditedAt guard,
 * the dedupe-by-externalId resolution, and the real Billing/BillingEvent
 * collections — not a mocked model layer.
 */
describe("syncConnectionEmail — GM-027 cutover (real DB, mocked provider + AI extractor only)", () => {
  beforeEach(() => {
    vi.mocked(getEmailSyncProvider).mockReset();
  });

  async function seedOrgAndConnection() {
    const organization = await Organization.create({ name: "Cutover Test Org", creditsBalance: 10_000 });
    const userId = new Types.ObjectId();
    const connection = await PlatformConnection.create({
      organization: organization._id,
      user: userId,
      platform: "gmail",
      accountIdentifier: "owner@example.com",
      displayName: "Gmail",
      status: "connected",
      connectionType: "oauth",
      metadata: { pipedreamAccountId: "apn_test123" },
    });
    return { organization, connection };
  }

  it("a stale reminder synced in a LATER run than its own payment confirmation does not revert Billing.status back to Pending", async () => {
    const { organization, connection } = await seedOrgAndConnection();

    // Run 1: the original invoice, then its payment confirmation — both
    // discovered in the same pass (the common case).
    mockExtraction({
      "Your invoice is ready": { status: "Pending", confidence: 0.9 },
      "Payment received": { status: "Paid", confidence: 0.95 },
    });
    vi.mocked(getEmailSyncProvider).mockReturnValue(
      fakeProvider([
        message({ id: "msg-invoice-1", receivedAt: new Date("2026-01-01"), subject: "Your invoice is ready" }),
        message({ id: "msg-payment-1", receivedAt: new Date("2026-01-05"), subject: "Payment received" }),
      ])
    );

    const freshConnection = await PlatformConnection.findById(connection._id);
    if (!freshConnection) throw new Error("seed failed");
    await syncConnectionEmail(freshConnection);

    const afterRun1 = await Billing.findOne({ organization: organization._id });
    expect(afterRun1?.status).toBe("Paid");
    expect(afterRun1?.derivedStatus).toBe("paid");

    // Run 2: a stale reminder for the SAME invoice (same invoice number →
    // same dedupe key → same Billing row) surfaces late — its own
    // occurredAt (Jan 3) is actually BEFORE the payment confirmation (Jan
    // 5), it just wasn't discovered by the inbox search until this later
    // run. Pre-fix, the naive write directly below would have reverted
    // `status` straight back to "Pending" because it only ever looks at
    // THIS one email — that is the exact confirmed bug (GM-027) this
    // cutover fixes.
    mockExtraction({
      "Reminder: payment due": { status: "Pending", confidence: 0.85 },
    });
    vi.mocked(getEmailSyncProvider).mockReturnValue(
      fakeProvider([
        message({ id: "msg-reminder-1", receivedAt: new Date("2026-01-03"), subject: "Reminder: payment due" }),
      ])
    );

    const connectionForRun2 = await PlatformConnection.findById(connection._id);
    if (!connectionForRun2) throw new Error("seed failed");
    await syncConnectionEmail(connectionForRun2);

    const afterRun2 = await Billing.findOne({ organization: organization._id });
    // The real bug fix: status stays Paid, not reverted to Pending.
    expect(afterRun2?.status).toBe("Paid");
    expect(afterRun2?.derivedStatus).toBe("paid");

    // Exactly one Billing row the whole time — the reminder resolved onto
    // the SAME record via the invoice-number dedupe key, not a new one.
    const allBilling = await Billing.find({ organization: organization._id });
    expect(allBilling).toHaveLength(1);

    const events = await BillingEvent.find({ billing: afterRun2?._id }).sort({ occurredAt: 1 });
    expect(events.map((e) => e.type)).toEqual(["invoice_issued", "reminder", "payment_confirmed"]);
  });

  it("a brand-new invoice whose own due date is already past is written as Overdue on first sync, not Pending (a real improvement, not just a bug fix)", async () => {
    const { organization, connection } = await seedOrgAndConnection();

    // The AI extractor only ever reports "Pending" for a plain invoice with
    // no payment confirmation yet — the OLD naive write copied that
    // verbatim, so a first-ever sync of an old, already-overdue invoice
    // used to sit as "Pending" until some later signal changed it. The
    // cutover's due-date fallback (deriveStatus step 6) catches this
    // immediately instead, since it looks at the real dueDate, not just
    // the single email's own reported status.
    mockExtraction({
      "Old invoice, already overdue": { status: "Pending", confidence: 0.9 },
    });
    vi.mocked(extractInvoiceFields).mockImplementation(async () => ({
      fields: {
        isBillingEmail: true,
        amount: 99,
        currency: "USD",
        invoiceNumber: "INV-OLD-1",
        customerName: "AWS",
        billingDate: "2019-12-01",
        dueDate: "2019-12-15",
        status: "Pending",
        confidence: 0.9,
      },
      inputTokens: 50,
      outputTokens: 20,
    }));
    vi.mocked(getEmailSyncProvider).mockReturnValue(
      fakeProvider([
        message({
          id: "msg-old-1",
          receivedAt: new Date("2020-01-01"),
          subject: "Old invoice, already overdue",
        }),
      ])
    );

    const freshConnection = await PlatformConnection.findById(connection._id);
    if (!freshConnection) throw new Error("seed failed");
    await syncConnectionEmail(freshConnection);

    const billing = await Billing.findOne({ organization: organization._id });
    expect(billing?.status).toBe("Overdue");
    expect(billing?.derivedStatus).toBe("overdue");
  });
});

/**
 * WP-11 learning loop, integration-level: proves the suppression check
 * actually skips the (mocked) AI extractor call entirely — not just that
 * the service function returns the right answer in isolation (already
 * covered by sender-trust.test.ts) — and that a trusted sender's confidence
 * genuinely gets raised in the real commit loop.
 */
describe("syncConnectionEmail — WP-11 sender trust integration", () => {
  beforeEach(() => {
    vi.mocked(getEmailSyncProvider).mockReset();
  });

  async function seedOrgAndConnection() {
    const organization = await Organization.create({ name: "Sender Trust Test Org", creditsBalance: 10_000 });
    const userId = new Types.ObjectId();
    const connection = await PlatformConnection.create({
      organization: organization._id,
      user: userId,
      platform: "gmail",
      accountIdentifier: "owner@example.com",
      displayName: "Gmail",
      status: "connected",
      connectionType: "oauth",
      metadata: { pipedreamAccountId: "apn_test123" },
    });
    return { organization, connection };
  }

  it("a suppressed sender's candidate message never reaches the AI extractor, costs 0 credits, marked suppressed_sender", async () => {
    const { organization, connection } = await seedOrgAndConnection();
    await SenderProfile.create({
      organization: organization._id,
      domain: "aws.amazon.com",
      trust: "suppressed",
    });

    mockExtraction({}); // would fail the test if actually called with an unexpected subject
    const extractSpy = vi.mocked(extractInvoiceFields);
    vi.mocked(getEmailSyncProvider).mockReturnValue(
      fakeProvider([
        message({ id: "msg-suppressed-1", receivedAt: new Date("2026-02-01"), subject: "Your invoice" }),
      ])
    );

    const freshConnection = await PlatformConnection.findById(connection._id);
    if (!freshConnection) throw new Error("seed failed");

    const creditsBefore = (await Organization.findById(organization._id))?.creditsBalance;
    await syncConnectionEmail(freshConnection);
    const creditsAfter = (await Organization.findById(organization._id))?.creditsBalance;

    expect(extractSpy).not.toHaveBeenCalled();
    expect(creditsAfter).toBe(creditsBefore); // 0 credits spent

    const billing = await Billing.find({ organization: organization._id });
    expect(billing).toHaveLength(0);

    const processed = await ProcessedMessage.findOne({
      connection: connection._id,
      messageId: "msg-suppressed-1",
    });
    expect(processed?.outcome).toBe("suppressed_sender");
  });

  it("a trusted sender's low raw confidence gets raised to the trust floor", async () => {
    const { organization, connection } = await seedOrgAndConnection();
    await SenderProfile.create({
      organization: organization._id,
      domain: "aws.amazon.com",
      trust: "trusted",
    });

    // The AI's own raw confidence (0.3) is well below the trust floor —
    // proves the floor actually overrides it, not just passes it through.
    mockExtraction({ "Your invoice": { status: "Pending", confidence: 0.3 } });
    vi.mocked(getEmailSyncProvider).mockReturnValue(
      fakeProvider([
        message({ id: "msg-trusted-1", receivedAt: new Date("2026-02-01"), subject: "Your invoice" }),
      ])
    );

    const freshConnection = await PlatformConnection.findById(connection._id);
    if (!freshConnection) throw new Error("seed failed");
    await syncConnectionEmail(freshConnection);

    const billing = await Billing.findOne({ organization: organization._id });
    expect(billing?.extractionConfidence).toBeGreaterThanOrEqual(0.75);
  });

  it("a NEUTRAL (never-evaluated) sender behaves exactly as before — no behavior change for the common case", async () => {
    const { organization, connection } = await seedOrgAndConnection();
    // No SenderProfile created at all — the realistic "never seen this
    // domain before" case.

    mockExtraction({ "Your invoice": { status: "Pending", confidence: 0.9 } });
    vi.mocked(getEmailSyncProvider).mockReturnValue(
      fakeProvider([
        message({ id: "msg-neutral-1", receivedAt: new Date("2026-02-01"), subject: "Your invoice" }),
      ])
    );

    const freshConnection = await PlatformConnection.findById(connection._id);
    if (!freshConnection) throw new Error("seed failed");
    await syncConnectionEmail(freshConnection);

    const billing = await Billing.findOne({ organization: organization._id });
    expect(billing).not.toBeNull();
    expect(billing?.extractionConfidence).toBe(0.9); // untouched, no floor applied
  });
});

/**
 * P1-06 — Outlook can't filter by date server-side, and Graph sorts `$search`
 * results by SENT time, not received time. The engine used to stop at the
 * first "old" result and still advance the watermark, permanently skipping
 * any newer mail listed after it. These tests drive an Outlook-shaped fake
 * provider (client-side date filtering, pages, a result cap) through the
 * real syncConnectionEmail loop.
 */
describe("syncConnectionEmail — P1-06 client-side date filter (Outlook-shaped provider)", () => {
  // Watermark → sinceDate = lastSyncedAt − OVERLAP_DAYS (1) = 2026-10-17T10:00Z.
  const LAST_SYNCED_AT = "2026-10-18T10:00:00.000Z";
  const NEW = new Date("2026-10-19T09:00:00Z");
  const OLD = new Date("2026-10-15T09:00:00Z");

  beforeEach(() => {
    vi.mocked(getEmailSyncProvider).mockReset();
    vi.mocked(extractInvoiceFields).mockReset();
  });

  /** One page per inner array; `failOnPage` makes that page's list call throw. */
  function pagedProvider(
    pages: NormalizedEmailMessage[][],
    opts: { failOnPage?: number; maxSearchResults?: number } = {}
  ) {
    const byId = new Map(pages.flat().map((m) => [m.id, m]));
    const getMessage = vi.fn(async (_u: string, _a: string, id: string) => byId.get(id) ?? null);
    const listCandidateMessageIds = vi.fn(
      async (_u: string, _a: string, _q: string, _max: number, pageToken?: string) => {
        const index = pageToken ? Number(pageToken) : 0;
        if (opts.failOnPage === index) throw new Error("Graph 503");
        const pageMessages = pages[index] ?? [];
        return {
          messageIds: pageMessages.map((m) => m.id),
          receivedAtById: Object.fromEntries(pageMessages.map((m) => [m.id, m.receivedAt])),
          nextPageToken: index + 1 < pages.length ? String(index + 1) : undefined,
        };
      }
    );
    const provider: EmailSyncProvider = {
      dedupePrefix: "outlook",
      notesText: "Parsed from an Outlook message",
      filtersSinceDateClientSide: true,
      maxSearchResults: opts.maxSearchResults ?? 1000,
      buildSearchQuery: () => "q",
      listCandidateMessageIds,
      getMessage,
    };
    return { provider, getMessage, listCandidateMessageIds };
  }

  async function seedOutlookConnection() {
    const organization = await Organization.create({ name: "Outlook Test Org", creditsBalance: 10_000 });
    const connection = await PlatformConnection.create({
      organization: organization._id,
      user: new Types.ObjectId(),
      platform: "microsoft_outlook",
      accountIdentifier: "owner@example.com",
      displayName: "Outlook",
      status: "connected",
      connectionType: "oauth",
      metadata: { pipedreamAccountId: "apn_test123", emailSync: { lastSyncedAt: LAST_SYNCED_AT } },
    });
    return { organization, connection };
  }

  async function runSync(connectionId: Types.ObjectId) {
    const fresh = await PlatformConnection.findById(connectionId);
    if (!fresh) throw new Error("seed failed");
    await syncConnectionEmail(fresh);
    return PlatformConnection.findById(connectionId).lean();
  }

  function watermarkOf(conn: { metadata?: unknown } | null): string | undefined {
    return (conn?.metadata as { emailSync?: { lastSyncedAt?: string } } | undefined)?.emailSync
      ?.lastSyncedAt;
  }

  it("unsorted results: an old message listed BETWEEN new ones doesn't stop the run — both new ones are processed, the old one is never fetched", async () => {
    const { connection } = await seedOutlookConnection();
    // Already handled by an earlier run — must be skipped before any fetch
    // or AI call (what makes a future one-off rescan free).
    await ProcessedMessage.create({
      connection: connection._id,
      messageId: "msg-already",
      outcome: "invoice",
      processedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    mockExtraction({});
    const { provider, getMessage } = pagedProvider([
      [
        message({ id: "msg-new-1", receivedAt: NEW, subject: "Invoice A" }),
        message({ id: "msg-old", receivedAt: OLD, subject: "Old receipt" }),
        message({ id: "msg-already", receivedAt: NEW, subject: "Already done" }),
        message({ id: "msg-new-2", receivedAt: NEW, subject: "Invoice B" }),
      ],
    ]);
    vi.mocked(getEmailSyncProvider).mockReturnValue(provider);

    const after = await runSync(connection._id);

    expect(getMessage.mock.calls.map((c) => c[2])).toEqual(["msg-new-1", "msg-new-2"]);
    expect(vi.mocked(extractInvoiceFields).mock.calls.map((c) => c[0].subject).sort()).toEqual([
      "Invoice A",
      "Invoice B",
    ]);
    expect(new Date(watermarkOf(after) ?? 0).getTime()).toBeGreaterThan(
      new Date(LAST_SYNCED_AT).getTime()
    );
  });

  it("multiple pages: every page is read, and a new message on page 2 after an old one on page 1 is processed", async () => {
    const { connection } = await seedOutlookConnection();
    mockExtraction({});
    const { provider, listCandidateMessageIds } = pagedProvider([
      [message({ id: "msg-old", receivedAt: OLD, subject: "Old receipt" })],
      [message({ id: "msg-new-p2", receivedAt: NEW, subject: "Invoice on page 2" })],
    ]);
    vi.mocked(getEmailSyncProvider).mockReturnValue(provider);

    const after = await runSync(connection._id);

    expect(listCandidateMessageIds).toHaveBeenCalledTimes(2);
    expect(vi.mocked(extractInvoiceFields).mock.calls.map((c) => c[0].subject)).toEqual([
      "Invoice on page 2",
    ]);
    expect(watermarkOf(after)).not.toBe(LAST_SYNCED_AT);
  });

  it("failure mid-sync: a page that fails to list leaves the watermark unchanged, records the error, and nothing is marked processed (retried next run)", async () => {
    const { organization, connection } = await seedOutlookConnection();
    mockExtraction({});
    const { provider } = pagedProvider(
      [
        [message({ id: "msg-new-p1", receivedAt: NEW, subject: "Invoice on page 1" })],
        [message({ id: "msg-new-p2", receivedAt: NEW, subject: "Invoice on page 2" })],
      ],
      { failOnPage: 1 }
    );
    vi.mocked(getEmailSyncProvider).mockReturnValue(provider);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const after = await runSync(connection._id);
    errorSpy.mockRestore();

    expect(watermarkOf(after)).toBe(LAST_SYNCED_AT);
    expect(after?.lastSyncStatus).toBe("error");
    expect(await ProcessedMessage.countDocuments({ connection: connection._id })).toBe(0);
    expect(await Billing.countDocuments({ organization: organization._id })).toBe(0);
  });

  it("empty result: nothing is created and the watermark still advances", async () => {
    const { organization, connection } = await seedOutlookConnection();
    const { provider, getMessage } = pagedProvider([[]]);
    vi.mocked(getEmailSyncProvider).mockReturnValue(provider);

    const after = await runSync(connection._id);

    expect(getMessage).not.toHaveBeenCalled();
    expect(await Billing.countDocuments({ organization: organization._id })).toBe(0);
    expect(after?.lastSyncStatus).toBe("success");
    expect(new Date(watermarkOf(after) ?? 0).getTime()).toBeGreaterThan(
      new Date(LAST_SYNCED_AT).getTime()
    );
  });

  it("search result cap reached: the watermark is held and a warning is logged", async () => {
    const { connection } = await seedOutlookConnection();
    const { provider } = pagedProvider(
      [
        [
          message({ id: "msg-old-1", receivedAt: OLD }),
          message({ id: "msg-old-2", receivedAt: OLD }),
          message({ id: "msg-old-3", receivedAt: OLD }),
        ],
      ],
      { maxSearchResults: 3 }
    );
    vi.mocked(getEmailSyncProvider).mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const after = await runSync(connection._id);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();

    expect(watermarkOf(after)).toBe(LAST_SYNCED_AT);
    expect(warnings.some((w) => w.includes("cap of 3"))).toBe(true);
  });

  it("UTC: a message received 1 second before the window is skipped, 1 second inside is processed", async () => {
    const { connection } = await seedOutlookConnection();
    mockExtraction({});
    const { provider } = pagedProvider([
      [
        message({ id: "msg-just-before", receivedAt: new Date("2026-10-17T09:59:59Z"), subject: "Before" }),
        message({ id: "msg-just-inside", receivedAt: new Date("2026-10-17T10:00:01Z"), subject: "Inside" }),
      ],
    ]);
    vi.mocked(getEmailSyncProvider).mockReturnValue(provider);

    await runSync(connection._id);

    expect(vi.mocked(extractInvoiceFields).mock.calls.map((c) => c[0].subject)).toEqual(["Inside"]);
  });
});
