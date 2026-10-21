import { Types } from "mongoose";
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";

import { env } from "@/config/env";
import { Organization } from "@/models/organization.model";
import { CreditTransaction } from "@/models/credit-transaction.model";
import { CreditReservation } from "@/models/credit-reservation.model";
import { AppError } from "@/utils/appError";

const sessionsCreateMock = vi.fn();
const eventsStreamMock = vi.fn();
const eventsSendMock = vi.fn();
const sessionsArchiveMock = vi.fn();
const sessionsRetrieveMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    beta = {
      sessions: {
        create: sessionsCreateMock,
        retrieve: sessionsRetrieveMock,
        archive: sessionsArchiveMock,
        events: { stream: eventsStreamMock, send: eventsSendMock },
      },
    };
  },
}));

// Short timeouts so the timeout/interrupt paths run in milliseconds; every
// other credit setting (25-credit reservation, 3 per workspace) is real.
vi.mock("@/config/credits", async () => {
  const actual = await vi.importActual<typeof import("@/config/credits")>("@/config/credits");
  return { ...actual, AGENT_TURN_TIMEOUT_MS: 50, AGENT_INTERRUPT_DRAIN_MS: 200 };
});

import { sendAgentMessage, runAgentPrompt } from "@/services/agent/managed-agent.service";
import { settleReservation, reserveCredits } from "@/services/credits/credit-ledger.service";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function usageEvent(input: number, output: number) {
  return {
    type: "span.model_request_end",
    model_usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
const REPLY = { type: "agent.message", content: [{ type: "text", text: "Here you go." }] };
const DONE = { type: "session.status_idle", stop_reason: { type: "end_turn" } };

/** Async event stream; `delayMs` before the first event makes turns overlap. */
function fakeStream(events: unknown[], delayMs = 0): AsyncGenerator<unknown> {
  return (async function* () {
    if (delayMs) await sleep(delayMs);
    for (const event of events) yield event;
  })();
}

async function orgWith(creditsBalance: number) {
  const organization = await Organization.create({ name: "Spend Test Org", creditsBalance });
  return organization._id;
}

/** The ledger invariant the nightly reconciliation job checks. */
async function ledgerSum(organizationId: Types.ObjectId, startingBalance: number) {
  const rows = await CreditTransaction.find({ organization: organizationId });
  return startingBalance + rows.reduce((sum, row) => sum + row.amount, 0);
}

function statusOf(result: PromiseSettledResult<unknown>): number | "ok" {
  if (result.status === "fulfilled") return "ok";
  return result.reason instanceof AppError ? result.reason.statusCode : -1;
}

describe("Billing Advisor Agent spend controls (CLAUDE.md §10.3 P1-10 / S-10)", () => {
  const original = {
    anthropicApiKey: env.anthropicApiKey,
    anthropicAgentId: env.anthropicAgentId,
    anthropicEnvironmentId: env.anthropicEnvironmentId,
  };

  beforeAll(() => {
    (env as unknown as { anthropicApiKey: string }).anthropicApiKey = "sk-ant-test";
    (env as unknown as { anthropicAgentId: string }).anthropicAgentId = "agent_test";
    (env as unknown as { anthropicEnvironmentId: string }).anthropicEnvironmentId = "env_test";
  });

  afterAll(() => {
    (env as unknown as { anthropicApiKey: string }).anthropicApiKey = original.anthropicApiKey;
    (env as unknown as { anthropicAgentId: string }).anthropicAgentId = original.anthropicAgentId;
    (env as unknown as { anthropicEnvironmentId: string }).anthropicEnvironmentId =
      original.anthropicEnvironmentId;
  });

  beforeEach(() => {
    for (const mock of [
      sessionsCreateMock,
      eventsStreamMock,
      eventsSendMock,
      sessionsArchiveMock,
      sessionsRetrieveMock,
    ]) {
      mock.mockReset();
    }
    sessionsCreateMock.mockImplementation(async () => ({ id: `sesn_${Math.random()}` }));
    sessionsArchiveMock.mockResolvedValue(undefined);
    eventsSendMock.mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("parallel requests with 1 credit left: exactly one turn runs, the rest are refused, nothing goes negative", async () => {
    const orgId = await orgWith(1);
    // 100 + 100 tokens → 1 credit, the same as what's left.
    eventsStreamMock.mockImplementation(async () =>
      fakeStream([usageEvent(100, 100), REPLY, DONE], 30)
    );

    // Five different members, so the per-session guard isn't what decides.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => sendAgentMessage(new Types.ObjectId(), orgId, "hi"))
    );

    const statuses = results.map(statusOf);
    expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
    // 3 slots per workspace: 2 turns get 429; of the 3 that start, only the
    // first can reserve the last credit, the other 2 get 403.
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(statuses.filter((s) => s === 403)).toHaveLength(2);
    expect(eventsStreamMock).toHaveBeenCalledTimes(1);

    const balance = (await Organization.findById(orgId))?.creditsBalance;
    expect(balance).toBe(0);
    expect(await ledgerSum(orgId, 1)).toBe(balance);
  });

  it("a second message in the same chat while a reply is in progress gets 409", async () => {
    const orgId = await orgWith(100);
    const userId = new Types.ObjectId();
    eventsStreamMock.mockImplementation(async () =>
      fakeStream([usageEvent(100, 100), REPLY, DONE], 30)
    );

    const results = await Promise.allSettled([
      sendAgentMessage(userId, orgId, "first"),
      sendAgentMessage(userId, orgId, "second"),
    ]);

    expect(results.map(statusOf).sort()).toEqual([409, "ok"]);
  });

  it("insufficient credits: 403 before any Claude call, and nothing written to the ledger", async () => {
    const orgId = await orgWith(0);

    await expect(sendAgentMessage(new Types.ObjectId(), orgId, "hi")).rejects.toMatchObject({
      statusCode: 403,
    });

    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(eventsStreamMock).not.toHaveBeenCalled();
    expect(await CreditTransaction.countDocuments({ organization: orgId })).toBe(0);
    expect(await CreditReservation.countDocuments({ organization: orgId })).toBe(0);
  });

  it("Claude fails before using any tokens: the whole reservation is refunded", async () => {
    const orgId = await orgWith(100);
    eventsStreamMock.mockResolvedValue(fakeStream([{ type: "session.error" }]));

    await expect(sendAgentMessage(new Types.ObjectId(), orgId, "hi")).rejects.toMatchObject({
      statusCode: 502,
    });

    expect((await Organization.findById(orgId))?.creditsBalance).toBe(100);
    const reservation = await CreditReservation.findOne({ organization: orgId });
    expect(reservation?.status).toBe("settled");
    expect(reservation?.actual).toBe(0);
    const types = (await CreditTransaction.find({ organization: orgId }).sort({ createdAt: 1 })).map(
      (row) => [row.type, row.amount]
    );
    expect(types).toEqual([
      ["consume", -25],
      ["refund", 25],
    ]);
  });

  it("Claude fails after using some tokens: only the real usage is charged", async () => {
    const orgId = await orgWith(100);
    eventsStreamMock.mockResolvedValue(
      fakeStream([usageEvent(100, 100), { type: "session.error" }])
    );

    await expect(sendAgentMessage(new Types.ObjectId(), orgId, "hi")).rejects.toThrow();

    expect((await Organization.findById(orgId))?.creditsBalance).toBe(99);
    expect(await ledgerSum(orgId, 100)).toBe(99);
  });

  it("settles to the real cost: refunds when cheaper than reserved, charges the overage when dearer", async () => {
    const cheap = await orgWith(100);
    eventsStreamMock.mockResolvedValueOnce(fakeStream([usageEvent(2000, 2000), REPLY, DONE]));
    await sendAgentMessage(new Types.ObjectId(), cheap, "small question");
    const cheapRes = await CreditReservation.findOne({ organization: cheap });
    expect(cheapRes?.reserved).toBe(25);
    expect(cheapRes?.actual).toBeLessThan(25);
    const cheapBalance = (await Organization.findById(cheap))?.creditsBalance;
    expect(cheapBalance).toBe(100 - (cheapRes?.actual ?? 0));
    expect(await CreditTransaction.countDocuments({ organization: cheap, type: "refund" })).toBe(1);
    expect(await ledgerSum(cheap, 100)).toBe(cheapBalance);

    const dear = await orgWith(100);
    eventsStreamMock.mockResolvedValueOnce(fakeStream([usageEvent(30_000, 30_000), REPLY, DONE]));
    await sendAgentMessage(new Types.ObjectId(), dear, "huge question");
    const dearRes = await CreditReservation.findOne({ organization: dear });
    expect(dearRes?.actual).toBeGreaterThan(25);
    const dearBalance = (await Organization.findById(dear))?.creditsBalance;
    expect(dearBalance).toBe(100 - (dearRes?.actual ?? 0));
    expect(await ledgerSum(dear, 100)).toBe(dearBalance);
  });

  it("settleReservation is idempotent: calling it twice never double-refunds or double-charges", async () => {
    const orgId = await orgWith(100);
    const handle = await reserveCredits(orgId, 25, "agent_message");
    if (!handle) throw new Error("reservation failed");

    await settleReservation(handle.reservationId, 5);
    await settleReservation(handle.reservationId, 5);
    await settleReservation(handle.reservationId, 0); // a different value doesn't sneak through either

    expect((await Organization.findById(orgId))?.creditsBalance).toBe(95);
    expect(await CreditTransaction.countDocuments({ organization: orgId, type: "refund" })).toBe(1);
    expect(await ledgerSum(orgId, 100)).toBe(95);
  });

  it("timeout: interrupts the session, waits for the final usage events, and charges them", async () => {
    const orgId = await orgWith(100);
    let signalInterrupt: () => void = () => {};
    const interruptSent = new Promise<void>((resolve) => {
      signalInterrupt = resolve;
    });
    eventsSendMock.mockImplementation(async (_id: string, payload: { events: Array<{ type: string }> }) => {
      if (payload.events[0]?.type === "user.interrupt") signalInterrupt();
    });
    // Nothing until the interrupt arrives, then the session's final usage.
    eventsStreamMock.mockResolvedValue(
      (async function* () {
        await interruptSent;
        yield usageEvent(100, 100);
        yield DONE;
      })()
    );

    await expect(sendAgentMessage(new Types.ObjectId(), orgId, "slow")).rejects.toMatchObject({
      statusCode: 504,
    });

    const interrupts = eventsSendMock.mock.calls.filter(
      (call) => (call[1] as { events: Array<{ type: string }> }).events[0]?.type === "user.interrupt"
    );
    expect(interrupts).toHaveLength(1);
    // The drained usage (1 credit) was charged, the rest of the reservation refunded.
    expect((await Organization.findById(orgId))?.creditsBalance).toBe(99);
  });

  it("timeout with a stream that never answers: gives up after the drain window and refunds everything", async () => {
    const orgId = await orgWith(100);
    // An iterator whose next() never resolves — a hung stream.
    eventsStreamMock.mockResolvedValue({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    });

    await expect(sendAgentMessage(new Types.ObjectId(), orgId, "hung")).rejects.toMatchObject({
      statusCode: 504,
    });
    expect((await Organization.findById(orgId))?.creditsBalance).toBe(100);
  });

  it("background recommendations at 0 credits are refused before any Claude call", async () => {
    const orgId = await orgWith(0);

    await expect(runAgentPrompt(new Types.ObjectId(), orgId, "recommend")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });
});
