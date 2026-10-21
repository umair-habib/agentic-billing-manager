/**
 * Gmail's EmailSyncProvider implementation — the search-query syntax and
 * message normalization live here; the raw REST calls stay in gmail-client.ts.
 */
import type { EmailSyncProvider } from "@/services/email-sync/provider";
import {
  listCandidateMessageIds,
  getMessage,
  getAttachment,
  type GmailMessage,
} from "@/services/email-sync/gmail-client";
import {
  extractPlainText,
  findPdfAttachmentParts,
  parseAuthenticationResults,
} from "@/services/email-sync/parser";
import { extractPdfText } from "@/services/email-sync/pdf-extractor";

const INVOICE_KEYWORDS = [
  "invoice",
  "receipt",
  '"payment receipt"',
  '"payment confirmation"',
  '"billing statement"',
  '"your invoice"',
  '"amount due"',
  '"payment received"',
  "statement",
];
const FIRST_SYNC_LOOKBACK_DAYS = 90;

function formatGmailDate(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function buildSearchQuery(sinceDate: Date | null, trackedSenders: string[]): string {
  const window = sinceDate
    ? `after:${formatGmailDate(sinceDate)}`
    : `newer_than:${FIRST_SYNC_LOOKBACK_DAYS}d`;

  // Senders configured: scope to just those, AND still require an
  // invoice/receipt keyword. An earlier version dropped the keyword filter
  // entirely once a sender was tracked, reasoning that a handful of trusted
  // senders is low-volume enough to let the AI extractor alone tell promo
  // from billing content. In practice it didn't: a tracked "netflix.com"
  // pulled in every marketing/notification email from that domain too, and
  // the extractor misread several of them as billing emails in one run
  // (their footers mention the subscription price), producing dozens of
  // duplicate invoice rows for one real subscription and burning through
  // the workspace's credits. Keeping the keyword requirement even for
  // tracked senders cuts candidates down to what's actually invoice-shaped
  // before they ever reach the AI call — still catches wording variance the
  // AI is good at (e.g. "amount due" vs "your bill"), just not literally
  // everything a domain ever emails.
  //
  // The promotions/social/forums exclusion below only makes sense for the
  // broad, sender-less scan — it exists to cut inbox noise, not to second-
  // guess a domain the user already trusts. Gmail's own ML sometimes drops
  // a genuine transactional email (invoice, payment receipt) into the
  // Promotions tab a few minutes after delivery; excluding that category
  // once a sender is tracked would silently make such an email invisible
  // to every future sync, including the "payment received" follow-up that's
  // supposed to flip an existing record from Pending to Paid.
  const noise =
    trackedSenders.length > 0
      ? "-in:spam -in:trash"
      : "-category:promotions -category:social -category:forums -in:spam -in:trash";
  const keywords = `(${INVOICE_KEYWORDS.join(" OR ")})`;
  const subject =
    trackedSenders.length > 0
      ? `(${trackedSenders.map((s) => `from:${s}`).join(" OR ")}) ${keywords}`
      : keywords;

  return `${subject} ${noise} ${window}`;
}

/** WP-6 attachment recall — appends any PDF attachment's extracted text to
 *  the message's own body text (never replaces it: a short "see attached
 *  invoice" body plus the PDF's real content is the best case for the AI
 *  extractor). The combined result flows through the SAME `<email>`
 *  untrusted-data framing and `MAX_BODY_CHARS` truncation
 *  `ai-invoice-extractor.ts` already applies to `plainText` — no separate
 *  defense needed for attachment-derived text, it's just more of the same
 *  field. Best-effort per attachment: one unreadable/corrupt PDF is skipped,
 *  never aborts the message. */
async function appendPdfAttachmentText(
  externalUserId: string,
  pipedreamAccountId: string,
  message: GmailMessage,
  bodyText: string
): Promise<string> {
  const pdfParts = findPdfAttachmentParts(message);
  if (pdfParts.length === 0) return bodyText;

  const extracted: string[] = [];
  for (const part of pdfParts) {
    const buffer = part.inlineData
      ? Buffer.from(part.inlineData, "base64url")
      : part.attachmentId
        ? await getAttachment(externalUserId, pipedreamAccountId, message.id, part.attachmentId)
        : null;
    if (!buffer) continue;
    const text = await extractPdfText(buffer);
    if (text) extracted.push(`[Attachment: ${part.filename}]\n${text}`);
  }
  if (extracted.length === 0) return bodyText;
  return `${bodyText}\n\n${extracted.join("\n\n")}`;
}

export const GMAIL_PROVIDER: EmailSyncProvider = {
  dedupePrefix: "gmail",
  notesText: "Parsed from a Gmail message (fallback email sync).",
  // Gmail's `q=` query already narrows server-side by date — no client-side
  // early-stop needed (and its search results aren't reliably newest-first).
  filtersSinceDateClientSide: false,
  buildSearchQuery,
  listCandidateMessageIds,
  async getMessage(externalUserId, pipedreamAccountId, messageId) {
    const message = await getMessage(externalUserId, pipedreamAccountId, messageId);
    if (!message) return null;
    const headers = message.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
    const fromHeader = header("from");
    const subject = header("subject");
    const replyToHeader = header("reply-to");
    // Gmail's own receiving server stamps this — real evidence, not
    // anything the sender controls (Task 9, S-08).
    const authResults = parseAuthenticationResults(header("authentication-results"));
    // Defensive: a malformed/non-numeric `internalDate` would silently
    // produce an Invalid Date (no error here) that later crashes when
    // something calls `.toISOString()` on it — falling back to "now" is a
    // safe default rather than letting that happen further down the line.
    const parsedInternalDate = message.internalDate
      ? new Date(Number(message.internalDate))
      : null;
    const receivedAt =
      parsedInternalDate && !Number.isNaN(parsedInternalDate.getTime())
        ? parsedInternalDate
        : new Date();
    const plainText = await appendPdfAttachmentText(
      externalUserId,
      pipedreamAccountId,
      message,
      extractPlainText(message)
    );
    return {
      id: message.id,
      threadId: message.threadId,
      receivedAt,
      subject,
      plainText,
      fromHeader,
      replyToHeader,
      authResults,
    };
  },
};
