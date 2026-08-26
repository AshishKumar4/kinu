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
export const HeadPointerV1Schema = v.strictObject({
  version: v.literal(1),
  rootEnvelopeId: Sha256Schema,
  lastOperationId: IdSchema,
});
export type HeadPointerV1 = v.InferOutput<typeof HeadPointerV1Schema>;


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

export const UploadIntentSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  boxId: IdSchema,
  epoch: DecimalSchema,
  exactKey: ObjectKeySchema,
  method: v.literal('PUT'),
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
  expiresAt: DecimalSchema,
});
export type UploadIntent = v.InferOutput<typeof UploadIntentSchema>;

export const RangeReadIntentSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  boxId: IdSchema,
  epoch: DecimalSchema,
  exactKey: ObjectKeySchema,
  method: v.literal('GET'),
  byteOffset: DecimalSchema,
  byteLength: DecimalSchema,
  sha256: Sha256Schema,
  expiresAt: DecimalSchema,
});
export type RangeReadIntent = v.InferOutput<typeof RangeReadIntentSchema>;

export const PayloadGrantSchema = v.strictObject({
  operationId: IdSchema,
  attemptId: IdSchema,
  expiresAt: DecimalSchema,
  opaque: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});
export type PayloadGrant = v.InferOutput<typeof PayloadGrantSchema>;

export const CapturedCutSchema = v.strictObject({
  captureId: IdSchema,
  epoch: DecimalSchema,
  baseRevision: DecimalSchema,
  cut: DecimalSchema,
  stableStageHandle: IdSchema,
  manifestSha256: Sha256Schema,
});
export type CapturedCut = v.InferOutput<typeof CapturedCutSchema>;

export const DURABILITY_OPERATION_KINDS = [
  'tick', 'barrier', 'gc', 'cleanup',
] as const;
export const DURABILITY_OPERATION_PHASES = [
  'intent', 'transferring', 'sealed', 'published', 'failed',
] as const;
const OperationBaseEntries = {
  operationId: IdSchema,
  kind: v.picklist(DURABILITY_OPERATION_KINDS),
  epoch: DecimalSchema,
  bootId: IdSchema,
  baseRevision: DecimalSchema,
  expectedParent: v.nullable(Sha256Schema),
};
export const OperationRecordSchema = v.variant('phase', [
  v.strictObject({ ...OperationBaseEntries, phase: v.literal('intent') }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('transferring'),
    attemptId: IdSchema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('sealed'),
    attemptId: IdSchema,
    resultRootId: Sha256Schema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('published'),
    resultRootId: Sha256Schema,
  }),
  v.strictObject({
    ...OperationBaseEntries,
    phase: v.literal('failed'),
    failureCode: IdSchema,
  }),
]);
export type OperationRecord = v.InferOutput<typeof OperationRecordSchema>;

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
