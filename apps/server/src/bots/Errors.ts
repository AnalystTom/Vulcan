import { Schema } from "effect";

export class BotServiceError extends Schema.TaggedErrorClass<BotServiceError>()("BotServiceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class BotWorkspaceError extends Schema.TaggedErrorClass<BotWorkspaceError>()(
  "BotWorkspaceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
