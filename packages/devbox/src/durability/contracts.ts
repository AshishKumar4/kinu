/**
 * The frozen durability contracts: shapes more than one program has to agree
 * on, byte for byte.
 *
 * They live in the product package, and are exported through
 * `@kinu.run/devbox/durability/contracts`, because the instruments that measure
 * durability must validate against the SHIPPED shapes rather than against
 * their own copies — `scripts/fixtures/payload-transport` and
 * `scripts/fixtures/fuse-probe` both say so where they import from here. A
 * second copy of one of these shapes is a copy that drifts silently, and the
 * drift lands in a measurement nobody can reproduce.
 *
 * An INTENT is what a box asks for, exactly: one key, one method, one byte
 * range, one digest, one expiry. A GRANT is what it is handed back, and it
 * carries the opaque credential material as ONE field so a caller can
 * fingerprint the grant without a report ever recording a live credential.
 * `Work` shapes are counted units: what one operation actually did, in the
 * units its bound is stated in.
 */

import * as v from 'valibot';

const DecimalSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
);
const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const ObjectKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));
const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** What one restore did, in the dimensions a readiness claim has to be
 * checked in: how many remote operations were unavoidably serial, how many
 * there were in total, the bytes each class moved, and the local work that
 * followed. */
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

/** What one publish did: single PUTs of fresh bytes, and how many head CAS
 * transactions it took. */
export const PublishWorkSchema = v.strictObject({
  objectsPut: CountSchema,
  bytesPut: CountSchema,
  casAttempts: CountSchema,
});
export type PublishWork = v.InferOutput<typeof PublishWorkSchema>;

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

/** The phases one durable operation passes through, in order. A cell that
 * reports a phase reports one of these and nothing else, so an instrument can
 * assert which phase a fault was injected in. */
export const DURABILITY_OPERATION_PHASES = [
  'intent', 'transferring', 'sealed', 'completion-pending', 'published', 'failed',
] as const;
