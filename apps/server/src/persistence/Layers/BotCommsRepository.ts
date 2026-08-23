// FILE: Layers/BotCommsRepository.ts
// Purpose: SQLite-backed BotCommsRepository (tables from migration 095_BotComms).
// Layer: Server persistence layer

import {
  BotCommsChannel,
  BotCommsChannelId,
  BotCommsMessage,
  BotDelegation,
  BOT_COMMS_PREVIEW_MAX_CHARS,
  ThreadId,
} from "@vulcan/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  BotCommsRepository,
  ListBotCommsChannelsInput,
  ListBotCommsMessagesInput,
  ListBotDelegationsInput,
  SetBotCommsChannelUnreadInput,
  SetBotCommsDepthInput,
  UpdateBotDelegationInput,
  UpsertBotCommsChannelInput,
  type BotCommsRepositoryShape,
} from "../Services/BotCommsRepository.ts";

const ChannelDbRow = Schema.Struct({
  id: BotCommsChannel.fields.id,
  botAId: BotCommsChannel.fields.botIds.elements[0],
  botBId: BotCommsChannel.fields.botIds.elements[1],
  lastMessagePreview: Schema.NullOr(Schema.String),
  lastMessageAt: Schema.NullOr(Schema.String),
  unread: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type ChannelDbRow = typeof ChannelDbRow.Type;

const decodeChannel = Schema.decodeUnknownEffect(BotCommsChannel);
const toChannel = (row: ChannelDbRow) =>
  decodeChannel({
    id: row.id,
    botIds: [row.botAId, row.botBId],
    lastMessagePreview: row.lastMessagePreview,
    lastMessageAt: row.lastMessageAt,
    unread: row.unread === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError(toPersistenceDecodeError("BotCommsRepository.toChannel")));


const MessageDbRow = Schema.Struct({
  id: BotCommsMessage.fields.id,
  channelId: BotCommsMessage.fields.channelId,
  fromBotId: BotCommsMessage.fields.fromBotId,
  kind: Schema.String,
  text: Schema.String,
  sourceThreadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const decodeMessage = Schema.decodeUnknownEffect(BotCommsMessage);

const DelegationDbRow = Schema.Struct({
  id: BotDelegation.fields.id,
  sourceBotId: BotDelegation.fields.sourceBotId,
  sourceThreadId: Schema.String,
  targetBotId: BotDelegation.fields.targetBotId,
  targetThreadId: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  reason: Schema.NullOr(Schema.String),
  depth: Schema.Number,
  status: Schema.String,
  result: Schema.NullOr(Schema.String),
  channelId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeDelegation = Schema.decodeUnknownEffect(BotDelegation);


function previewOf(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > BOT_COMMS_PREVIEW_MAX_CHARS
    ? `${oneLine.slice(0, BOT_COMMS_PREVIEW_MAX_CHARS - 1)}…`
    : oneLine;
}

const makeBotCommsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const channelColumns = sql`
    channel_id AS "id",
    bot_a_id AS "botAId",
    bot_b_id AS "botBId",
    last_message_preview AS "lastMessagePreview",
    last_message_at AS "lastMessageAt",
    unread,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;
  const delegationColumns = sql`
    delegation_id AS "id",
    source_bot_id AS "sourceBotId",
    source_thread_id AS "sourceThreadId",
    target_bot_id AS "targetBotId",
    target_thread_id AS "targetThreadId",
    prompt,
    reason,
    depth,
    status,
    result,
    channel_id AS "channelId",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const insertChannelRow = SqlSchema.void({
    Request: UpsertBotCommsChannelInput,
    execute: ({ id, botIds, now }) => {
      const [a, b] = [...botIds].sort();
      return sql`
        INSERT INTO bot_comms_channels (
          channel_id, bot_a_id, bot_b_id, last_message_preview, last_message_at,
          unread, created_at, updated_at
        )
        VALUES (${id}, ${a}, ${b}, NULL, NULL, 0, ${now}, ${now})
        ON CONFLICT (bot_a_id, bot_b_id) DO NOTHING
      `;
    },
  });

  const findChannelByPair = SqlSchema.findOneOption({
    Request: Schema.Tuple([Schema.String, Schema.String]),
    Result: ChannelDbRow,
    execute: ([a, b]) =>
      sql`SELECT ${channelColumns} FROM bot_comms_channels WHERE bot_a_id = ${a} AND bot_b_id = ${b}`,
  });

  const findChannelById = SqlSchema.findOneOption({
    Request: BotCommsChannelId,
    Result: ChannelDbRow,
    execute: (channelId) =>
      sql`SELECT ${channelColumns} FROM bot_comms_channels WHERE channel_id = ${channelId}`,
  });

  const listChannelRows = SqlSchema.findAll({
    Request: ListBotCommsChannelsInput,
    Result: ChannelDbRow,
    execute: ({ botId }) => {
      const filter =
        botId === undefined ? sql`` : sql`WHERE bot_a_id = ${botId} OR bot_b_id = ${botId}`;
      return sql`
        SELECT ${channelColumns} FROM bot_comms_channels
        ${filter}
        ORDER BY COALESCE(last_message_at, created_at) DESC, channel_id ASC
      `;
    },
  });

  const setChannelUnreadRow = SqlSchema.void({
    Request: SetBotCommsChannelUnreadInput,
    execute: ({ channelId, unread, updatedAt }) =>
      sql`
        UPDATE bot_comms_channels
        SET unread = ${unread ? 1 : 0}, updated_at = ${updatedAt}
        WHERE channel_id = ${channelId}
      `,
  });

  const insertMessageRow = SqlSchema.void({
    Request: BotCommsMessage,
    execute: (message) =>
      sql`
        INSERT INTO bot_comms_messages (
          message_id, channel_id, from_bot_id, kind, text, source_thread_id, created_at
        )
        VALUES (
          ${message.id},
          ${message.channelId},
          ${message.fromBotId},
          ${message.kind},
          ${message.text},
          ${message.sourceThreadId},
          ${message.createdAt}
        )
        ON CONFLICT (message_id) DO NOTHING
      `,
  });

  const bumpChannelRow = SqlSchema.void({
    Request: Schema.Struct({
      channelId: BotCommsChannelId,
      preview: Schema.String,
      at: Schema.String,
    }),
    execute: ({ channelId, preview, at }) =>
      sql`
        UPDATE bot_comms_channels
        SET last_message_preview = ${preview},
            last_message_at = ${at},
            unread = 1,
            updated_at = ${at}
        WHERE channel_id = ${channelId}
      `,
  });

  const listMessageRows = SqlSchema.findAll({
    Request: ListBotCommsMessagesInput,
    Result: MessageDbRow,
    execute: ({ channelId, limit }) =>
      sql`
        SELECT
          message_id AS "id",
          channel_id AS "channelId",
          from_bot_id AS "fromBotId",
          kind,
          text,
          source_thread_id AS "sourceThreadId",
          created_at AS "createdAt"
        FROM (
          SELECT * FROM bot_comms_messages
          WHERE channel_id = ${channelId}
          ORDER BY created_at DESC, message_id DESC
          LIMIT ${limit}
        )
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const insertDelegationRow = SqlSchema.void({
    Request: BotDelegation,
    execute: (d) =>
      sql`
        INSERT INTO bot_delegations (
          delegation_id, source_bot_id, source_thread_id, target_bot_id, target_thread_id,
          prompt, reason, depth, status, result, channel_id, created_at, updated_at
        )
        VALUES (
          ${d.id}, ${d.sourceBotId}, ${d.sourceThreadId}, ${d.targetBotId}, ${d.targetThreadId},
          ${d.prompt}, ${d.reason}, ${d.depth}, ${d.status}, ${d.result}, ${d.channelId},
          ${d.createdAt}, ${d.updatedAt}
        )
      `,
  });

  const findDelegationById = SqlSchema.findOneOption({
    Request: BotDelegation.fields.id,
    Result: DelegationDbRow,
    execute: (id) =>
      sql`SELECT ${delegationColumns} FROM bot_delegations WHERE delegation_id = ${id}`,
  });

  const updateDelegationRow = SqlSchema.void({
    Request: UpdateBotDelegationInput,
    execute: (input) => {
      const resultSet = input.result === undefined ? sql`` : sql`, result = ${input.result}`;
      const targetSet =
        input.targetThreadId === undefined
          ? sql``
          : sql`, target_thread_id = ${input.targetThreadId}`;
      const channelSet =
        input.channelId === undefined ? sql`` : sql`, channel_id = ${input.channelId}`;
      return sql`
        UPDATE bot_delegations
        SET status = ${input.status}, updated_at = ${input.updatedAt}
          ${resultSet}
          ${targetSet}
          ${channelSet}
        WHERE delegation_id = ${input.id}
      `;
    },
  });

  const listDelegationRows = SqlSchema.findAll({
    Request: ListBotDelegationsInput,
    Result: DelegationDbRow,
    execute: ({ botId, sourceThreadId, status }) => {
      const botFilter =
        botId === undefined
          ? sql``
          : sql`AND (source_bot_id = ${botId} OR target_bot_id = ${botId})`;
      const threadFilter =
        sourceThreadId === undefined ? sql`` : sql`AND source_thread_id = ${sourceThreadId}`;
      const statusFilter = status === undefined ? sql`` : sql`AND status = ${status}`;
      return sql`
        SELECT ${delegationColumns} FROM bot_delegations
        WHERE 1 = 1
          ${botFilter}
          ${threadFilter}
          ${statusFilter}
        ORDER BY created_at ASC, delegation_id ASC
      `;
    },
  });

  const countPendingRow = SqlSchema.findOne({
    Request: ThreadId,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (sourceThreadId) =>
      sql`
        SELECT COUNT(*) AS count FROM bot_delegations
        WHERE source_thread_id = ${sourceThreadId} AND status = 'pending'
      `,
  });

  const getDepthRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ depth: Schema.Number }),
    execute: (threadId) => sql`SELECT depth FROM bot_comms_depth WHERE thread_id = ${threadId}`,
  });

  const setDepthRow = SqlSchema.void({
    Request: SetBotCommsDepthInput,
    execute: ({ threadId, depth, sourceBotId, setAt }) =>
      sql`
        INSERT INTO bot_comms_depth (thread_id, depth, source_bot_id, set_at)
        VALUES (${threadId}, ${depth}, ${sourceBotId}, ${setAt})
        ON CONFLICT (thread_id) DO UPDATE SET
          depth = excluded.depth,
          source_bot_id = excluded.source_bot_id,
          set_at = excluded.set_at
      `,
  });

  const clearDepthRow = SqlSchema.void({
    Request: ThreadId,
    execute: (threadId) => sql`DELETE FROM bot_comms_depth WHERE thread_id = ${threadId}`,
  });

  const requireChannel = (channelId: BotCommsChannelId, operation: string) =>
    findChannelById(channelId).pipe(
      Effect.mapError(toPersistenceSqlError(operation)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              toPersistenceSqlError(operation)(new Error(`Channel ${channelId} was not found.`)),
            ),
          onSome: toChannel,
        }),
      ),
    );

  const upsertChannel: BotCommsRepositoryShape["upsertChannel"] = (input) => {
    const [a, b] = [...input.botIds].sort() as [string, string];
    return insertChannelRow(input).pipe(
      Effect.flatMap(() => findChannelByPair([a, b])),
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.upsertChannel")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              toPersistenceSqlError("BotCommsRepository.upsertChannel")(
                new Error("Channel missing after insert."),
              ),
            ),
          onSome: toChannel,
        }),
      ),
    );
  };

  const getChannelById: BotCommsRepositoryShape["getChannelById"] = (channelId) =>
    findChannelById(channelId).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.getChannelById")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toChannel(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listChannels: BotCommsRepositoryShape["listChannels"] = (input = {}) =>
    listChannelRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.listChannels")),
      Effect.flatMap((rows) => Effect.forEach(rows, toChannel)),
    );

  const setChannelUnread: BotCommsRepositoryShape["setChannelUnread"] = (input) =>
    setChannelUnreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.setChannelUnread")),
      Effect.flatMap(() => getChannelById(input.channelId)),
    );

  const appendMessage: BotCommsRepositoryShape["appendMessage"] = (message) =>
    insertMessageRow(message).pipe(
      Effect.flatMap(() =>
        bumpChannelRow({
          channelId: message.channelId,
          preview: previewOf(message.text),
          at: message.createdAt,
        }),
      ),
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.appendMessage")),
      Effect.flatMap(() =>
        requireChannel(message.channelId, "BotCommsRepository.appendMessage:reload"),
      ),
    );

  const listMessages: BotCommsRepositoryShape["listMessages"] = (input) =>
    listMessageRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.listMessages")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeMessage(row).pipe(
            Effect.mapError(toPersistenceDecodeError("BotCommsRepository.listMessages")),
          ),
        ),
      ),
    );

  const insertDelegation: BotCommsRepositoryShape["insertDelegation"] = (delegation) =>
    insertDelegationRow(delegation).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.insertDelegation")),
      Effect.as(delegation),
    );

  const updateDelegation: BotCommsRepositoryShape["updateDelegation"] = (input) =>
    updateDelegationRow(input).pipe(
      Effect.flatMap(() => findDelegationById(input.id)),
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.updateDelegation")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeDelegation(row).pipe(
              Effect.mapError(toPersistenceDecodeError("BotCommsRepository.updateDelegation")),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const listDelegations: BotCommsRepositoryShape["listDelegations"] = (input = {}) =>
    listDelegationRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.listDelegations")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeDelegation(row).pipe(
            Effect.mapError(toPersistenceDecodeError("BotCommsRepository.listDelegations")),
          ),
        ),
      ),
    );

  const countPendingDelegations: BotCommsRepositoryShape["countPendingDelegations"] = (
    sourceThreadId,
  ) =>
    countPendingRow(sourceThreadId).pipe(
      Effect.map((row) => row.count),
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.countPendingDelegations")),
    );

  const getDepth: BotCommsRepositoryShape["getDepth"] = (threadId) =>
    getDepthRow(threadId).pipe(
      Effect.map(Option.match({ onNone: () => 0, onSome: (row) => row.depth })),
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.getDepth")),
    );

  const setDepth: BotCommsRepositoryShape["setDepth"] = (input) =>
    setDepthRow(input).pipe(Effect.mapError(toPersistenceSqlError("BotCommsRepository.setDepth")));

  const clearDepth: BotCommsRepositoryShape["clearDepth"] = (threadId) =>
    clearDepthRow(threadId).pipe(
      Effect.mapError(toPersistenceSqlError("BotCommsRepository.clearDepth")),
    );

  const clearAllDepths: BotCommsRepositoryShape["clearAllDepths"] = sql`
    DELETE FROM bot_comms_depth
  `.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("BotCommsRepository.clearAllDepths")),
  );

  return {
    upsertChannel,
    getChannelById,
    listChannels,
    setChannelUnread,
    appendMessage,
    listMessages,
    insertDelegation,
    updateDelegation,
    listDelegations,
    countPendingDelegations,
    getDepth,
    setDepth,
    clearDepth,
    clearAllDepths,
  } satisfies BotCommsRepositoryShape;
});

export const BotCommsRepositoryLive = Layer.effect(BotCommsRepository, makeBotCommsRepository);
