/**
 * Run events — Flue-style discriminated union for everything that happens
 * during an agent run.
 *
 * Persisted in run_events table; queried via /api/runs/<runId>/events;
 * streamed via /api/runs/<runId>/stream (SSE w/ Last-Event-ID resume).
 *
 * Each event carries `runId` + `eventIndex` (monotonic per run) + `timestamp`.
 * Consumers may filter by `type` and slice by index.
 */

import type { ModelMessage } from 'ai';
import type { ContextBudgetSnapshot } from '../context-budget.js';
import type { JsonValue } from '../utils/json.js';
import type { ContextComposition } from '../context-meter.js';
import type { FileEditSnapshot } from '../tools/file-ledger.js';
import type { EscalationSnapshot } from '../execution/escalation.js';
import type { MissionBudgetRefusal } from '../mission-budget.js';
import type { HeadFileChangeSet } from '../heads/types.js';
import type { Usage } from '../usage.js';

/**
 * What one finished step cost — the provider's own report, plus what we priced
 * it at. Derived from the durable schema rather than declared, so the payload a
 * reader gets and the row that was stored cannot drift.
 *
 * `usage` is what the provider said, absent field by absent field (see
 * `../usage.ts`). `usd` is present only when the model carried a models.dev
 * catalog rate at the time of the call — an absent `usd` means unpriced, never
 * free — and it is deliberately NOT inside `usage`, because a price is something
 * we computed and the rest is something a provider measured.
 */
export type StepCost = Pick<
  Extract<RunEvent, { type: 'step_finish' }>, 'usage' | 'usd' | 'modelId'
>;

/** Kept as an explicit list because `RunEventBase` carries `type`, so deriving
 *  it from the union below is circular. */
export type RunEventType =
  | 'run_start'
  | 'turn_start'
  | 'tool_call_end'
  | 'step_finish'
  | 'head_split'
  | 'head_merge'
  | 'head_abandoned'
  | 'scaffold_promotion'
  | 'scaffold_rollback'
  | 'memory_write'
  | 'context_budget'
  | 'file_edit'
  | 'turn_steering'
  | 'completion_gate'
  | 'craft_cycle'
  | 'execution_recovery'
  | 'execution_escalation'
  | 'budget_exhausted'
  | 'fiber_recovered'
  | 'error'
  | 'turn_end'
  | 'run_end';

export interface RunEventBase {
  /** Unique within a single run; monotonically increasing. */
  readonly eventIndex: number;
  /** Unique run identifier (typically the chat turn id or a fresh nanoid). */
  readonly runId: string;
  readonly type: RunEventType;
  /** ISO timestamp at emission time. */
  readonly timestamp: string;
}

export type RunEvent =
  | (RunEventBase & { type: 'run_start'; agentId: string; userMessage?: string;
      /** What kicked off this run: 'chat' | 'webhook' | 'timer' | 'peer' | … */
      caused_by?: string;
      /** Ingress descriptor kind for event-triggered runs (webhook_hmac, …). */
      ingress_kind?: string;
      /** The trigger that fired this run, when event-driven. */
      trigger_id?: string })
  | (RunEventBase & { type: 'turn_start'; turnIndex: number })
  /** One completed tool call, and — in `args` — WHAT it was asked to do.
   *
   *  There is no matching `tool_call_start`. One existed, declared in this
   *  union and read by three readers, and no producer ever wrote it: the
   *  backends' sinks emit this row and `step_finish`, so a `tool_call_start`
   *  reader reported zero forever and was believed. It is deleted rather than
   *  implemented because a start row cannot answer the question a failure
   *  ledger is asked — which call FAILED and what it was doing — without a
   *  join, and the join key here is a per-turn ordinal, not the provider's id.
   *
   *  `args` is therefore on the row that carries the failure. It is a digest
   *  (`digestJsonValue`), so a `write` of a large body is described rather than
   *  duplicated: the durable cost of the ledger tracks what the turn DID, not
   *  how much content it moved. Absent when the call took no arguments.
   *
   *  `error` is the transport discriminator — the tool threw. A command that
   *  ran and exited non-zero is a SUCCESSFUL call whose `result` text begins
   *  `Error (exit N)`; the two are different facts and a reader that wants
   *  "did the work fail" must consult both. When present it is NEVER empty:
   *  see `FAILURE_WITHOUT_ERROR`. */
  | (RunEventBase & { type: 'tool_call_end'; name: string; toolCallId: string;
      args?: JsonValue; result?: JsonValue; error?: string; durationMs?: number })
  /** One model request completed — and, in `messages`, WHAT it produced: the
   *  assistant parts and paired tool results of that step alone, appended the
   *  moment the step finished. This is the durable record of the model's own
   *  output. Nothing else writes it: a backend's message store is written once
   *  per turn, so before this row existed a turn killed at step 12 left twelve
   *  steps of work nowhere on disk.
   *
   *  Pairing holds WITHIN a row by construction — the SDK reports a step's
   *  assistant tool-call parts and their tool results together — so a run's
   *  rows concatenate into a valid request without repair. Absent on a step the
   *  provider ended with nothing to say; never fabricated.
   *
   *  `usage` is the provider's own report of that request — the authority on
   *  what it cost, field by field, with anything the provider did not mention
   *  absent rather than zero. `usd` is that report priced at the model's catalog
   *  rate, absent when the model is unpriced. `context` is what the request was
   *  locally measured to be made of; usage and context do not reconcile exactly
   *  and are carried side by side so a reader can see the gap. All of them are
   *  absent when the step produced no such report. */
  | (RunEventBase & {
      type: 'step_finish';
      stepIndex: number;
      reason?: string;
      messages?: ModelMessage[];
      usage?: Usage;
      usd?: number;
      modelId?: string;
      context?: ContextComposition;
    })
  | (RunEventBase & { type: 'head_split'; rootId: string; headIds: string[]; rationale: string })
  /** A split settled. `headsWithFindings` vs `headCount` is how many forks came
   *  back with something against how many returned empty, `totalTokens` is what
   *  the whole split cost, and `fileChanges` is what it changed — so the
   *  productivity of delegation is a query over the ledger instead of a
   *  hand-read of trajectories.
   *
   *  `totalTokens` is ABSENT when no head in the split reported usage. A split
   *  served by a silent provider did not cost zero tokens; it cost an unknown
   *  number, and a delegation-productivity query that read those as free would
   *  rank the unmeasured split as the cheapest. */
  | (RunEventBase & { type: 'head_merge'; rootId: string; headCount: number;
      headsWithFindings: number; totalTokens?: number; mergedNarrative: string;
      /** Which files each head created, changed or deleted, with line counts —
       *  so "what did that delegation actually do to the workspace" is a query
       *  over the ledger rather than a re-read of the narrative. Heads that
       *  changed nothing are absent. */
      fileChanges: HeadFileChangeSet[];
      /** Ground the merge says NO head covered. Recorded because the field's
       *  own value is unmeasured: whether it reports real negative space or
       *  degenerates into filler is settled by reading these rows across real
       *  splits, not by argument. Empty on the deterministic empty-split and
       *  merge-fallback paths, which never reach a model. */
      blindSpots: string[] })
  /** A split that never settled — retired at the start of a later activation
   *  because nothing was left to run it (heads/reconcile.ts).
   *
   *  The terminal counterpart to `head_split` on the path where `head_merge`
   *  never arrives. Without it the ledger held a split with no outcome, which is
   *  byte-for-byte what a fork still in flight looks like: the Timeline rendered
   *  a "Heads split" span nothing closed, and a delegation-productivity query
   *  counted the spend against no result it could see. `abandoned` against
   *  `headCount` is how much of the split was still unreported when it died —
   *  the rest had already returned, and their reports stand. */
  | (RunEventBase & { type: 'head_abandoned'; rootId: string; headCount: number;
      abandoned: number; rationale: string; reason: string })
  | (RunEventBase & { type: 'scaffold_promotion'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'scaffold_rollback'; fromVersion: number; toVersion: number })
  | (RunEventBase & { type: 'memory_write'; path: string; bytes: number })
  /** The turn's bulk-ingestion ledger — how much tool output the root actually
   *  admitted, what every producer spilled instead, and whether the agent read
   *  any of it back. Written once per turn by the settle spine (M1 trip
   *  counters); `turn_end` is the denominator. */
  | (RunEventBase & { type: 'context_budget' } & ContextBudgetSnapshot)
  /** What this turn's `file` edits did: how many were attempted, how many
   *  landed, which exact-match failures they hit, and whether the model came
   *  back and got the file right. Written once per turn by the settle spine
   *  like `context_budget`, only for turns that attempted an edit. Shell-based
   *  edits could not produce this row at all — `sed -i` exits 0 whether or not
   *  it matched anything — which is why the primitive is what makes edit
   *  success a gradable signal. */
  | (RunEventBase & { type: 'file_edit' } & FileEditSnapshot)
  /** The harness mechanically steered the turn, and whether the model then did
   *  what the steer asked. At most two per turn — the turn-start hint and the
   *  one reactive steer — written by the settle spine like `context_budget`;
   *  `turn_end` is the denominator, `converted` the conversion numerator, and
   *  `trigger` is what separates the turn-start arm from the step-25 one.
   *  Declared here rather than imported from the producer
   *  (orchestrator/turn-steering.ts): this union is reachable from most of the
   *  turn pipeline, and the producer holds mid-turn injection machinery no
   *  other layer may reach. */
  | (RunEventBase & { type: 'turn_steering';
      /** Which mechanical trigger fired. */
      trigger: 'repeated_call' | 'repeated_failure' | 'no_progress'
        | 'long_turn_no_delegation' | 'turn_start_no_delegation';
      /** Step boundary the steer was spliced into. */
      step: number;
      /** The tool that kept repeating or failing (not the long-turn trigger). */
      tool?: string;
      /** The model did what the steer asked: reached for `agents` after a
       *  delegation steer, or called something other than the repeating call
       *  after a repeat steer. */
      converted: boolean })
  /** The one-shot completion gate fired: the harness refused to let the run end
   *  on the model's own say-so and handed it freshly observed state first.
   *  At most one per one-shot run, written by the settle spine when the
   *  confirming turn closes — `converted` says the re-look found real work to
   *  do rather than confirming a claim. */
  | (RunEventBase & { type: 'completion_gate';
      /** The agent made tool calls after seeing the observed state. */
      converted: boolean })
  /** The in-episode craft loop's turn record — did the agent build itself a
   *  tool mid-episode, did it reach for that tool again, and did the reach
   *  work. Written once per turn by the settle spine like `turn_steering`,
   *  with `turn_end` as the denominator: the durable trail an analysis can read
   *  without asking the model anything. Declared here rather than imported from
   *  the producer (orchestrator/craft-cycle.ts) for the same reason the steering
   *  record is: this union is reachable from most of the turn pipeline, the
   *  producer is not. */
  | (RunEventBase & { type: 'craft_cycle';
      /** Crafted tools that came into existence during this turn. */
      crafted: string[];
      /** Crafted tools whose call sites appeared in a settled execute call. */
      invoked: string[];
      /** Crafted THIS turn and then called by a LATER execute call — the
       *  in-episode loop actually closing, and the numerator to report. */
      reused: string[];
      /** Observations recorded: invocations that returned, and invocations
       *  that raised and were attributed to the tool itself. */
      returned: number;
      raised: number;
      /** Crafted tools this turn's execution evidence pushed below the
       *  injection floor — retirement, in-episode. */
      dropped: string[] })
  /** The step clock's knowledge channel fired: failure streaks the turn's own
   *  ledger saw broken by a CHANGED call that ran clean, each recorded as a
   *  durable finding and injected for the rest of the episode
   *  (evolution/recovery.ts). Written once per turn by the settle spine like
   *  `craft_cycle`, with `turn_end` as the denominator. Declared here rather
   *  than imported from the producer for the same reason the other turn
   *  records are. */
  | (RunEventBase & { type: 'execution_recovery';
      recoveries: Array<{
        /** The tool whose streak broke. */
        tool: string;
        /** Consecutive failures before the changed call. */
        failures: number;
        /** Stable signature of the failing call — the SAME signature failing
         *  again in a later turn is the direct falsifier that the finding
         *  did not take. */
        failedSignature: string }> })
  /** The turn escalated: it ran work in a provisioned environment rather than
   *  its own shell, and this is why and how that turned out. Written once per
   *  turn by the settle spine, with `turn_end` as the denominator, so "did
   *  escalating help" is answerable from the log alone. The shape is the
   *  ledger's own (execution/escalation.ts) rather than a second declaration —
   *  same composition as `context_budget` and `file_edit`. */
  | (RunEventBase & { type: 'execution_escalation' } & EscalationSnapshot)
  /** A mission budget ran out and a host seam declined the work. Written once
   *  per label by the governor (mission-budget.ts), so the durable trail says
   *  which cap stopped which run rather than leaving an unexplained short turn. */
  | (RunEventBase & { type: 'budget_exhausted' } & Omit<MissionBudgetRefusal, 'error'>)
  | (RunEventBase & { type: 'fiber_recovered'; fiberName: string; fiberId: string; snapshot?: unknown })
  | (RunEventBase & { type: 'error'; message: string; details?: unknown })
  /** `usage` is what the turn's steps reported, accumulated field by field —
   *  absent entirely when no step reported anything, and absent per field where
   *  no step's provider mentioned it. */
  | (RunEventBase & { type: 'turn_end'; turnIndex: number; usage?: Usage })
  | (RunEventBase & { type: 'run_end'; reason?: string;
      /** The provider/stream error text (truncated) when the run ended in
       *  status 'error' — the durable evidence a post-hoc investigation needs
       *  (Think persists only the LAST terminal error, which a later failure
       *  overwrites). */
      error?: string });

/** One turn's mechanical steer — what the steering object reports and what the
 *  settle spine writes, derived from the durable schema so there is one
 *  declaration. */
export type TurnSteeringRecord =
  Omit<Extract<RunEvent, { type: 'turn_steering' }>, keyof RunEventBase | 'type'>;

export type TurnSteeringTrigger = TurnSteeringRecord['trigger'];

/** One run's completion gate — derived from the durable schema for the same
 *  reason as the steering record: one declaration, no drift. */
export type CompletionGateRecord =
  Omit<Extract<RunEvent, { type: 'completion_gate' }>, keyof RunEventBase | 'type'>;

/** One turn's in-episode craft loop — what the cycle reports and what the
 *  settle spine writes, derived from the durable schema so there is one
 *  declaration. */
export type CraftCycleRecord =
  Omit<Extract<RunEvent, { type: 'craft_cycle' }>, keyof RunEventBase | 'type'>;

/** One turn's execution recoveries — derived from the durable schema for the
 *  same reason as the records above: one declaration, no drift. */
export type ExecutionRecoveryRecord =
  Omit<Extract<RunEvent, { type: 'execution_recovery' }>, keyof RunEventBase | 'type'>;

/** A new event payload sans the base fields the recorder fills in. */
export type RunEventInput = {
  [K in RunEvent['type']]: Omit<Extract<RunEvent, { type: K }>, keyof RunEventBase> & { type: K }
}[RunEvent['type']];

/**
 * What a call that failed WITHOUT saying why records as.
 *
 * An empty `error` is no error to every reader — the one predicate they share
 * is `error != null && error !== ''` — and the producer used to manufacture
 * exactly that from a tool reporting `success: false` with a nullish error
 * (`String(c.error ?? '')`). So the worst calls in a turn were the ones that
 * vanished from it: a tool failing on a missing runtime method reported failure
 * with nothing to report, and the ledger scored it as a clean call. The
 * accumulator KNEW — it flips `hadError` on the same branch — and discarded it
 * at the event boundary.
 *
 * A sentinel and not prose because both the producer and the failure census
 * name it, and a reader that has to match prose is a reader that will drift
 * from the writer.
 */
export const FAILURE_WITHOUT_ERROR = 'the tool reported failure without an error';
