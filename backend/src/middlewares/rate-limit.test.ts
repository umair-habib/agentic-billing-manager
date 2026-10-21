import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { rateLimit } from "@/middlewares/rate-limit";
import { AppError } from "@/utils/appError";

/** Runs the middleware once and returns the status it rejected with, or "ok". */
function hit(
  limiter: ReturnType<typeof rateLimit>,
  userId: Types.ObjectId,
  organizationId: Types.ObjectId
): number | "ok" {
  const req = { user: { _id: userId }, organization: { _id: organizationId } } as unknown as Request;
  let outcome: number | "ok" = "ok";
  const next: NextFunction = (err?: unknown) => {
    if (err) outcome = err instanceof AppError ? err.statusCode : -1;
  };
  limiter(req, {} as Response, next);
  return outcome;
}

describe("rateLimit — agent chat limits (CLAUDE.md §10.3 P1-10 / S-10)", () => {
  it("per user: the 11th request inside the window gets 429", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 10, key: "test-user" });
    const userId = new Types.ObjectId();
    const orgId = new Types.ObjectId();

    const outcomes = Array.from({ length: 11 }, () => hit(limiter, userId, orgId));

    expect(outcomes.slice(0, 10).every((o) => o === "ok")).toBe(true);
    expect(outcomes[10]).toBe(429);
    // A different user has their own budget.
    expect(hit(limiter, new Types.ObjectId(), orgId)).toBe("ok");
  });

  it("per workspace: the budget is shared by all members of one workspace, not by other workspaces", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 30, key: "test-org", scope: "organization" });
    const orgId = new Types.ObjectId();

    // 30 requests from 30 different members of the same workspace...
    for (let i = 0; i < 30; i++) expect(hit(limiter, new Types.ObjectId(), orgId)).toBe("ok");
    // ...so the 31st, from yet another member, is over the shared limit.
    expect(hit(limiter, new Types.ObjectId(), orgId)).toBe(429);
    // Another workspace is unaffected.
    expect(hit(limiter, new Types.ObjectId(), new Types.ObjectId())).toBe("ok");
  });
});
