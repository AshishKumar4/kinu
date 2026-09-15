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
  *  system role) — the test asserts every recorded call is a known lane. */
  lane: v.picklist(['turn', 'sleep', 'title']),
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

export type QueueProbeMode = 'chat' | 'peer' | 'signal' | 'yield' | 'cold' | 'attach' | 'attach-cold' | 'evt';

/** One durable input row `actor_turn_inputs` persisted — the request-owned
 *  admission ledger the cold test reads across a reset. */
export const InputReceiptSchema = v.object({
  actorId: v.string(),
  requestId: v.string(),
  messageIds: v.array(v.string()),
  settled: v.boolean(),
});

export type InputReceipt = v.InferOutput<typeof InputReceiptSchema>;

/** A durable `pending_steers` row — the reservation a mid-turn send writes:
 *  the client's own message id bound to the turn it will land in. */
export const PendingSteerSchema = v.object({
  actorId: v.string(),
  id: v.string(),
  turnId: v.string(),
  mode: v.string(),
  text: v.string(),
});

export type PendingSteer = v.InferOutput<typeof PendingSteerSchema>;

/** A `pending_steer_files` row — the file parts reserved with a pending steer. */
export const PendingSteerFileSchema = v.object({
  actorId: v.string(),
  steerId: v.string(),
  filename: v.string(),
  mediaType: v.string(),
  url: v.string(),
});

export type PendingSteerFile = v.InferOutput<typeof PendingSteerFileSchema>;

export const PreparedConversationSchema = v.object({
  workspace: v.string(),
  owner: v.string(),
  /** The exact client frames that carried B and the still-pending C —
   *  replayed verbatim after the reset. */
  bFrame: v.string(),
  cFrame: v.string(),
  /** Every durable input row at prepare time (idle-path admissions only). */
  receipts: v.array(InputReceiptSchema),
  /** The durable mid-turn reservations at prepare time — B's in-flight send and
   *  C's queued send, each bound to the turn it will land in. */
  steers: v.array(PendingSteerSchema),
  /** The file rows reserved beside the steers — the durable half of any
   *  attachment a mid-turn send carried. */
  steerFiles: v.array(PendingSteerFileSchema),
});

export type PreparedConversation = v.InferOutput<typeof PreparedConversationSchema>;

/** A `kind='event'` row of `agent_log`, the fields an unbindStale sweep flips. */
export const AgentLogEventSchema = v.object({
  id: v.string(),
  turnId: v.nullable(v.string()),
  consumedAt: v.nullable(v.number()),
  variant: v.string(),
});

export type AgentLogEvent = v.InferOutput<typeof AgentLogEventSchema>;

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
  /** Owed-effect keys any finished close left behind — empty is clean. */
  owedEffects: v.array(v.string()),
  factsCompressed: v.number(),
});

export type ExerciseResult = v.InferOutput<typeof ExerciseResultSchema>;


/** One parameterized drive (the early-[DONE] variant): its own workspace so
 *  its turns never share Think state with the main drive. */
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
  factsCompressed: v.number(),
});

export type DriveOnceResult = v.InferOutput<typeof DriveOnceResultSchema>;

// ── The parity drive ───────────────────────────────────────────────────────
//
// JSON columns cross the RPC as the STRINGS they are stored as: a recursive
// JSON type is what the stub's Serializable map cannot carry (TS2589), and the
// test parses them on its own side anyway.

/** One frame a probe socket received, reduced to what the script decides. */
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
});

export type ParityFrame = v.InferOutput<typeof ParityFrameSchema>;

/** The durable record of the root at one point of the parity script — raw
 *  rows, normalized by the test, so the probe stays a reader. */
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
  /** The run ledger, restricted to the rows the continuation invariant reads. */
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
  /** The parity-lane model calls made before the reset. */
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

/** The wake proof's marker: what the detached command prints, and what the
 *  woken turn's reply must carry back. */
export const WAKE_MARKER = 'KINU_SETTLED_AFTER_DETACH';

/** Where the wake proof holds the interactive turn while its detached job
 *  settles: inside the running turn's reply step, or inside its settle. */
export const WakeHoldPlacementSchema = v.picklist(['reply', 'settle']);

export type WakeHoldPlacement = v.InferOutput<typeof WakeHoldPlacementSchema>;

/** What the background-wake drive hands back: the job row the detached
 *  command settled, the runs the ledger holds with what each was started for,
 *  the transcript, and the two instants that prove the settle window was held
 *  when the job settled. */
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
  /** When the drive released the held title call — after the job had settled. */
  releasedAt: v.number(),
  /** The runner's own settle instant, off the job row. */
  settledAt: v.number(),
  calls: v.array(v.object({ model: v.string(), users: v.array(v.string()), toolResults: v.array(v.string()) })),
});

export type WakeDriveResult = v.InferOutput<typeof WakeDriveResultSchema>;
