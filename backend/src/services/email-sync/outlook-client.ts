/**
 * Thin Microsoft Graph (Outlook mail) wrapper over the Pipedream Connect proxy —
 * mirrors gmail-client.ts's shape. Outlook was connected through the SAME
 * generic Pipedream-managed OAuth flow as every other platform (the
 * `microsoft_outlook` app); Pipedream vaults the Microsoft OAuth token, this
 * app never sees it. Calls go through `connectProxyRequest`, which injects
 * that token and proxies the request to Graph's own API.
 */
import { connectProxyRequest } from "@/services/integrations/pipedream";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0/me";

export interface OutlookMessage {
  id: string;
  /** Graph's thread-equivalent — groups a message with its replies. */
  conversationId?: string;
  receivedDateTime?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  replyTo?: { emailAddress?: { name?: string; address?: string } }[];
  /** Raw MIME headers — only populated when `$select` includes
   *  `internetMessageHeaders`; used to read `Authentication-Results`
   *  (Task 9, S-08), which Graph doesn't expose as its own structured field. */
  internetMessageHeaders?: { name?: string; value?: string }[];
  /** WP-6 — whether this message has any attachments at all, so a PDF
   *  lookup only makes a second call when there's something to find. */
  hasAttachments?: boolean;
}

export interface OutlookAttachment {
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  /** Base64-encoded bytes — Graph inlines these directly in the attachment
   *  list response for a `#microsoft.graph.fileAttachment` (unlike Gmail,
   *  no separate per-attachment call is needed). */
  contentBytes?: string;
}

export interface OutlookListPage {
  messageIds: string[];
  /** The full `@odata.nextLink` URL — opaque to the caller, just like Gmail's pageToken. */
  nextPageToken?: string;
  /** Each listed message's received time (UTC), when Graph returned a valid one. */
  receivedAtById: Record<string, Date>;
}

interface RawListResponse {
  value?: { id?: string; receivedDateTime?: string }[];
  "@odata.nextLink"?: string;
}

/** Graph's DateTimeOffset values are UTC ("…Z") by default, but a value
 *  without any zone designator would be read by `new Date()` as LOCAL time —
 *  so treat a zone-less value as UTC explicitly. Null if missing/invalid. */
export function parseGraphDateTime(value: string | undefined): Date | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const parsed = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Lists message ids matching a KQL `$search` query (see
 * services/email-sync/outlook-provider.ts for how the query is built).
 * `$search` on /me/messages doesn't support `$skip` — paging beyond the first
 * page relies entirely on the opaque `@odata.nextLink` Graph returns.
 */
export async function listCandidateMessageIds(
  externalUserId: string,
  pipedreamAccountId: string,
  query: string,
  maxResults: number,
  pageToken?: string
): Promise<OutlookListPage> {
  const url =
    pageToken ??
    `${GRAPH_API_BASE}/messages?${new URLSearchParams({
      $search: query,
      $top: String(maxResults),
      $select: "id,receivedDateTime",
    }).toString()}`;

  const data = (await connectProxyRequest(
    externalUserId,
    pipedreamAccountId,
    url
  )) as RawListResponse | null;

  const messageIds: string[] = [];
  const receivedAtById: Record<string, Date> = {};
  for (const m of data?.value ?? []) {
    if (!m.id) continue;
    messageIds.push(m.id);
    const receivedAt = parseGraphDateTime(m.receivedDateTime);
    if (receivedAt) receivedAtById[m.id] = receivedAt;
  }

  return { messageIds, nextPageToken: data?.["@odata.nextLink"], receivedAtById };
}

/** Fetches one message's subject/body/sender/received date. Null on any
 *  failure — one unreachable message must never abort the whole sync run. */
export async function getMessage(
  externalUserId: string,
  pipedreamAccountId: string,
  messageId: string
): Promise<OutlookMessage | null> {
  try {
    const params = new URLSearchParams({
      $select:
        "subject,body,from,receivedDateTime,conversationId,replyTo,internetMessageHeaders,hasAttachments",
    });
    const data = (await connectProxyRequest(
      externalUserId,
      pipedreamAccountId,
      `${GRAPH_API_BASE}/messages/${encodeURIComponent(messageId)}?${params.toString()}`
    )) as OutlookMessage | null;
    return data?.id ? data : null;
  } catch {
    return null;
  }
}

interface RawAttachmentListResponse {
  value?: OutlookAttachment[];
}

/** Lists a message's attachments, with their bytes already inlined (Graph's
 *  `fileAttachment` type returns `contentBytes` directly in this response,
 *  unlike Gmail's separate per-attachment fetch). Null on any failure — one
 *  unreachable attachment list must never abort the message it belongs to. */
export async function getAttachments(
  externalUserId: string,
  pipedreamAccountId: string,
  messageId: string
): Promise<OutlookAttachment[]> {
  try {
    const data = (await connectProxyRequest(
      externalUserId,
      pipedreamAccountId,
      `${GRAPH_API_BASE}/messages/${encodeURIComponent(messageId)}/attachments`
    )) as RawAttachmentListResponse | null;
    return data?.value ?? [];
  } catch {
    return [];
  }
}
