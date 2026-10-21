import { Router } from "express";

import { agentChat, resetAgentChat } from "@/controllers/agent-chat.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { rateLimit } from "@/middlewares/rate-limit";
import { validate } from "@/middlewares/validate";
import { agentChatSchema } from "@/validators/agent-chat.validator";

const router = Router();

// CLAUDE.md §10.3 P1-10 / S-10 — every message can cost real AI credits.
// In-memory like every limiter in rate-limit.ts (single instance only).
const perUserLimiter = rateLimit({ windowMs: 60_000, max: 10, key: "agent-chat-user" });
const perWorkspaceLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  key: "agent-chat-org",
  scope: "organization",
});

// All agent chat endpoints require a valid Bearer token.
router.use(authenticate);

router.post("/", perUserLimiter, perWorkspaceLimiter, validate(agentChatSchema), agentChat);
router.delete("/", resetAgentChat);

export default router;
