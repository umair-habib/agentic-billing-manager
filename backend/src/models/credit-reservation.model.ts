/**
 * Credit reservation (CLAUDE.md §10.3 P1-10 / S-10) — one row per AI turn
 * that reserved credits up front (see credit-ledger.service.ts's
 * `reserveCredits`). The reserved amount is already debited through the
 * normal ledger the moment this row is created; `settleReservation` later
 * flips `status` from "open" to "settled" EXACTLY ONCE (an atomic
 * conditional update), which is what makes settling idempotent — a second
 * call finds nothing "open" and does nothing, so there's never a double
 * refund or a double charge.
 *
 * Crash safety: if the process dies mid-turn, the row simply stays "open"
 * (the customer has paid the reservation, never more). Unsettled rows can
 * be listed with `{ status: "open", createdAt: { $lt: <cutoff> } }` and
 * reconciled by hand. Deliberately no secondary index: that query is a rare
 * ops task, and every declared index must exist before the app will boot
 * (config/index-integrity.ts).
 */
import { Schema, model, type HydratedDocument, type Model, type Types } from "mongoose";

export const CREDIT_RESERVATION_STATUSES = ["open", "settled"] as const;
export type CreditReservationStatus = (typeof CREDIT_RESERVATION_STATUSES)[number];

export interface ICreditReservation {
  organization: Types.ObjectId;
  user?: Types.ObjectId;
  /** What the credits are for, e.g. "agent_message" — copied onto ledger rows. */
  reason: string;
  /** Credits debited up front. */
  reserved: number;
  status: CreditReservationStatus;
  /** The turn's real cost, set on settlement. */
  actual?: number;
  settledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CreditReservationDocument = HydratedDocument<ICreditReservation>;
type CreditReservationModel = Model<ICreditReservation>;

const creditReservationSchema = new Schema<ICreditReservation, CreditReservationModel>(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    reason: { type: String, required: true, trim: true, maxlength: 100 },
    reserved: { type: Number, required: true, min: 0 },
    status: { type: String, enum: CREDIT_RESERVATION_STATUSES, default: "open" },
    actual: { type: Number, min: 0 },
    settledAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const CreditReservation = model<ICreditReservation, CreditReservationModel>(
  "CreditReservation",
  creditReservationSchema
);
