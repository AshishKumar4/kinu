/**
 * The two-turn probe's wire shapes. Kept apart from `two-turn-probe.ts`: that imports production `src`,
 * which the workerd typecheck project excludes; this imports only valibot. Fields are schema outputs,
 * never `object`/`unknown`, which the RPC stub's `Serializable` map cannot carry (TS2589).
 */
import * as v from 'valibot';

export const CallRecordSchema = v.object({
  model: v.string(),
  /** The request's own stream flag, separating turn calls from completion lanes. */
  stream: v.boolean(),
  /** The lane the fake served, keyed on request shape (stream flag, leading system role). */
  lane: v.picklist(['turn', 'sleep', 'title']),
  users: v.array(v.string()),
  /** What `options.signal` arrived as — the spike's answer. */
  signalKind: v.string(),
});

export type CallRecord = v.InferOutput<typeof CallRecordSchema>;

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

export const HttpCallSchema = v.object({
  url: v.string(),
  method: v.string(),
  host: v.string(),
  path: v.string(),
  model: v.string(),
  stream: v.boolean(),
  users: v.array(v.string()),
  conversation: v.array(v.object({ role: v.string(), content: v.string() })),
  fileParts: v.array(v.array(v.object({ type: v.string(), url: v.string() }))),
  authHeader: v.nullable(v.string()),
  offeredTools: v.array(v.string()),
  toolCalls: v.array(v.object({ id: v.string(), name: v.string() })),
  toolResults: v.array(v.string()),
});

export type HttpCall = v.InferOutput<typeof HttpCallSchema>;

/** A queue probe's model log, and in signal mode the `run_task` answer its MCP caller got. */
export const QueuedConversationSchema = v.object({
  http: v.array(HttpCallSchema),
  task: v.nullable(TurnSchema),
});

export type QueuedConversation = v.InferOutput<typeof QueuedConversationSchema>;

export type QueueProbeMode = 'chat' | 'peer' | 'signal' | 'yield' | 'cold' | 'attach' | 'attach-cold' | 'evt' | 'rwake' | 'twin';

/** A durable `pending_steers` row; `turn_id` is null when reserved before a turn opens. */
export const PendingSteerSchema = v.object({
  actorId: v.string(),
  id: v.string(),
  turnId: v.nullable(v.string()),
  mode: v.string(),
  text: v.string(),
});

export type PendingSteer = v.InferOutput<typeof PendingSteerSchema>;

export const PendingSteerFileSchema = v.object({
  actorId: v.string(),
  steerId: v.string(),
  filename: v.string(),
  mediaType: v.string(),
  url: v.string(),
});

export type PendingSteerFile = v.InferOutput<typeof PendingSteerFileSchema>;

/** What one raw chat frame, sent while a turn's provider call is held, leaves behind. */
export interface RawChatProbeResult {
  /** The `steer_status` heard while the provider was held (`queued`); absent if never announced. */
  readonly admission: string;
  /** The done frame's `landed`: `'mid-turn'` for a splice, `'closed'` for a turn of their own. */
  readonly landing: string;
  readonly pendingIds: readonly string[];
  readonly persistedWhileHeld: boolean;
  readonly landed: readonly { id: string; text: string; atStep: number }[];
  readonly calls: readonly HttpCall[];
  readonly answerCount: number;
}

export const PreparedConversationSchema = v.object({
  workspace: v.string(),
  owner: v.string(),
  /** The client frames that carried B and still-pending C, replayed verbatim after the reset. */
  bFrame: v.string(),
  cFrame: v.string(),
  /** Every durable input row at prepare time (idle-path admissions only). */
  /** Mid-turn reservations at prepare time, each bound to the turn it will land in. */
  steers: v.array(PendingSteerSchema),
  steerFiles: v.array(PendingSteerFileSchema),
});

export type PreparedConversation = v.InferOutput<typeof PreparedConversationSchema>;

export const AgentLogEventSchema = v.object({
  id: v.string(),
  turnId: v.nullable(v.string()),
  consumedAt: v.nullable(v.number()),
  variant: v.string(),
});

export type AgentLogEvent = v.InferOutput<typeof AgentLogEventSchema>;

/** What the arrival's call saw before its eviction: the schedule registry's callbacks, due or future,
 *  before the arrival and once its detached arm landed, and the peer rows at the abort. */
export const ReactorEvictionSchema = v.object({
  armedBefore: v.array(v.string()),
  armedAfter: v.array(v.string()),
  evictedWith: v.array(AgentLogEventSchema),
});

export type ReactorEviction = v.InferOutput<typeof ReactorEvictionSchema>;

/** The eviction, then the peer rows after the fresh activation's first `_kinuTimerTick` and the run causes. */
export interface ReactorWake extends ReactorEviction {
  readonly drained: AgentLogEvent[];
  readonly causes: string[];
}

export const ExerciseResultSchema = v.object({
  register: RegisterSchema,
  claim: ClaimSchema,
  model: ModelSchema,
  turnA: TurnSchema,
  turnB: TurnSchema,
  snapshot: SnapshotSchema,
  history: HistorySchema,
  calls: v.array(CallRecordSchema),
  http: v.array(HttpCallSchema),
  failures: v.array(DiagnosticFailureSchema),
  owedEffects: v.array(v.string()),
  sleepTimeSettled: v.number(),
  /** `models_dev.catalog_fallback` events emitted. Zero proves the catalog was served, not
   *  refused (refused: 51 slow fallbacks per gate run, measured 2026-09-15). */
  catalogFallbacks: v.number(),
  catalogHits: v.number(),
});

export type ExerciseResult = v.InferOutput<typeof ExerciseResultSchema>;


/** The early-[DONE] variant, in its own workspace so it never shares Think state. */
export const DriveOnceInputSchema = v.object({
  workspace: v.string(),
  owner: v.string(),
  displayName: v.string(),
  model: v.string(),
  text: v.string(),
  seedFile: v.optional(v.object({ path: v.string(), content: v.string() })),
});

export type DriveOnceInput = v.InferOutput<typeof DriveOnceInputSchema>;

export const DriveOnceResultSchema = v.object({
  turn: TurnSchema,
  snapshot: SnapshotSchema,
  history: HistorySchema,
  calls: v.array(CallRecordSchema),
  http: v.array(HttpCallSchema),
  failures: v.array(DiagnosticFailureSchema),
  owedEffects: v.array(v.string()),
  sleepTimeSettled: v.number(),
  /** `models_dev.catalog_fallback` events emitted. Zero proves the catalog was served, not
   *  refused (refused: 51 slow fallbacks per gate run, measured 2026-09-15). */
  catalogFallbacks: v.number(),
  catalogHits: v.number(),
});

export type DriveOnceResult = v.InferOutput<typeof DriveOnceResultSchema>;

// JSON columns cross the RPC as their stored strings: a recursive JSON type exceeds the stub's
// Serializable map (TS2589).

export const ParityFrameSchema = v.object({
  socket: v.string(),
  type: v.string(),
  id: v.optional(v.string()),
  done: v.optional(v.boolean()),
  error: v.optional(v.boolean()),
  landed: v.optional(v.string()),
  replay: v.optional(v.boolean()),
  continuation: v.optional(v.boolean()),
  body: v.optional(v.string()),
  steerId: v.optional(v.string()),
  status: v.optional(v.string()),
});

export type ParityFrame = v.InferOutput<typeof ParityFrameSchema>;

/** Raw rows of the root at one point of the parity script; the test normalizes them. */
export const ParityRowsSchema = v.object({
  assistantMessages: v.array(v.object({
    id: v.string(), parentId: v.nullable(v.string()), role: v.string(), content: v.string(),
  })),
  pendingSteers: v.array(PendingSteerSchema),
  pendingSteerFiles: v.array(PendingSteerFileSchema),
  agentLog: v.array(v.object({
    id: v.string(), kind: v.string(), turnId: v.nullable(v.string()), variant: v.nullable(v.string()),
    consumed: v.boolean(), payload: v.string(),
  })),
  terminalEffects: v.array(v.object({
    sequenceId: v.string(), effectKey: v.string(), effectName: v.string(), scope: v.string(), seq: v.number(),
    input: v.string(), lane: v.string(), status: v.string(), outcome: v.nullable(v.string()),
    attempts: v.number(), settled: v.boolean(),
  })),
  runEvents: v.array(v.object({ runId: v.string(), type: v.string(), payload: v.string() })),
});

export type ParityRows = v.InferOutput<typeof ParityRowsSchema>;

const ParityModelCallSchema = v.object({ users: v.array(v.string()), toolResults: v.array(v.string()), roles: v.array(v.string()) });

export const ParityPreparedSchema = v.object({
  workspace: v.string(),
  owner: v.string(),
  frames: v.array(ParityFrameSchema),
  landings: v.record(v.string(), v.nullable(v.string())),
  afterTwo: ParityRowsSchema,
  beforeRestart: ParityRowsSchema,
  modelCallsBefore: v.array(ParityModelCallSchema),
});

export type ParityPrepared = v.InferOutput<typeof ParityPreparedSchema>;

export const ParityCompletedSchema = v.object({
  frames: v.array(ParityFrameSchema),
  landings: v.record(v.string(), v.nullable(v.string())),
  end: ParityRowsSchema,
  modelCallsAfter: v.array(ParityModelCallSchema),
  failures: v.array(DiagnosticFailureSchema),
});

export type ParityCompleted = v.InferOutput<typeof ParityCompletedSchema>;

/** Printed by the detached command; the woken turn's reply must carry it back. */
export const WAKE_MARKER = 'KINU_SETTLED_AFTER_DETACH';

/** Where the interactive turn is held while its detached job settles. */
export const WakeHoldPlacementSchema = v.picklist(['reply', 'settle']);

export type WakeHoldPlacement = v.InferOutput<typeof WakeHoldPlacementSchema>;

/** Includes the two instants that prove the settle window was held when the job settled. */
export const WakeRowsSchema = v.object({
  jobs: v.array(v.object({
    id: v.string(), kind: v.string(), status: v.string(), result: v.nullable(v.string()), settledAt: v.nullable(v.number()),
  })),
  runs: v.array(v.object({ runId: v.string(), userMessage: v.string(), reason: v.nullable(v.string()) })),
  assistantTexts: v.array(v.string()),
});

export type WakeRows = v.InferOutput<typeof WakeRowsSchema>;

export const WakeDriveResultSchema = v.object({
  where: WakeHoldPlacementSchema,
  rows: WakeRowsSchema,
  releasedAt: v.number(),
  settledAt: v.number(),
  calls: v.array(v.object({ model: v.string(), users: v.array(v.string()), toolResults: v.array(v.string()) })),
});

export type WakeDriveResult = v.InferOutput<typeof WakeDriveResultSchema>;
