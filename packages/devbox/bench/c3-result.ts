import * as v from 'valibot';
import {
  CheckpointReplySchema, ExecReplySchema, FileObservationSchema,
  StateReplySchema, StartupCompletionSchema, StartupObservationSchema, DestroyReplySchema, TeardownReplySchema,
  type CheckpointReply, type ExecReply, type FileObservation,
  type StateReply, type StartupCompletion, type StartupObservation, type DestroyReply, type TeardownReply,
} from './observation-schema';
import { PublicationWindowSchema, publicationTotals, type PublicationTotals, type PublicationWindow } from './publication-meter';
import { C3_BYTES_BOUND, C3_OVERWRITE_SHA256, C3_WORKLOAD } from './witness-files';
import { RestorePhaseStampsSchema, type RestorePhaseStamps } from '../src/durability/contracts';

export interface C3Identity {
  commit: string;
  dirtyDigest: string;
  workerVersion: string;
  image: string;
}

interface C3Ops { calls?: Record<string, number> }

interface C3Preparation { cleanup: TeardownReply | null; destroy: DestroyReply | null }

export interface C3Round {
  round: number;
  checkpoint: CheckpointReply | null;
  published: { transport: { puts: number | null; putUploadBytes: number | null } };
  accounting: { beforeOps: C3Ops | null; afterOps: C3Ops | null; window: PublicationWindow | null };
}

export interface LiveC3Observation {
  event: 'matched.chain.C3.observations';
  case: string;
  runId: string;
  box: string;
  identity: C3Identity | null;
  workload: typeof C3_WORKLOAD;
  prefix: string | null;
  preparation: C3Preparation;
  initial: StartupCompletion | null;
  initialObservations: StartupObservation[];
  baselineCommand: ExecReply | null;
  baselineCheckpoint: CheckpointReply | null;
  overwriteCommand: ExecReply | null;
  rounds: C3Round[];
  beforeDestroy: StateReply | null;
  destroyReceipt: DestroyReply | null;
  restoration: StartupCompletion | null;
  restorationObservations: StartupObservation[];
  restoreProbe: { kind?: string; treeBytes?: number | null; wallMs: number | null; probeAt: number | null; outcome: string; phases?: RestorePhaseStamps } | null;
  blockReads?: BlockAttachMetrics | null;
  file: FileObservation | null;
  correctness: 'passed' | 'failed' | 'unmeasured';
  errors: string[];
  cleanup: TeardownReply | null;
}

const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const BlockAttachMetricsSchema = v.object({
  generation: v.pipe(v.string(), v.minLength(1)), payloadBytes: Count, indexPages: Count, readRequests: Count,
});

export type BlockAttachMetrics = v.InferOutput<typeof BlockAttachMetricsSchema>;

const Text = v.pipe(v.string(), v.minLength(1));

const OpsSchema = v.looseObject({ calls: v.optional(v.record(v.string(), Count)) });

export const LiveC3ObservationSchema = v.looseObject({
  event: v.literal('matched.chain.C3.observations'), case: Text, runId: Text, box: Text,
  identity: v.nullable(v.object({ commit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)), dirtyDigest: Text, workerVersion: Text, image: Text })),
  workload: v.object({
    path: v.literal(C3_WORKLOAD.path), baselineBytes: v.literal(C3_WORKLOAD.baselineBytes),
    overwriteBytes: v.literal(C3_WORKLOAD.overwriteBytes), offset: v.literal(C3_WORKLOAD.offset),
    baselineSeed: v.literal(C3_WORKLOAD.baselineSeed), overwriteSeed: v.literal(C3_WORKLOAD.overwriteSeed),
  }),
  prefix: v.nullable(Text), preparation: v.object({ cleanup: v.nullable(TeardownReplySchema), destroy: v.nullable(DestroyReplySchema) }),
  initial: v.nullable(StartupCompletionSchema), initialObservations: v.array(StartupObservationSchema),
  baselineCommand: v.nullable(ExecReplySchema), baselineCheckpoint: v.nullable(CheckpointReplySchema), overwriteCommand: v.nullable(ExecReplySchema),
  rounds: v.array(v.looseObject({
    round: Count, checkpoint: v.nullable(CheckpointReplySchema),
    published: v.object({ transport: v.object({ puts: v.nullable(Count), putUploadBytes: v.nullable(Count) }) }),
    accounting: v.looseObject({ beforeOps: v.nullable(OpsSchema), afterOps: v.nullable(OpsSchema), window: v.nullable(PublicationWindowSchema) }),
  })),
  beforeDestroy: v.nullable(StateReplySchema), destroyReceipt: v.nullable(DestroyReplySchema),
  restoration: v.nullable(StartupCompletionSchema), restorationObservations: v.array(StartupObservationSchema),
  restoreProbe: v.nullable(v.looseObject({ wallMs: v.nullable(Count), probeAt: v.nullable(Count), outcome: v.string(), phases: v.optional(RestorePhaseStampsSchema) })),
  blockReads: v.optional(v.nullable(BlockAttachMetricsSchema)),
  file: v.nullable(FileObservationSchema), correctness: v.picklist(['passed', 'failed', 'unmeasured']), errors: v.array(v.string()), cleanup: v.nullable(TeardownReplySchema),
}) satisfies v.GenericSchema<LiveC3Observation>;

export interface C3Verdict {
  admitted: boolean; correctness: LiveC3Observation['correctness']; objectsPut: number | null; bytesPut: number | null; errors: string[];
}

/** The observation after its schema contract holds. The judges below read the
 *  parsed row, so a field the schema narrowed keeps its narrow type. */
type C3Row = v.InferOutput<typeof LiveC3ObservationSchema>;

type C3RoundRow = C3Row['rounds'][number];

/** The build/workload evidence group: the run proved it measured the intended
 *  workload — a build identity, a baseline that started from an empty box,
 *  both writers observed, and its one committed overwrite checkpoint. */
function workloadEvidenceErrors(row: C3Row, round: C3RoundRow | undefined): string[] {
  const errors: string[] = [];

  if (row.identity === null) errors.push('live C3 has no build identity');

  if (row.initial?.attach.kind !== 'empty') errors.push('the C3 baseline did not start from an empty box');

  if (row.baselineCommand?.ok !== true || row.baselineCommand.exitCode !== 0) errors.push('the baseline writer was unobserved');

  if (row.baselineCheckpoint?.ok !== true || row.baselineCheckpoint.outcome?.kind !== 'committed') errors.push('the baseline checkpoint was not committed');

  if (row.overwriteCommand?.ok !== true || row.overwriteCommand.exitCode !== 0) errors.push('the overwrite writer was unobserved');

  if (row.rounds.length !== 1 || round?.round !== 1 || round.checkpoint?.ok !== true || round.checkpoint.outcome?.kind !== 'committed') errors.push('C3 requires its one committed overwrite checkpoint');

  return errors;
}

/** The publication accounting group: the PUT window belongs to this run and
 *  box, its attempt log reconciles with the independent operation bracket, the
 *  reported transport totals match the raw window, and the run put exactly one
 *  object strictly under the byte bound. */
function publicationEvidenceErrors(
  row: C3Row,
  round: C3RoundRow | undefined,
  window: PublicationWindow | null,
  totals: PublicationTotals,
): string[] {
  const errors: string[] = [];

  if (window?.prefix !== row.prefix || !window?.token.startsWith(`${row.runId}-C3-`)) errors.push('the PUT window does not belong to this run and box');
  const before = round?.accounting.beforeOps?.calls;
  const after = round?.accounting.afterOps?.calls;

  if (before === undefined || after === undefined) errors.push('the independent operation bracket was unobserved');
  else for (const operation of ['put', 'uploadPart', 'complete'] as const) {
    const count = (after[operation] ?? 0) - (before[operation] ?? 0);

    if (count < 0 || count !== window?.attempts.filter((attempt) => attempt.operation === operation).length) errors.push(`the ${operation} attempt log does not reconcile with the operation bracket`);
  }

  if (round?.published.transport.puts !== totals.objectsPut || round?.published.transport.putUploadBytes !== totals.bytesPut) errors.push('the reported publication totals disagree with the raw window');

  if (totals.objectsPut !== 1) errors.push('C3 must publish exactly 1 object attempt');

  if (totals.bytesPut === null || totals.bytesPut >= C3_BYTES_BOUND) errors.push(`C3 publication bytes must be observed and strictly below ${C3_BYTES_BOUND}`);

  return errors;
}

/** The cold-generation proof: the box was destroyed and the wake attached a
 *  genuinely different boot — a new non-empty bootId, a layered attach that is
 *  not the upper already holding the delta, a running restored state, and a
 *  probe that landed no earlier than the restore and answered ok. */
function coldRestoreProven(row: C3Row): boolean {
  const oldBoot = row.beforeDestroy?.state?.bootId;
  const restored = row.restoration;
  const newBoot = restored?.state.state?.bootId;
  const probe = row.restoreProbe;

  return row.destroyReceipt?.ok === true && row.destroyReceipt.destroyed === true
    && oldBoot !== undefined && oldBoot !== '' && newBoot !== undefined && newBoot !== '' && newBoot !== oldBoot
    && restored?.attach.kind === 'attached' && !restored.attach.detail.includes('already in this upper')
    && restored.state.state?.running === true && restored.state.state.restoration === 'attached'
    && probe !== null && probe.wallMs !== null && probe.probeAt !== null && probe.probeAt >= restored.startedAt && probe.outcome === 'ok';
}

/** The file correctness group: on a proven-cold restore the workload file must
 *  read back at its own path as a file of the baseline size carrying the
 *  overwrite's exact digest. Anything short of that read is `unmeasured`,
 *  never `failed` — a failure requires the read to have happened. */
function coldFileCorrectness(cold: boolean, file: FileObservation | null): LiveC3Observation['correctness'] {
  if (cold && file?.reply?.ok === true && file.reply.exitCode === 0 && file.error === null && file.evidence !== null) {
    return file.path === `/workspace/${C3_WORKLOAD.path}` && file.evidence.kind === 'file'
      && file.evidence.size === C3_WORKLOAD.baselineBytes && file.evidence.sha256 === C3_OVERWRITE_SHA256 ? 'passed' : 'failed';
  }

  return 'unmeasured';
}

export function evaluateLiveC3(input: LiveC3Observation): C3Verdict {
  const parsed = v.safeParse(LiveC3ObservationSchema, input);

  if (!parsed.success) return { admitted: false, correctness: 'unmeasured', objectsPut: null, bytesPut: null, errors: ['the live C3 observation does not satisfy its evidence contract'] };
  const row = parsed.output;
  const errors = [...row.errors];
  const round = row.rounds[0];

  errors.push(...workloadEvidenceErrors(row, round));
  const window = round?.accounting.window ?? null;
  const totals = publicationTotals(window);
  errors.push(...totals.errors);
  errors.push(...publicationEvidenceErrors(row, round, window, totals));

  const cold = coldRestoreProven(row);

  if (!cold) errors.push('the post-overwrite restore was not proven genuinely cold');
  const correctness = coldFileCorrectness(cold, row.file);

  if (correctness !== 'passed') errors.push(`C3 cold file correctness is ${correctness}`);

  return { admitted: errors.length === 0, correctness, objectsPut: totals.objectsPut, bytesPut: totals.bytesPut, errors };
}
