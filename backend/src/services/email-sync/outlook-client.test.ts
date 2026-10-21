import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/integrations/pipedream", () => ({
  connectProxyRequest: vi.fn(),
}));

import { connectProxyRequest } from "@/services/integrations/pipedream";
import { listCandidateMessageIds, parseGraphDateTime } from "@/services/email-sync/outlook-client";

describe("parseGraphDateTime — always UTC (P1-06)", () => {
  it("keeps an explicit Z timestamp as-is", () => {
    expect(parseGraphDateTime("2026-10-19T09:00:00Z")?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });

  it("honors an explicit offset", () => {
    expect(parseGraphDateTime("2026-10-19T14:00:00+05:00")?.toISOString()).toBe(
      "2026-10-19T09:00:00.000Z"
    );
  });

  it("treats a zone-less value as UTC, not server-local time", () => {
    expect(parseGraphDateTime("2026-10-19T09:00:00")?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });

  it("returns null for a missing or invalid value", () => {
    expect(parseGraphDateTime(undefined)).toBeNull();
    expect(parseGraphDateTime("not a date")).toBeNull();
  });
});

describe("listCandidateMessageIds — returns each message's received time", () => {
  it("requests receivedDateTime and maps it per id; an id without a valid date is still listed", async () => {
    vi.mocked(connectProxyRequest).mockResolvedValue({
      value: [
        { id: "a", receivedDateTime: "2026-10-19T09:00:00Z" },
        { id: "b", receivedDateTime: "garbage" },
        { receivedDateTime: "2026-10-19T09:00:00Z" },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/next",
    });

    const page = await listCandidateMessageIds("user-1", "apn_1", '"subject:invoice"', 50);

    const requestedUrl = vi.mocked(connectProxyRequest).mock.calls[0]?.[2] as string;
    expect(new URL(requestedUrl).searchParams.get("$select")).toBe("id,receivedDateTime");
    expect(page.messageIds).toEqual(["a", "b"]);
    expect(page.receivedAtById.a?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
    expect(page.receivedAtById.b).toBeUndefined();
    expect(page.nextPageToken).toBe("https://graph.microsoft.com/next");
  });
});
