import { describe, expect, it, vi, beforeEach } from "vitest";

import { buildTestPdf } from "@/services/email-sync/test-helpers/build-test-pdf";

vi.mock("@/services/email-sync/outlook-client", async () => {
  const actual = await vi.importActual<typeof import("@/services/email-sync/outlook-client")>(
    "@/services/email-sync/outlook-client"
  );
  return {
    parseGraphDateTime: actual.parseGraphDateTime,
    listCandidateMessageIds: vi.fn(),
    getMessage: vi.fn(),
    getAttachments: vi.fn(),
  };
});

import { getMessage, getAttachments } from "@/services/email-sync/outlook-client";
import { OUTLOOK_PROVIDER } from "@/services/email-sync/outlook-provider";

/** WP-6 attachment recall — Outlook/Graph equivalent of the Gmail test.
 *  Graph inlines attachment bytes directly (no separate per-attachment
 *  fetch like Gmail needs), so this only tests the one real fetch path. */
describe("OUTLOOK_PROVIDER.getMessage — PDF attachment text gets appended to plainText", () => {
  beforeEach(() => {
    vi.mocked(getMessage).mockReset();
    vi.mocked(getAttachments).mockReset();
  });

  it("appends the PDF's extracted text when hasAttachments is true", async () => {
    const pdfBuffer = await buildTestPdf("Invoice OUT-500\nAmount Due: 42.00 GBP");

    vi.mocked(getMessage).mockResolvedValue({
      id: "msg-1",
      conversationId: "conv-1",
      receivedDateTime: new Date().toISOString(),
      subject: "Your statement",
      body: { contentType: "text", content: "See attached statement." },
      from: { emailAddress: { name: "Acme", address: "billing@acme.test" } },
      hasAttachments: true,
    });
    vi.mocked(getAttachments).mockResolvedValue([
      {
        name: "statement.pdf",
        contentType: "application/pdf",
        contentBytes: pdfBuffer.toString("base64"),
      },
    ]);

    const result = await OUTLOOK_PROVIDER.getMessage("user-1", "apn_test", "msg-1");

    expect(result?.plainText).toContain("See attached statement");
    expect(result?.plainText).toContain("OUT-500");
    expect(result?.plainText).toContain("42.00");
  });

  it("never calls getAttachments when hasAttachments is false", async () => {
    vi.mocked(getMessage).mockResolvedValue({
      id: "msg-2",
      receivedDateTime: new Date().toISOString(),
      body: { contentType: "text", content: "No attachment here." },
      hasAttachments: false,
    });

    const result = await OUTLOOK_PROVIDER.getMessage("user-1", "apn_test", "msg-2");

    expect(result?.plainText).toBe("No attachment here.");
    expect(getAttachments).not.toHaveBeenCalled();
  });

  it("ignores a non-PDF attachment (e.g. a Word document)", async () => {
    vi.mocked(getMessage).mockResolvedValue({
      id: "msg-3",
      receivedDateTime: new Date().toISOString(),
      body: { contentType: "text", content: "Contract attached, not an invoice." },
      hasAttachments: true,
    });
    vi.mocked(getAttachments).mockResolvedValue([
      {
        name: "contract.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBytes: Buffer.from("not a pdf").toString("base64"),
      },
    ]);

    const result = await OUTLOOK_PROVIDER.getMessage("user-1", "apn_test", "msg-3");

    expect(result?.plainText).toBe("Contract attached, not an invoice.");
  });
});
