/**
 * In-memory per-user rate limiter (UI-Agent.4).
 *
 * Protects abuse-prone actions (connection attempts, verification, reconnect,
 * connect-token minting, chat) with a fixed-window counter keyed by the
 * authenticated user (falling back to IP for unauthenticated paths). Returns a
 * clean 429 `AppError` on breach — never a raw error.
 *
 * NOTE: single-process/in-memory by design (no new dependency). For a multi-
 * instance deployment this should move to a shared store (Redis) — tracked in
 * PRODUCTION-HARDENING. Mount AFTER `authenticate` so `req.user` is set.
 */
import { Request, Response, NextFunction } from "express";

import { AppError } from "@/utils/appError";

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per user per window. */
  max: number;
  /** Namespace so different actions get independent budgets. */
  key: string;
  /** Whose budget a request counts against: the authenticated user
   *  (default), or their active workspace — shared by all its members. */
  scope?: "user" | "organization";
}

export function rateLimit(options: RateLimitOptions) {
  const windows = new Map<string, Window>();

  const sweep = (now: number) => {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  };

  return (req: Request, _res: Response, next: NextFunction): void => {
    const who =
      (options.scope === "organization"
        ? req.organization?._id?.toString()
        : req.user?._id?.toString()) ??
      req.ip ??
      "anon";
    const bucketKey = `${options.key}:${who}`;
    const now = Date.now();

    // Opportunistic cleanup so the map cannot grow unbounded.
    if (windows.size > 5000) sweep(now);

    const current = windows.get(bucketKey);
    if (!current || current.resetAt <= now) {
      windows.set(bucketKey, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (current.count >= options.max) {
      next(
        new AppError(
          "Too many requests. Please slow down and try again shortly.",
          429
        )
      );
      return;
    }
    current.count += 1;
    next();
  };
}
