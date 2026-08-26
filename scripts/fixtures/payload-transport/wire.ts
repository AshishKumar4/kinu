import * as v from 'valibot';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const HarnessResultSchema = v.looseObject({
  imageVersion: v.optional(v.nullable(v.string())),
  sha256: v.optional(Sha256Schema),
  bytes: v.optional(v.number()),
  ms: v.optional(v.number()),
  corrupt: v.optional(v.boolean()),
});
export type HarnessResult = v.InferOutput<typeof HarnessResultSchema>;

export const OkReplySchema = v.looseObject({ ok: v.literal(true) });
export const SetupReplySchema = v.looseObject({
  ok: v.literal(true),
  imageVersion: v.string(),
});
export type SetupReply = v.InferOutput<typeof SetupReplySchema>;
export const OperationStartReplySchema = v.looseObject({
  ok: v.literal(true),
  started: v.boolean(),
  exitCode: v.nullable(v.number()),
});
export const OperationPollReplySchema = v.looseObject({
  exitCode: v.nullable(v.number()),
  results: v.optional(v.array(HarnessResultSchema)),
});
export const PresignReplySchema = v.variant('available', [
  v.looseObject({
    available: v.literal(true),
    opaque: v.string(),
    fingerprint: Sha256Schema,
  }),
  v.looseObject({
    available: v.literal(false),
    reason: v.string(),
  }),
]);
export const TemporaryCredentialsReplySchema = v.variant('available', [
  v.looseObject({
    available: v.literal(true),
    endpoint: v.string(),
    accessKeyId: v.string(),
    secretAccessKey: v.string(),
    sessionToken: v.string(),
    fingerprint: Sha256Schema,
  }),
  v.looseObject({
    available: v.literal(false),
    reason: v.string(),
  }),
]);
export const ObjectVerificationReplySchema = v.looseObject({
  sha256: Sha256Schema,
  size: v.number(),
});
export const InventoryReplySchema = v.looseObject({
  objects: v.number(),
  bytes: v.number(),
});
export const PurgeReplySchema = v.looseObject({
  deleted: v.number(),
  passes: v.number(),
});
