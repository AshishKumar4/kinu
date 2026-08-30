/**
 * The artifact schema: what a run is allowed to claim, validated before it is
 * written.
 *
 * The embedded intents are validated against the FROZEN shared contracts from
 * `@kinu.run/devbox/durability/contracts` — the instrument carries no copies of
 * those shapes. Grant opaque values (presigned URLs, credential material) never
 * enter the artifact at all; only their SHA-256 fingerprint does, so a run
 * record cannot leak live credentials.
 */

import * as v from 'valibot';
import {
  DURABILITY_OPERATION_PHASES,
  RangeReadIntentSchema,
  UploadIntentSchema,
} from '@kinu.run/devbox/durability/contracts';
import { CELL_STATUSES, PAYLOAD_ARMS, PAYLOAD_SIZES_MIB } from './arms';

/**
 * The report's dispersion shape, matching `fixtures/r2-bench/stats.ts`'s
 * Summary field for field. Owned here because the shared module is pure
 * statistics and carries no schema.
 */
const SummarySchema = v.object({
  n: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  min: v.number(),
  p50: v.number(),
  p95: v.number(),
  p99: v.number(),
  max: v.number(),
  mean: v.number(),
  stddev: v.number(),
  cv: v.number(),
});

export const RunPlanSchema = v.object({
  runId: v.pipe(v.string(), v.minLength(1)),
  workerName: v.pipe(v.string(), v.minLength(1)),
  bucketName: v.pipe(v.string(), v.minLength(1)),
  seed: v.number(),
  sizesMiB: v.array(v.picklist(PAYLOAD_SIZES_MIB)),
  reps: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  concurrency: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  startedAt: v.pipe(v.string(), v.isoTimestamp()),
  /** Container image pinned by the fixture config, carried in the run identity. */
  imagePinned: v.optional(v.string()),
  /** Image the container actually reported at setup, when it could be read. */
  imageObserved: v.optional(v.string()),
});

export const AvailabilitySchema = v.object({
  arm: v.picklist(PAYLOAD_ARMS),
  available: v.boolean(),
  /** Present exactly when `available` is false. Rendered verbatim. */
  reason: v.optional(v.string()),
});


export const CellSchema = v.object({
  arm: v.picklist(PAYLOAD_ARMS),
  op: v.picklist(['put', 'get']),
  sizeMiB: v.picklist(PAYLOAD_SIZES_MIB),
  rep: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  phase: v.picklist(DURABILITY_OPERATION_PHASES),
  status: v.picklist(CELL_STATUSES),
  /** Required for every status except `ok`. Enforced by `assertCellCoherence`. */
  reason: v.optional(v.string()),
  wallMs: v.nullable(v.number()),
  uploadIntent: v.optional(UploadIntentSchema),
  rangeReadIntent: v.optional(RangeReadIntentSchema),
  grantFingerprint: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
  /** Where the clock ran: inside the container, or around the owning DO's SDK calls. */
  timedBy: v.optional(v.picklist(['container', 'owner-do'])),
});

export const ControlRpcSchema = v.object({
  phase: v.picklist(['idle', 'loaded']),
  /** Null for the idle sample: control latency belongs to the owning DO alone. */
  arm: v.nullable(v.picklist(PAYLOAD_ARMS)),
  latency: SummarySchema,
});

export const CleanupStepSchema = v.object({
  gate: v.string(),
  ok: v.boolean(),
  detail: v.string(),
});

const ExclusionSchema = v.object({
  arm: v.picklist(PAYLOAD_ARMS),
  reason: v.string(),
});

export const VerdictSchema = v.variant('kind', [
  v.object({
    kind: v.literal('ranking'),
    sizeMiB: v.picklist(PAYLOAD_SIZES_MIB),
    ranked: v.array(v.object({ arm: v.picklist(PAYLOAD_ARMS), medianMiBs: v.number() })),
    exclusions: v.array(ExclusionSchema),
  }),
  v.object({
    kind: v.literal('no-ranking'),
    sizeMiB: v.picklist(PAYLOAD_SIZES_MIB),
    reason: v.string(),
    exclusions: v.array(ExclusionSchema),
  }),
]);

export const ArtifactSchema = v.object({
  instrument: v.literal('payload-transports'),
  version: v.literal(1),
  plan: RunPlanSchema,
  availability: v.array(AvailabilitySchema),
  /** One pre-sample PUT/GET pair per available arm and tier; never ranked. */
  warmups: v.array(CellSchema),
  /** Statistical samples only. `decision.ts` ranks this collection and no other. */
  cells: v.array(CellSchema),
  controlRpc: v.array(ControlRpcSchema),
  concurrency: v.array(v.object({
    arm: v.picklist(PAYLOAD_ARMS),
    wallMs: v.nullable(v.number()),
    throughputMiBs: v.nullable(v.number()),
    status: v.picklist(CELL_STATUSES),
    reason: v.optional(v.string()),
  })),
  verdicts: v.array(VerdictSchema),
  cleanup: v.object({
    steps: v.array(CleanupStepSchema),
    residue: v.boolean(),
  }),
});

export type RunPlan = v.InferOutput<typeof RunPlanSchema>;
export type Availability = v.InferOutput<typeof AvailabilitySchema>;
export type Cell = v.InferOutput<typeof CellSchema>;
export type ControlRpc = v.InferOutput<typeof ControlRpcSchema>;
export type CleanupStep = v.InferOutput<typeof CleanupStepSchema>;
export type Verdict = v.InferOutput<typeof VerdictSchema>;
export type Artifact = v.InferOutput<typeof ArtifactSchema>;

/**
 * The one coherence rule the object above cannot express inline: an `ok` cell
 * carries no refusal reason, and every other status carries exactly one. A
 * silent failure — a non-ok cell with no words — would render as an
 * unexplained hole in the report.
 */
export function assertCellCoherence(cell: Cell): string | null {
  if (cell.status === 'ok') {
    return cell.reason !== undefined ? 'an ok cell carries no refusal reason' : null;
  }
  return cell.reason !== undefined && cell.reason.length > 0
    ? null
    : `a ${cell.status} cell must name its reason`;
}

export function validateArtifact(value: v.InferInput<typeof ArtifactSchema>): Artifact {
  const parsed = v.parse(ArtifactSchema, value);
  for (const cell of [...parsed.warmups, ...parsed.cells]) {
    const problem = assertCellCoherence(cell);
    if (problem !== null) {
      throw new Error(`cell ${cell.arm}/${cell.op}/${cell.sizeMiB}MiB#${cell.rep}: ${problem}`);
    }
  }
  return parsed;
}
