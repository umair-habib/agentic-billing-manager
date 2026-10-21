/**
 * Handles one inbound Slack DM event end-to-end: dedupe → resolve the
 * sender's linked app account (or walk them through linking one) → run the
 * same Billing Advisor Agent turn the web UI uses → reply in Slack.
 *
 * Entry point for `controllers/slack.controller.ts`'s Events webhook, which
 * has already resolved WHICH organization this event belongs to (by the
 * event's `team_id` matching that organization's own connected
 * `slackWorkspace` — see slack-oauth.service.ts) before calling in here, so
 * everything below is scoped to one specific organization's own Slack
 * workspace, never a single global bot. Kept separate from the controller so
 * the controller stays a thin verify-and-ACK layer (Slack needs a fast 200;
 * this can take as long as an Agent turn does).
 */
import { randomInt } from "node:crypto";
import { Types } from "mongoose";

import { AppError } from "@/utils/appError";
import { decryptSecret } from "@/utils/crypto";
import { User, type UserDocument } from "@/models/user.model";
import { Membership } from "@/models/membership.model";
import { SlackProcessedEvent } from "@/models/slack-processed-event.model";
import type { OrganizationDocument } from "@/models/organization.model";
import { sendAgentMessage, type AgentAction } from "@/services/agent/managed-agent.service";
import { tryRouteDeterministically } from "@/services/ai/intent-router.service";
import { postSlackMessage } from "@/services/slack/slack-web-api";

const LINK_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O, 1/I
const LINK_CODE_LENGTH = 6;
export const LINK_CODE_TTL_MINUTES = 10;

/** Generates and stores a fresh link code for a user's "Connect Slack" click
 *  — scoped to ONE organization (whichever is active when they click), since
 *  redeeming it links this user's identity in THAT organization's specific
 *  connected Slack workspace, not a global identity. */
export async function generateSlackLinkCode(
  user: UserDocument,
  organizationId: string
): Promise<{ code: string; expiresInMinutes: number }> {
  const code = Array.from(
    { length: LINK_CODE_LENGTH },
    () => LINK_CODE_CHARS[randomInt(LINK_CODE_CHARS.length)]
  ).join("");
  user.slackLinkCode = code;
  user.slackLinkCodeExpiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  user.slackLinkOrganizationId = new Types.ObjectId(organizationId);
  await user.save();
  return { code, expiresInMinutes: LINK_CODE_TTL_MINUTES };
}

/** Atomically claims one event id via the model's unique index — returns
 *  false when it's a Slack retry of an event already handled. */
async function claimEvent(eventId: string): Promise<boolean> {
  try {
    await SlackProcessedEvent.create({ eventId });
    return true;
  } catch {
    return false;
  }
}

/** Matches a DM's text against a pending link code — valid only when it was
 *  generated FOR this exact organization (the one whose Slack workspace this
 *  DM arrived in), this Slack identity isn't already linked to someone else
 *  IN THIS workspace, and the code's owner is still actually a member of
 *  this organization (could have been removed since generating it). */
async function tryLinkByCode(
  organization: OrganizationDocument,
  teamId: string,
  slackUserId: string,
  rawText: string
): Promise<boolean> {
  const code = rawText.trim().toUpperCase();
  if (!code) return false;

  const candidate = await User.findOne({
    slackLinkCode: code,
    slackLinkCodeExpiresAt: { $gt: new Date() },
    slackLinkOrganizationId: organization._id,
  });
  if (!candidate) return false;

  const isMember = await Membership.exists({ user: candidate._id, organization: organization._id });
  if (!isMember) return false;

  const alreadyLinked = await User.findOne({
    slackLinks: { $elemMatch: { teamId, slackUserId } },
  });
  if (alreadyLinked) return false;

  candidate.slackLinks.push({ teamId, slackUserId, organization: organization._id });
  candidate.slackLinkCode = undefined;
  candidate.slackLinkCodeExpiresAt = undefined;
  candidate.slackLinkOrganizationId = undefined;
  await candidate.save();
  return true;
}

/** Slack DMs get a plain-text hint instead of the app's clickable confirm
 *  button (Slack has no equivalent interactive element wired up here) —
 *  always point back to the app to actually complete a connect/update/delete
 *  action, and never describe a specific UI element the model might invent
 *  (see billing-actions.tool.ts's own note on this). */
function actionHint(action: AgentAction): string {
  switch (action.type) {
    case "connect_platform":
      return `🔗 *${action.displayName}* ko connect karne ke liye app kholein: Platforms → Connect.`;
    case "update_billing_status":
      return `📋 Invoice *${action.invoiceNumber}* (${action.customerName}) ko *${action.newStatus}* mark karne ke liye app ke Billing Agent chat mein confirm karein.`;
    case "delete_billing_record":
      return `🗑️ Invoice *${action.invoiceNumber}* (${action.customerName}) delete karne ke liye app ke Billing Agent chat mein confirm karein.`;
  }
}

export interface SlackMessageEvent {
  channel: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

/** `organization` is already resolved by the caller (slack.controller.ts)
 *  from the event's `team_id` — everything here reads/writes scoped to it. */
export async function handleSlackChatEvent(
  eventId: string,
  event: SlackMessageEvent,
  organization: OrganizationDocument
): Promise<void> {
  const isNew = await claimEvent(eventId);
  if (!isNew) return; // Slack retry of an event we already handled

  // Ignore the bot's own messages and anything that isn't a plain human DM
  // (joins, edits, deletes, etc. all carry a `subtype`).
  if (!event.user || event.bot_id || event.subtype) return;

  const text = (event.text ?? "").trim();
  if (!text) return;

  const workspace = organization.slackWorkspace;
  if (!workspace) return; // shouldn't happen — the controller only gets here via a matched teamId
  const botToken = decryptSecret(workspace.botToken);
  const reply = (message: string) => postSlackMessage(botToken, event.channel, message);

  try {
    const user = await User.findOne({
      slackLinks: { $elemMatch: { teamId: workspace.teamId, slackUserId: event.user } },
    });

    if (!user) {
      const linked = await tryLinkByCode(organization, workspace.teamId, event.user, text);
      await reply(
        linked
          ? "✅ Connected! Ab aap yahan seedha Billing Advisor se baat kar sakte hain — koi bhi sawal poochein."
          : 'Mujhe abhi aapki pehchan nahi hui. App mein *Settings → Notifications* pe jaake "Connect Slack" dabayein, phir wahan mila code yahan bhej dein.'
      );
      return;
    }

    // WP-7 intent router — same reasoning as the web chat controller: tried
    // before the credit reservation, so a deterministic answer works even when
    // this workspace is out of AI credits.
    const routed = await tryRouteDeterministically(organization._id.toString(), text);
    if (routed) {
      await reply(routed.reply);
      return;
    }

    // Credits are reserved inside sendAgentMessage — same 403 when out.
    const { reply: agentReply, action } = await sendAgentMessage(user._id, organization._id, text);
    await reply(action ? `${agentReply}\n\n${actionHint(action)}` : agentReply);
  } catch (err) {
    // A DM sent while this user's previous question is still being answered
    // (409 from agent-concurrency.ts) — a friendly nudge, not a ⚠️ error.
    if (err instanceof AppError && err.statusCode === 409) {
      await reply(
        "⏳ Still working on your previous question — I'll reply to it first. Send this one again once you have that answer."
      ).catch(() => {
        // Best-effort — nothing else to do if even this reply fails.
      });
      return;
    }
    const message =
      err instanceof AppError ? err.message : "Mujhe jawab dete waqt masla hua, dobara try karein.";
    await reply(`⚠️ ${message}`).catch(() => {
      // Best-effort — if even the error reply fails, there's nothing else to do.
    });
  }
}
