import * as v from 'valibot';
import type { FileEvidence } from './witness-files';

export interface ExecReply {
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  ms?: number;
  error?: string;
}

export const ExecReplySchema = v.looseObject({
  ok: v.optional(v.boolean()), exitCode: v.optional(v.number()),
  stdout: v.optional(v.string()), stderr: v.optional(v.string()),
  ms: v.optional(v.number()), error: v.optional(v.string()),
}) satisfies v.GenericSchema<ExecReply>;

export interface CheckpointReply {
  ok?: boolean;
  outcome?: { kind: string; reason?: string; bytes?: number; movedBytes?: number };
  ms?: number;
  error?: string;
}

export const CheckpointReplySchema = v.looseObject({
  ok: v.optional(v.boolean()),
  outcome: v.optional(v.looseObject({
    kind: v.string(), reason: v.optional(v.string()), bytes: v.optional(v.number()), movedBytes: v.optional(v.number()),
  })),
  ms: v.optional(v.number()), error: v.optional(v.string()),
}) satisfies v.GenericSchema<CheckpointReply>;

export const FileEvidenceSchema = v.variant('kind', [
  v.object({
    kind: v.literal('file'), size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  }),
  v.object({ kind: v.literal('missing') }),
]) satisfies v.GenericSchema<FileEvidence>;

export interface FileObservation {
  readonly path: string;
  readonly reply: ExecReply | null;
  readonly evidence: FileEvidence | null;
  readonly error: string | null;
}

export const FileObservationSchema = v.looseObject({
  path: v.string(), reply: v.nullable(ExecReplySchema), evidence: v.nullable(FileEvidenceSchema), error: v.nullable(v.string()),
}) satisfies v.GenericSchema<FileObservation>;

export interface AttachOutcome { kind: string; detail: string }

interface LayerObservation { bytes?: number; digest?: string; objectVersion?: string }

export interface StartupState {
  restoration?: 'unstarted' | 'restoring' | 'attached' | 'repair' | 'unattached';
  running?: boolean;
  unready?: string;
  lastAttach?: AttachOutcome;
  bootId?: string;
  chain?: {
    base?: LayerObservation & { id?: string };
    delta?: LayerObservation | null;
    mode?: string;
    rev?: number;
  } | null;
  incidents?: { total?: number; undelivered?: number };
}

export interface StateReply {
  error?: string;
  extractionAllowed?: boolean;
  storePrefix?: string;
  state?: StartupState;
}

const LayerObservationSchema = v.looseObject({
  bytes: v.optional(v.number()), digest: v.optional(v.string()), objectVersion: v.optional(v.string()),
});

const AttachOutcomeSchema = v.looseObject({ kind: v.string(), detail: v.string() });

export const StateReplySchema = v.looseObject({
  error: v.optional(v.string()), extractionAllowed: v.optional(v.boolean()), storePrefix: v.optional(v.string()),
  state: v.optional(v.looseObject({
    restoration: v.optional(v.picklist(['unstarted', 'restoring', 'attached', 'repair', 'unattached'])),
    running: v.optional(v.boolean()), unready: v.optional(v.string()), lastAttach: v.optional(AttachOutcomeSchema), bootId: v.optional(v.string()),
    chain: v.optional(v.nullable(v.looseObject({
      base: v.optional(v.looseObject({ ...LayerObservationSchema.entries, id: v.optional(v.string()) })),
      delta: v.optional(v.nullable(LayerObservationSchema)), mode: v.optional(v.string()), rev: v.optional(v.number()),
    }))),
    incidents: v.optional(v.looseObject({ total: v.optional(v.number()), undelivered: v.optional(v.number()) })),
  })),
}) satisfies v.GenericSchema<StateReply>;

export interface KickReply { ok?: boolean; ms?: number; error?: string }

export const KickReplySchema = v.looseObject({
  ok: v.optional(v.boolean()), ms: v.optional(v.number()), error: v.optional(v.string()),
}) satisfies v.GenericSchema<KickReply>;

export interface StartupPoll {
  readonly attach: AttachOutcome;
  readonly state: StateReply;
  readonly redrives: number;
}

export interface StartupCompletion extends StartupPoll {
  readonly ms: number;
  readonly startedAt: number;
}

export const StartupCompletionSchema = v.looseObject({
  attach: AttachOutcomeSchema, state: StateReplySchema, redrives: v.number(), ms: v.number(), startedAt: v.number(),
}) satisfies v.GenericSchema<StartupCompletion>;

export interface StartupObservation {
  readonly event: 'kick' | 'state' | 'drive';
  readonly startedAt: number;
  finishedAt: number | null;
  reply: KickReply | StateReply | ExecReply | null;
  error: string | null;
}

const StartupObservationClock = {
  startedAt: v.number(), finishedAt: v.nullable(v.number()), error: v.nullable(v.string()),
};

export const StartupObservationSchema = v.variant('event', [
  v.looseObject({ ...StartupObservationClock, event: v.literal('kick'), reply: v.nullable(KickReplySchema) }),
  v.looseObject({ ...StartupObservationClock, event: v.literal('state'), reply: v.nullable(StateReplySchema) }),
  v.looseObject({ ...StartupObservationClock, event: v.literal('drive'), reply: v.nullable(ExecReplySchema) }),
]) satisfies v.GenericSchema<StartupObservation>;

export interface DestroyReply extends KickReply { destroyed?: boolean }

export const DestroyReplySchema = v.looseObject({
  ...KickReplySchema.entries, destroyed: v.optional(v.boolean()),
}) satisfies v.GenericSchema<DestroyReply>;

export interface TeardownReply extends KickReply {
  discarded?: boolean;
  purged?: number;
  emptyBucketGuaranteed?: boolean;
}

export const TeardownReplySchema = v.looseObject({
  ...KickReplySchema.entries, discarded: v.optional(v.boolean()), purged: v.optional(v.number()), emptyBucketGuaranteed: v.optional(v.boolean()),
}) satisfies v.GenericSchema<TeardownReply>;
