/**
 * Outlook's EmailSyncProvider implementation. Unlike Gmail, Microsoft Graph's
 * `$search` on /me/messages CANNOT be combined with a `$filter` on
 * `receivedDateTime` (a 400 error) — so the search query itself carries only
 * keywords. Incremental "since last sync" is instead handled client-side by
 * the engine, per message, using the `receivedDateTime` the list call returns
 * (see `filtersSinceDateClientSide` below). No order is assumed: Graph sorts
 * `$search` results by SENT time, not received time, so stopping at the first
 * "old" result could skip newer mail (P1-06).
 */
import type { EmailSyncProvider } from "@/services/email-sync/provider";
import {
  listCandidateMessageIds,
  getMessage,
  getAttachments,
  parseGraphDateTime,
} from "@/services/email-sync/outlook-client";
import { stripHtml, parseAuthenticationResults } from "@/services/email-sync/parser";
import { extractPdfText } from "@/services/email-sync/pdf-extractor";

const MAX_PDF_ATTACHMENTS_PER_MESSAGE = 3;

/** WP-6 attachment recall — mirrors gmail-provider.ts's identical fix. Graph
 *  inlines attachment bytes directly (no separate per-attachment call), so
 *  this is simpler than Gmail's version: list once, filter to PDFs, decode. */
async function appendPdfAttachmentText(
  externalUserId: string,
  pipedreamAccountId: string,
  messageId: string,
  bodyText: string
): Promise<string> {
  const attachments = await getAttachments(externalUserId, pipedreamAccountId, messageId);
  const pdfAttachments = attachments
    .filter(
      (a) =>
        a.contentBytes &&
        (a.contentType === "application/pdf" || /\.pdf$/i.test(a.name ?? ""))
    )
    .slice(0, MAX_PDF_ATTACHMENTS_PER_MESSAGE);
  if (pdfAttachments.length === 0) return bodyText;

  const extracted: string[] = [];
  for (const attachment of pdfAttachments) {
    const buffer = Buffer.from(attachment.contentBytes as string, "base64");
    const text = await extractPdfText(buffer);
    if (text) extracted.push(`[Attachment: ${attachment.name ?? "attachment.pdf"}]\n${text}`);
  }
  if (extracted.length === 0) return bodyText;
  return `${bodyText}\n\n${extracted.join("\n\n")}`;
}

/** Graph's `emailAddress` shape -> the "Name <email>" format `parser.ts`'s
 *  `parseSender` expects, matching Gmail's raw header format so both
 *  providers feed the same downstream parsing. */
function formatEmailAddress(
  address: { name?: string; address?: string } | undefined
): string | null {
  if (!address?.address) return null;
  return address.name ? `"${address.name}" <${address.address}>` : `<${address.address}>`;
}

// Graph's $search clause syntax: `"<property>:<text>"`, joined with OR/AND
// (operators outside the quotes, uppercase). Multi-word phrases are just the
// clause's text — KQL tokenizes them rather than requiring an exact phrase
// match. This keyword set is only used as a fallback when no senders are
// tracked yet; the AI extractor is what actually decides billing-relevance.
const SEARCH_CLAUSES = [
  '"body:invoice"',
  '"body:receipt"',
  '"subject:invoice"',
  '"subject:receipt"',
  '"body:payment receipt"',
  '"body:payment confirmation"',
  '"body:billing statement"',
  '"body:your invoice"',
  '"body:amount due"',
  '"body:payment received"',
  '"body:statement"',
];

function buildSearchQuery(_sinceDate: Date | null, trackedSenders: string[]): string {
  // Senders configured: scope to just those, AND still require an
  // invoice/receipt clause — see gmail-provider.ts's identical fix (a real
  // incident: dropping the keyword filter for tracked senders let a
  // domain's routine marketing/notification emails through too, and the AI
  // extractor misclassified several as billing emails in one run, creating
  // dozens of duplicate invoices and burning the workspace's credits).
  const keywords = `(${SEARCH_CLAUSES.join(" OR ")})`;
  if (trackedSenders.length > 0) {
    return `(${trackedSenders.map((s) => `"from:${s}"`).join(" OR ")}) AND ${keywords}`;
  }
  return keywords;
}

export const OUTLOOK_PROVIDER: EmailSyncProvider = {
  dedupePrefix: "outlook",
  notesText: "Parsed from an Outlook message (fallback email sync).",
  filtersSinceDateClientSide: true,
  // Graph: "A $search request returns up to 1,000 results."
  maxSearchResults: 1000,
  buildSearchQuery,
  listCandidateMessageIds,
  async getMessage(externalUserId, pipedreamAccountId, messageId) {
    const message = await getMessage(externalUserId, pipedreamAccountId, messageId);
    if (!message) return null;

    const body = message.body?.content ?? "";
    const bodyText =
      message.body?.contentType?.toLowerCase() === "text" ? body : stripHtml(body);
    const plainText = message.hasAttachments
      ? await appendPdfAttachmentText(externalUserId, pipedreamAccountId, messageId, bodyText)
      : bodyText;

    const fromHeader = formatEmailAddress(message.from?.emailAddress);
    const replyToHeader = formatEmailAddress(message.replyTo?.[0]?.emailAddress);
    const authHeader = message.internetMessageHeaders?.find(
      (h) => h.name?.toLowerCase() === "authentication-results"
    )?.value;
    const authResults = parseAuthenticationResults(authHeader);

    // Defensive: a malformed `receivedDateTime` would silently produce an
    // Invalid Date (no error here) that can later crash a `.toISOString()`
    // call, or subtly break the oldest-to-newest sort in sync-engine.ts
    // (NaN comparisons never behave the way a real timestamp comparison
    // would) — falling back to "now" is a safe default instead.
    const receivedAt = parseGraphDateTime(message.receivedDateTime) ?? new Date();

    return {
      id: message.id,
      threadId: message.conversationId ?? null,
      receivedAt,
      subject: message.subject ?? null,
      plainText,
      fromHeader,
      replyToHeader,
      authResults,
    };
  },
};
