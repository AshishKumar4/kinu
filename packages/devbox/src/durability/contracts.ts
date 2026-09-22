/** Durability shapes shared byte for byte across programs; instruments must import these,
 *  never copy them. A GRANT keeps credential material in one field so reports can fingerprint it. */

import * as v from 'valibot';

/** Evidence for publishing a legacy whole-upper delta instead of chunked. */
export const DeltaFallbackSchema = v.object({
  reason: v.picklist(['upper-probe-failed', 'upper-empty', 'whiteout-probe-failed', 'base-probe-failed', 'block-hash-failed', 'stage-failed']),
  detail: v.string(),
});

export type DeltaFallback = v.InferOutput<typeof DeltaFallbackSchema>;

const DecimalSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
);

const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

const ObjectKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));

const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** Work one restore did, in the dimensions a readiness claim is checked against.
 *  `serialRemoteOps` counts the remote operations that were unavoidably serial. */
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

export const PublishWorkSchema = v.strictObject({
  objectsPut: CountSchema,
  bytesPut: CountSchema,
  casAttempts: CountSchema,
});

/** `containerStart` is the first command that answered: the RPC server comes up after admission.
 *  `storeMount`/`baseAttach` are stamped by the storage strategy; a box with no chain skips them. */
export type RestorePhase = 'containerStart' | StoragePhase | 'attached' | 'bootId';

export type StoragePhase = 'storeMount' | 'baseAttach';

/** Milliseconds after the restoration opened; an unreached phase is absent, never zero,
 *  so a start the platform reset still names its last phase. */
export type RestorePhaseStamps = { readonly [P in RestorePhase]?: number };

export const RestorePhaseStampsSchema: v.GenericSchema<RestorePhaseStamps> = v.object({
  containerStart: v.optional(CountSchema),
  storeMount: v.optional(CountSchema),
  baseAttach: v.optional(CountSchema),
  attached: v.optional(CountSchema),
  bootId: v.optional(CountSchema),
});

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

/** Phases of one durable operation, in order; a cell reports only these, so an instrument
 *  can assert which phase a fault was injected in. */
export const DURABILITY_OPERATION_PHASES = [
  'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
] as const;
