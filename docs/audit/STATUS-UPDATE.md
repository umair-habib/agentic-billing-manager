# Audit Status Update

**Checked against:** `HEAD 40e1582` (audit was written against `e3ad6ad`; 36 commits since)
**Date:** 2026-10-20
**Method:** read-only review of the current code. Every status below was verified in code, not taken from docs or commit messages. Line numbers are approximate pointers into the current files. No code was changed.

---

## 1. Summary

| | Count | Items |
|---|---|---|
| ✅ Fixed | 11 | P0-01, P0-02 (mostly), P0-03, P0-04, P1-01, P1-03, P1-04, P1-05, P1-07, P1-09, adapters/UsageAccrual |
| 🟡 Partially fixed | 3 | P0-02 rate limiting (S-04), P1-02 vendor search, P1-08 export (S-15) |
| 🔴 Still open | 2 | **P1-06 Outlook can skip mail**, **P1-10 credits can be overdrawn / agent chat unthrottled** |

The P0 list is effectively closed. What still blocks launch: Outlook correctness, AI-spend controls, rate limiting that only lives in one process's memory, and the manual production steps (indexes, Stripe).

---

## 2. P0 findings

| ID | Status | Evidence (current code) | Still missing |
|---|---|---|---|
| **P0-01 / S-01** Indexes never built in prod | ✅ FIXED (fail-fast) | `config/index-integrity.ts:103-108` `assertIndexesInSync()` refuses to boot if any declared index is missing; called at `server.ts:50-51`. `scripts/sync-indexes.ts --apply` builds them (with duplicate check). `database.ts:40` `autoIndex: !isProduction` unchanged. | Prod still does not auto-build. **First deploy must run `npx tsx scripts/sync-indexes.ts --apply`** (or boot once with `SYNC_INDEXES_ON_BOOT=true`). |
| **P0-02 / S-02** OTP uses `Math.random` | ✅ FIXED | `controllers/auth.controller.ts:84` `String(randomInt(100000, 1000000))` (node:crypto) | — |
| **P0-02 / S-03** Non-atomic attempt counter | ✅ FIXED | `auth.controller.ts:127-128` `findOneAndUpdate({ _id, attempts: { $lt: OTP_MAX_ATTEMPTS } }, { $inc: { attempts: 1 } })` | — |
| **P0-02 / S-04** OTP routes not rate-limited | 🟡 PARTIAL | `routes/auth.routes.ts:45-61` limiters on register/login request-otp (5/10 min) and verify-otp (20/10 min) | Limiter store is an **in-memory Map** (`middlewares/rate-limit.ts:32`): resets on restart, not shared across instances. IP-only key (no per-email limit). `/email/request-otp` (change-email) has no limiter. |
| **P0-02 / S-14** No `trust proxy` | ✅ FIXED | `app.ts:25` `app.set("trust proxy", 1)` | Correct only with exactly one proxy hop (verify on the host). |
| **S-12** Login user enumeration | ✅ FIXED | `auth.controller.ts:220-229` same message whether or not the account exists | Timing differs slightly (email only sent for real accounts). |
| **P0-03** Email sync re-extracts the same 200 emails forever | ✅ FIXED | `models/processed-message.model.ts:69` unique `{connection, messageId}` (180-day TTL); `services/email-sync/sync-engine.ts:276-281` skips already-processed messages **before** the 200 cap (`:283`) | Depends on the ProcessedMessage index existing (see P0-01). |
| **P0-04 / S-05** No revenue path; free self-upgrade | ✅ FIXED | `controllers/plan.controller.ts:83-85` rejects any non-Free tier via `PUT /api/plan`; paid tier only set by Stripe at `services/payments/stripe-subscription.service.ts:225`. Webhook at `app.ts:51`, signature-verified (`stripe-webhook.controller.ts:28-30`), idempotent (`stripe-processed-event.model.ts`). | Needs live Stripe keys + `STRIPE_PRICE_PRO/BUSINESS` + webhook endpoint configured in prod. Without them, checkout returns 503. |

---

## 3. P1 findings

| ID | Status | Evidence (current code) | Still missing |
|---|---|---|---|
| **P1-01 / S-06** Prompt injection in email extraction | ✅ FIXED | `email-sync/ai-invoice-extractor.ts:43` system prompt marks `<email>` content as UNTRUSTED; `:184` content wrapped in `<email>` tags; `:199-203` `sanitizeExtractedText()` on output | Defense is framing + sanitizing; no strict allowlist validation of field values. |
| **S-07** Second-order injection into agent context | ✅ FIXED | `agent/managed-agent.service.ts:376` `JSON.stringify(sanitizeForAgentContext(result))` | — |
| **S-08** Sender spoofing (no SPF/DKIM/DMARC) | ✅ FIXED (soft) | `email-sync/parser.ts:135-149` parses Authentication-Results; `:166-180` −0.4 confidence on DMARC fail or Reply-To mismatch; sender-trust loop (`models/sender-profile.model.ts`, `sender-trust.service.ts`) | Penalty only, never blocks. SPF/DKIM results parsed but unused. |
| **P1-02** "Show invoices from AWS" fails (vendor model inverted) | 🟡 PARTIAL | `models/vendor.model.ts` exists; `billing.model.ts:54,211-221` `vendorName`, `vendor` ref, `vendorDomain`; agent tool `ai/tools/billing-search.tool.ts:94` searches `customerName`, `vendorName`, `vendorDomain` | Tool has no dedicated `vendor` param (reuses `customerName`). Frontend search `billing/billing-view.tsx:136-138` matches customerName/invoiceNumber/platform.name, **not `vendorName`**. |
| **P1-03** No provenance | ✅ FIXED (mostly) | `billing.model.ts:99-119, 290-333` `sourceMessageId`, `sourceThreadId`, `senderEmail`, `senderDomain`, `receivedAt`, `subject`, `extractionConfidence`, `extractionModel`, `extractedAt`, `evidence[]`; `duplicateOf` `:162` | `paymentDate`, `supersedes`, explicit `statusSetBy` absent (`derivedStatusBasis` partly covers it). |
| **P1-04** Status = single-email LLM guess, no history | ✅ FIXED (email_sync) | `models/billing-event.model.ts` append-only observation log; `services/billing/status-machine.ts:136` `deriveStatus()`; `sync-engine.ts:466-470` writes the derived status to `status` | Append-only by convention (no update/delete guard). Status write is best-effort (`.catch(() => {})`). Only email_sync uses it. |
| **P1-05** No PDF / attachment parsing | ✅ FIXED | `email-sync/pdf-extractor.ts` (unpdf), 4,000-char cap; max 3 PDFs per message (`parser.ts:73`, `outlook-provider.ts:19`) | No byte-size / page / timeout limit before parsing; no OCR for scanned PDFs. |
| **P1-06** Outlook sync may silently skip mail | 🔴 **STILL OPEN** | `email-sync/outlook-provider.ts:96` `sortedNewestFirstUnfiltered: true`; `outlook-client.ts:68` uses `$search` (relevance-ranked, no `$orderby`/delta); `sync-engine.ts:308` sets `stoppedEarly` on the first older message, and the watermark still advances (`:507` condition ignores `stoppedEarly`) | Newer mail ranked below an older message can be skipped permanently. Fix with Graph delta queries or `$filter=receivedDateTime ge …&$orderby=…`. Must be tested against a real mailbox. |
| **P1-07 / S-09** Encryption key falls back to JWT secret | ✅ FIXED | `utils/crypto.ts:57-63` key required (boot check at `server.ts:43`); `:73` HKDF-SHA256 with per-payload salt; `:51` versioned payload `v2` | No multi-key decrypt yet, so rotation still needs a re-encrypt migration. |
| **P1-08** Unbounded list/export, missing indexes | 🟡 MOSTLY FIXED | `billing.controller.ts:111-112` list paginated; export capped `:45` `EXPORT_SAFETY_LIMIT = 20_000`; compound indexes `billing.model.ts:422-423`; `dueDate` indexed | **S-15:** `/billing/export` has no rate limit and no audit-log entry; loads up to 20k docs in memory. `autoMarkOverdue` not batched. |
| **P1-09** Mixed currencies summed as one number | ✅ FIXED | `billing.controller.ts:320-329` groups by currency → `revenueByCurrency`; `overview-view.tsx:165,218` labels currency and shows "+ N more currencies" | No FX/reporting currency; trend/per-platform charts show the primary currency only (now labelled). |
| **P1-10 / S-10** Credit accounting can be outrun | 🔴 **PARTIAL / OPEN** | Fixed: `consumeCredits` now awaited (`managed-agent.service.ts:272,468`); tool loop capped 8/12 (`:88-89`); cache tokens + session-hour runtime billed (`config/credits.ts:130-136`); fresh balance read (`utils/credits.ts:35`); monthly cycle for all plans (`config/credits.ts:68-72`) | **No reservation / atomic check-and-deduct**, so concurrent requests can overdraw. **`/api/agent/chat` has no rate limiter** (`routes/agent-chat.routes.ts:13`). Ledger write errors swallowed (`credit-ledger.service.ts:70-73`). Stale comment `:80` says "yearly". |
| **§10.3** 129 adapters aren't invoices / double-counting | ✅ FIXED (structurally) | `models/usage-accrual.model.ts`; `billing-sync/types.ts:35` `kind: "invoice" \| "usage_accrual"`; 124 adapters → `UsageAccrual`, 5 → `Billing`; shared `resolveVendor` + `billing-duplicate-detector.service.ts` flags cross-channel duplicates | Duplicates are **flagged** for the user to merge, not auto-merged. |

---

## 4. New since the audit

| Feature | What it does | Key files |
|---|---|---|
| **Stripe** | Buy credit packs ($5 / $10 / $25) and subscribe to Pro/Business via Stripe Checkout. Signed, idempotent webhook sets plan tier and credits. Boot refuses a live key (`sk_live_`) outside production. | `services/payments/stripe-checkout.service.ts`, `stripe-subscription.service.ts`, `controllers/stripe-webhook.controller.ts`, `config/credit-packages.ts`, `frontend/.../plan/credits/buy-credits-dialog.tsx` |
| **Google sign-in** | "Continue with Google" button; backend verifies the Google ID token (client ID only, no secret), requires a verified email, then uses the same session path as OTP. | `auth.controller.ts` `googleSignIn`, `frontend/.../auth/google-sign-in-button.tsx` |
| **Index integrity check** | Boot fails if any declared Mongo index is missing (closes S-01). Optional sync on boot; separate script builds indexes after a duplicate check. | `config/index-integrity.ts`, `scripts/sync-indexes.ts` |
| **UsageAccrual split** | Usage/balance data from adapters is stored separately from real invoices, so it no longer inflates "outstanding". | `models/usage-accrual.model.ts`, `controllers/usage-accrual.controller.ts` |
| **Audit log** | Records financial mutations (billing edits/deletes). | `models/audit-log.model.ts`, `services/billing/audit-log-recorder.service.ts` |
| **Data export / retention / account deletion** | "Export my data"; account deletion runs in a transaction; consent copy before OAuth. | `organization.controller.ts` |
| **Sender-trust loop** | Learns trusted/suppressed senders from user actions; affects extraction confidence. | `email-sync/sender-trust.service.ts`, `models/sender-profile.model.ts` |
| **Duplicates + confirm vendors** | Flags duplicate invoices across channels; user confirms detected vendors. | `services/billing/billing-duplicate-detector.service.ts`, `services/vendors/vendor-resolver.service.ts` |
| **Agent intent router** | Answers simple data questions deterministically, without calling Claude (saves credits). Agent sessions are org-scoped. | `services/ai/intent-router.service.ts` |
| **Slack per-org OAuth** | Each org installs the Slack app into its own workspace; one-click alert webhooks. | `services/slack/slack-oauth.service.ts` |
| **Sync frequency** | Per-connection sync schedule configurable on the Automation page. | `services/platform-connections/sync-schedule.ts`, `frontend/.../automation/automation-view.tsx` |
| **RBAC on billing** | Member role can no longer edit/delete billing records (closes S-13). | billing routes/controller |
| **CI + tests** | GitHub Actions: backend type-check, lint, build, **51 test files** (Vitest + in-memory Mongo); frontend type-check, lint, build, **0 tests**. | `.github/workflows/ci.yml` |

---

## 5. Pipedream dependency inventory

Core helper: `backend/src/services/integrations/pipedream.ts` (`getAccessToken`, `connectProxyRequest`, `createConnectToken`, `getAccount`, `searchApps`, `warmCatalogCache`). Env: `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_ENVIRONMENT`.

### 5.1 Email sync (to be replaced by direct Gmail API + Microsoft Graph)

| Layer | Files | Pipedream coupling |
|---|---|---|
| HTTP clients | `email-sync/gmail-client.ts`, `outlook-client.ts` | **All** Gmail/Graph calls (incl. attachment download) go through `connectProxyRequest` |
| Providers | `gmail-provider.ts`, `outlook-provider.ts`, `provider.ts` (`EmailSyncProvider`) | Interface methods take `pipedreamAccountId` |
| Engine / registry | `sync-engine.ts`, `registry.ts`, `scheduler.ts` | Reads `metadata.pipedreamAccountId`; platform slugs `gmail` / `microsoft_outlook` are Pipedream app slugs |
| Data model | `models/platform-connection.model.ts` | Stores `metadata.pipedreamAccountId`, `metadata.pipedreamApp`; `connectedBy` doubles as Pipedream `external_user_id` |
| Backend connect flow | `controllers/platform-connection.controller.ts` (`createPipedreamConnectToken`, `connectViaPipedream`, verify handler), `routes/platform-connection.routes.ts` | OAuth is Pipedream-managed; Pipedream holds the tokens |
| Frontend | `hooks/use-pipedream-connect.ts` (`@pipedream/sdk/browser`), `platforms/platforms-view.tsx`, `email-privacy-consent-dialog.tsx`, `connect-platform-dialog.tsx` | Popup via `connectAccount` |

### 5.2 Platform / billing-sync adapters (stay on Pipedream)

- **129 of 129** adapters in `services/billing-sync/adapters/` call `connectProxyRequest`; `billing-sync/registry.ts` looks up by Pipedream slug; `billing-sync/sync-engine.ts` requires `pipedreamAccountId`.
- **Not Pipedream:** 4 native API-key adapters in `services/integrations/adapters/` (anthropic, gemini, openai, openrouter).
- **Capability resolver** `services/integrations/capability-resolver.ts` merges native adapters with the live Pipedream catalog; `warmCatalogCache()` runs at boot.

### 5.3 Other

- Agent: `agent/agent-tools.ts` → capability resolver; `connect_platform` action carries `source: "native" | "pipedream"`.
- Frontend: `lib/platform-catalog.ts`, `services/connections/platform-connections.service.ts`.
- Tests: `integrations/pipedream-proxy-error.test.ts`, `models/platform-connection-reconnect.test.ts`.
- No Pipedream webhooks are used.

### 5.4 What the email migration needs

- **Easier:** the `EmailSyncProvider` abstraction keeps the engine, parser, AI extractor and sender trust provider-agnostic. Only the two clients talk to Pipedream.
- **Must build:** Google + Microsoft OAuth (consent + callback routes), encrypted refresh-token storage (reuse `utils/crypto.ts`), token refresh, new env vars; rename `pipedreamAccountId` to a provider-neutral connection/token reference; a migration or re-consent flow for existing connections; replace `usePipedreamConnect` for email with a redirect flow.
- **Bonus:** direct Graph access allows **delta queries**, which also fixes P1-06. Gmail `history.list` gives true incremental sync.
- **Risk:** Gmail's restricted `gmail.readonly` scope requires Google's security assessment (CASA) before public launch; Microsoft needs publisher verification.
- Pipedream itself stays (129 adapters + catalog), so `pipedream.ts` and its env vars remain.

---

## 6. Next 10 tasks (prioritized)

| # | Task | Why | Files affected | Effort | Blocks launch? |
|---|---|---|---|---|---|
| 1 | **Fix Outlook skipping mail** (delta query or `$filter` + `$orderby`; don't advance the watermark after an early stop) | Silent data loss for Outlook users (P1-06) | `email-sync/outlook-client.ts`, `outlook-provider.ts`, `sync-engine.ts` | M | **Yes** (or hide Outlook until fixed) |
| 2 | **Agent spend controls**: rate-limit `/api/agent/chat`; atomic reserve-then-reconcile credits | Concurrent requests can overdraw credits, so AI cost is unbounded (P1-10) | `routes/agent-chat.routes.ts`, `utils/credits.ts`, `services/credits/credit-ledger.service.ts`, `agent/managed-agent.service.ts` | M | **Yes** |
| 3 | **Durable rate limiting** (Mongo/Redis store, per-email + per-IP; cover `/email/request-otp`) | In-memory limiter resets on restart and isn't shared; OTP is the only credential (S-04) | `middlewares/rate-limit.ts`, `routes/auth.routes.ts` | S–M | **Yes** |
| 4 | **Production launch runbook**: run `sync-indexes --apply`, configure live Stripe keys/prices/webhook, verify `trust proxy` hop count | App refuses to boot without indexes; no revenue without Stripe config | `scripts/sync-indexes.ts`, deploy config, docs | S | **Yes** |
| 5 | **Fix frontend lockfile drift** (`npm ci` fails; `npm install` drops `react-is`, which breaks the dashboard charts) | Builds aren't reproducible; a fresh install broke the dashboard during local setup | `frontend/package-lock.json` (regenerate + commit) | S | **Yes** (deploy reliability) |
| 6 | **Direct Gmail API + Microsoft Graph** for email sync (replace Pipedream for email) | Planned; cheaper, true incremental sync, removes proxy dependency, and resolves #1 properly | See §5.1 / §5.4 | L | No (strategic; CASA timeline is the long pole) |
| 7 | **Harden export** (S-15): rate limit, audit-log entry, stream instead of 20k in memory | A stolen token can dump all financial data in one request | `controllers/billing.controller.ts`, `routes/billing.routes.ts` | S | Recommended |
| 8 | **PDF safety limits**: max bytes, page count, parse timeout before `unpdf` | Hostile/huge attachments can stall the sync worker | `email-sync/pdf-extractor.ts`, `gmail-client.ts`, `outlook-client.ts` | S | No |
| 9 | **Finish vendor search** (P1-02): search `vendorName` in the Billing UI; add a `vendor` param to `search_billing_records` (keep `sync-agent-config.ts` in sync) | "Show me AWS invoices" is the core query | `frontend/.../billing/billing-view.tsx`, `ai/tools/billing-search.tool.ts`, `scripts/sync-agent-config.ts` | S | No |
| 10 | **Frontend tests + docs refresh**: Playwright smoke (login → billing → agent), add frontend tests to CI; rewrite stale `ARCHITECTURE.md` (LangGraph/Qwen), backend/frontend READMEs, fix "yearly" comment in `credit-ledger.service.ts:80` | 0 frontend tests; docs mislead new contributors | `frontend/`, `.github/workflows/ci.yml`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, READMEs | M | No |

**Also worth a decision (not ranked):** BillingEvent append-only enforcement, multi-key decrypt for key rotation, using SPF/DKIM (not just DMARC) in sender trust, and FX/reporting currency.
