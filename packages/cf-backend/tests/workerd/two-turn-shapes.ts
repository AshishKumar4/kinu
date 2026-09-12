/**
 * The two-turn probe's wire shapes — schemas AND their InferOutput types.
 *
 * Lives apart from `two-turn-probe.ts` on purpose: the probe entry imports
 * production `src`, so the workerd typecheck project excludes it (see the
 * `//exclude` note in this directory's tsconfig — importing it here would
 * drag the whole worker into a project whose globals lack the ambient `Env`).
 * This module imports only valibot, so the test, the probe, and `env.d.ts`
 * can all name the same shapes without pulling `src` along. The probe parses
 * every product answer through these at its own boundary, so the RPC
 * declaration below can never drift from what crosses the wire — and every
 * field is a schema output rather than `object` or `unknown`, which the RPC
 * stub's `Serializable` map cannot carry (TS2589).
 */
import * as v from 'valibot';

export const CallRecordSchema = v.object({
  model: v.string(),
  /** The request's own stream flag — the turn calls, separated from the
   *  completion lanes the same binding serves. */
  stream: v.boolean(),
  /** The lane the fake served, keyed on request shape (stream flag, leading
   *  system role) or the model-routed arm below — the test asserts every
   *  recorded call is a known lane. */
  lane: v.picklist(['turn', 'sleep', 'title', 'pending']),
  users: v.array(v.string()),
  /** What `options.signal` arrived as — the spike's answer. */
  signalKind: v.string(),
});

export type CallRecord = v.InferOutput<typeof CallRecordSchema>;

/** A captured product failure, for the clean-log assertion. */
export const DiagnosticFailureSchema = v.object({
  event: v.string(),
  code: v.string(),
  cause: v.string(),
});

export type DiagnosticFailure = v.InferOutput<typeof DiagnosticFailureSchema>;

/** `claimOwner` answers `{ owner, capabilityHash }` (orchestrator.ts:2312). */
export const ClaimSchema = v.object({ owner: v.string(), capabilityHash: v.nullable(v.string()) });

export type ClaimResult = v.InferOutput<typeof ClaimSchema>;

/** `registerWorkspace` answers `WorkspaceRegistration` (user-do.ts:487). */
export const RegisterSchema = v.variant('status', [
  v.object({
    status: v.picklist(['created', 'active']),
    entry: v.object({
      name: v.string(),
      displayName: v.string(),
      createdAt: v.number(),
      lastVisited: v.number(),
      archivedAt: v.nullable(v.number()),
    }),
  }),
  v.object({ status: v.literal('reserved') }),
]);

export type RegisterResult = v.InferOutput<typeof RegisterSchema>;

/** `setModel` answers `{ ok: true, spec }` (config-plane.ts:76). */
export const ModelSchema = v.object({ ok: v.literal(true), spec: v.string() });

export type ModelResult = v.InferOutput<typeof ModelSchema>;

/** `runTaskFromMcp` answers `EnqueueTurnResult` (backend-host.ts:74). */
export const TurnSchema = v.object({
  status: v.picklist(['queued', 'skipped']),
  durable: v.optional(v.object({
    submissionId: v.string(),
    accepted: v.boolean(),
    status: v.picklist(['pending', 'running', 'completed', 'aborted', 'skipped', 'error']),
  })),
});

export type TurnResult = v.InferOutput<typeof TurnSchema>;

/** The open read's status slice and the history page — the assertion shapes. */
export const SnapshotSchema = v.object({
  status: v.object({
    messageCount: v.number(),
    model: v.string(),
  }),
});

export type SnapshotResult = v.InferOutput<typeof SnapshotSchema>;

export const HistorySchema = v.object({
  status: v.picklist(['more', 'end']),
  items: v.array(v.object({ role: v.string(), content: v.string() })),
});

export type HistoryResult = v.InferOutput<typeof HistorySchema>;

export const ExerciseResultSchema = v.object({
  register: RegisterSchema,
  claim: ClaimSchema,
  model: ModelSchema,
  turnA: TurnSchema,
  turnB: TurnSchema,
  snapshot: SnapshotSchema,
  history: HistorySchema,
  calls: v.array(CallRecordSchema),
  failures: v.array(DiagnosticFailureSchema),
  /** Owed-effect keys any finished close left behind — empty is clean. */
  owedEffects: v.array(v.string()),
  factsCompressed: v.number(),
});

export type ExerciseResult = v.InferOutput<typeof ExerciseResultSchema>;

/** The caller-cancellation repro verdict: the pending arm saw the abort, no
 *  abort listener is left behind, and the run promise rejected with a reason. */
export const CancelProbeResultSchema = v.object({
  observedAbort: v.boolean(),
  activeListeners: v.number(),
  rejection: v.string(),
});

export type CancelProbeResult = v.InferOutput<typeof CancelProbeResultSchema>;

/** One parameterized drive (the early-[DONE] variant): its own workspace so
 *  its turns never share Think state with the main drive. */
export const DriveOnceInputSchema = v.object({
  workspace: v.string(),
  owner: v.string(),
  displayName: v.string(),
  model: v.string(),
  text: v.string(),
});

export type DriveOnceInput = v.InferOutput<typeof DriveOnceInputSchema>;

export const DriveOnceResultSchema = v.object({
  turn: TurnSchema,
  snapshot: SnapshotSchema,
  history: HistorySchema,
  calls: v.array(CallRecordSchema),
  failures: v.array(DiagnosticFailureSchema),
  owedEffects: v.array(v.string()),
  factsCompressed: v.number(),
});

export type DriveOnceResult = v.InferOutput<typeof DriveOnceResultSchema>;
