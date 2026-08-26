import * as v from 'valibot';

const DecimalSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
);
const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const ObjectKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));
const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const DURABLE_ROOT_FORMATS = [
  'bounded-layers/v1',
  'merkle-pack/v1',
] as const;

export const ImmutableObjectRefSchema = v.strictObject({
  key: ObjectKeySchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
});
export type ImmutableObjectRef = v.InferOutput<typeof ImmutableObjectRefSchema>;

export const ObjectReceiptSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  key: ObjectKeySchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
  etag: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  verified: v.literal(true),
});
export type ObjectReceipt = v.InferOutput<typeof ObjectReceiptSchema>;

export const RootEnvelopeV1Schema = v.strictObject({
  version: v.literal(1),
  format: v.picklist(DURABLE_ROOT_FORMATS),
  boxId: IdSchema,
  epoch: DecimalSchema,
  generation: DecimalSchema,
  parentRootId: v.nullable(Sha256Schema),
  cut: DecimalSchema,
  rootObject: ImmutableObjectRefSchema,
});
export type RootEnvelopeV1 = v.InferOutput<typeof RootEnvelopeV1Schema>;

export const RestoreWorkSchema = v.strictObject({
  serialRemoteOps: CountSchema,
  totalRemoteOps: CountSchema,
  metadataBytes: CountSchema,
  payloadBytes: CountSchema,
  cpuSteps: CountSchema,
  mounts: CountSchema,
  replayUnits: CountSchema,
});
export type RestoreWork = v.InferOutput<typeof RestoreWorkSchema>;

/** Every external await where reset/re-drive behavior must be fault-injected. */
export const DURABILITY_AWAIT_POINTS = [
  'issue-payload-grant',
  'create-multipart',
  'upload-multipart-part',
  'complete-multipart',
  'verify-upload',
  'upload-root',
  'publish-head',
  'create-pin',
  'renew-pin',
  'release-pin',
  'read-mark-page',
  'complete-mark',
  'retire-object',
  'delete-retired-object',
  'mount-root',
  'cleanup-resource',
] as const;
export type DurabilityAwaitPoint = (typeof DURABILITY_AWAIT_POINTS)[number];
