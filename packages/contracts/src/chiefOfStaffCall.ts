import { Schema } from "effect";

import { BotId, TrimmedString } from "./baseSchemas";

export const CHIEF_OF_STAFF_CALL_ROUTE = "/api/chief-of-staff/call-me";
export const CHIEF_OF_STAFF_OPENAI_WEBHOOK_ROUTE =
  "/api/chief-of-staff/call-me/openai-webhook";
export const CHIEF_OF_STAFF_TWILIO_STATUS_ROUTE =
  "/api/chief-of-staff/call-me/twilio-status";

export const ChiefOfStaffCallPhase = Schema.Literals([
  "dialing",
  "ringing",
  "in-progress",
  "completed",
  "failed",
]);
export type ChiefOfStaffCallPhase = typeof ChiefOfStaffCallPhase.Type;

export const ChiefOfStaffCall = Schema.Struct({
  id: Schema.String,
  phase: ChiefOfStaffCallPhase,
  requestedAt: Schema.String,
  updatedAt: Schema.String,
  topic: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type ChiefOfStaffCall = typeof ChiefOfStaffCall.Type;

export const ChiefOfStaffCallSetupStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  configured: Schema.Boolean,
});
export type ChiefOfStaffCallSetupStep = typeof ChiefOfStaffCallSetupStep.Type;

export const ChiefOfStaffCallStatusResult = Schema.Struct({
  configured: Schema.Boolean,
  setupSteps: Schema.Array(ChiefOfStaffCallSetupStep),
  chiefOfStaff: Schema.NullOr(
    Schema.Struct({
      id: BotId,
      name: Schema.String,
      title: Schema.String,
    }),
  ),
  destinationLabel: Schema.NullOr(Schema.String),
  openAiWebhookUrl: Schema.NullOr(Schema.String),
  latestCall: Schema.NullOr(ChiefOfStaffCall),
});
export type ChiefOfStaffCallStatusResult = typeof ChiefOfStaffCallStatusResult.Type;

export const ChiefOfStaffCallRequestInput = Schema.Struct({
  topic: Schema.optional(TrimmedString.check(Schema.isMaxLength(1_000))),
});
export type ChiefOfStaffCallRequestInput = typeof ChiefOfStaffCallRequestInput.Type;

export const ChiefOfStaffCallRequestResult = Schema.Struct({
  call: ChiefOfStaffCall,
});
export type ChiefOfStaffCallRequestResult = typeof ChiefOfStaffCallRequestResult.Type;
