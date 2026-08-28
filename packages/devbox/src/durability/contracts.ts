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

export const CapturedCutSchema = v.strictObject({
  captureId: IdSchema,
  epoch: DecimalSchema,
  baseRevision: DecimalSchema,
  cut: DecimalSchema,
  stableStageHandle: IdSchema,
  manifestSha256: Sha256Schema,
});
export type CapturedCut = v.InferOutput<typeof CapturedCutSchema>;

export const RootEnvelopeV1Schema = v.strictObject({
  version: v.literal(1),
  format: v.picklist(DURABLE_ROOT_FORMATS),
  boxId: IdSchema,
  epoch: DecimalSchema,
  generation: DecimalSchema,
  parentRootId: v.nullable(Sha256Schema),
  cut: CapturedCutSchema,
  rootObject: ImmutableObjectRefSchema,
  /** Canonical sorted payload closure, duplicated here for metadata-only restore verification. */
  closure: v.array(ImmutableObjectRefSchema),
  /** Canonical sorted payload closure, written directly beside candidate objects. */
  closureObject: ImmutableObjectRefSchema,
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


export const DURABILITY_OPERATION_KINDS = [
  'tick', 'barrier', 'gc', 'cleanup',
] as const;
export const DURABILITY_OPERATION_PHASES = [
  'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
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
    phase: v.literal('completion-pending'),
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

/** The sole candidate control authority persisted by a Devbox Durable Object.
 * Envelope metadata is immutable R2 data addressed by `head.rootEnvelopeId`;
 * keeping only that pointer here prevents the control record from becoming a
 * second envelope authority. */
export const CandidateControlStateV1Schema = v.strictObject({
  version: v.literal(1),
  head: v.nullable(HeadPointerV1Schema),
  operation: v.nullable(OperationRecordSchema),
});
export type CandidateControlStateV1 = v.InferOutput<typeof CandidateControlStateV1Schema>;

/** The control snapshot a container run receives. It pairs the durable head
 * pointer with the immutable envelope that pointer names, so the runner reads
 * root and closure metadata without ever becoming a head authority. */
export const CandidateRunHeadV1Schema = v.strictObject({
  pointer: HeadPointerV1Schema,
  envelope: RootEnvelopeV1Schema,
});
export type CandidateRunHeadV1 = v.InferOutput<typeof CandidateRunHeadV1Schema>;

export const CandidateRunControlV1Schema = v.strictObject({
  version: v.literal(1),
  head: v.nullable(CandidateRunHeadV1Schema),
  operation: v.nullable(OperationRecordSchema),
});
export type CandidateRunControlV1 = v.InferOutput<typeof CandidateRunControlV1Schema>;

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
