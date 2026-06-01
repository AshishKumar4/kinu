/**
 * Reactor — snapshot builder + decision applier.
 *
 * The reactor itself is NOT a class; it's the literal expression
 *
 *   runAgent({ tools: REACTOR_CONTROL_TOOLS, maxSteps: 1,
 *              context: snapshotForReactor(turn), scaffoldVersion: ... })
 *
 * The TurnRunner invokes that expression when an event arrives during the
 * HEADS phase. This module provides the supporting machinery:
 *
 *   snapshotForReactor — build the ReactorSnapshot input
 *   REACTOR_PROMPT     — the canonical reactor system prompt
 *   ReactorOutputSchema — Valibot schema for the structured decision
 *   applyDecision      — execute the decision against EventLog + HeadController
 *   reactorFallback    — the (keep, defer) default emitted on LLM failure
 *
 * The decision's legality is enforced by `isLegalDecision` from types.ts.
 * Illegal decisions are rejected with `LegalityError` and the fallback runs.
 */

import * as v from 'valibot';

import {
  type EventId, type HeadId, type Phase, type ProteusEvent,
  type ReactorDecision, type RevisitCondition, type SpawnHeadSpec,
  type TraceId, type TrustLevel, type TurnId,
  isLegalDecision, LegalityError,
} from './types.js';
import { meetAll } from './trust.js';
import { renderForLLM } from './visibility.js';
import { type EventLog } from './log.js';
import { ulid } from './ulid.js';

// ── Head abstraction ─────────────────────────────────────────────

export interface HeadSummary {
  id: HeadId;
  task: string;
  head_trust: TrustLevel;
  step_count: number;
  last_step_summary: string;
  last_tool: string | null;
  spawned_at: number;
}

export interface HeadController {
  list(): Promise<HeadSummary[]>;
  read(id: HeadId): Promise<HeadSummary | null>;
  abort(id: HeadId, reason: string): Promise<void>;
  abortAll(reason: string): Promise<void>;
  spawn(spec: SpawnHeadSpec, bound_trust: TrustLevel): Promise<HeadId>;
  forceMerge(): Promise<void>;
}

// ── Snapshot ─────────────────────────────────────────────────────

export interface ReactorSnapshot {
  turn_id: TurnId;
  trace_id: TraceId;
  initiator: {
    event_id: EventId;
    trust: TrustLevel;
    scaffold_version: number;
  };
  heads: HeadSummary[];
  pending_events_batch: Array<ReturnType<typeof renderForLLM>>;
  /** Reactor's own head trust: min over pending events' trust. */
  reactor_head_trust: TrustLevel;
  /** Trust class of the events being reacted to (for legality checks). */
  events_trust_class: TrustLevel;
  budget_remaining: {
    per_turn: number;
    per_trace: number;
    per_hour: number;
  };
  phase: Phase;
}

export async function snapshotForReactor(opts: {
  turn_id: TurnId;
  trace_id: TraceId;
  initiator_event: ProteusEvent;
  scaffold_version: number;
  heads: HeadController;
  pending_events: ProteusEvent[];
  budget_remaining: { per_turn: number; per_trace: number; per_hour: number };
  phase: Phase;
}): Promise<ReactorSnapshot> {
  const headList = await opts.heads.list();
  const eventsTrust = opts.pending_events.map(e => e.trust);
  const reactorTrust = meetAll(eventsTrust);
  return {
    turn_id: opts.turn_id,
    trace_id: opts.trace_id,
    initiator: {
      event_id: opts.initiator_event.id,
      trust: opts.initiator_event.trust,
      scaffold_version: opts.scaffold_version,
    },
    heads: headList,
    pending_events_batch: opts.pending_events.map(renderForLLM),
    reactor_head_trust: reactorTrust,
    events_trust_class: reactorTrust,
    budget_remaining: opts.budget_remaining,
    phase: opts.phase,
  };
}

// ── Prompt + structured-output schema ────────────────────────────

export const REACTOR_PROMPT = `You are the reactor for a multi-head AI agent.

Several worker heads are currently running in parallel on this task:
{{HEADS_BLOCK}}

A new event (or batch of events) has arrived during execution:
{{EVENTS_BLOCK}}

Reason step-by-step (3-5 sentences):
 - Is the event relevant to any active head's work?
 - Is it time-critical (must act this turn) or can it wait?
 - Does it invalidate a head's premise, or merely add information?
 - What is the safest minimum action that handles the event correctly?

Then output a JSON object with this exact shape:

  {
    "reasoning": "<your 3-5 sentence reasoning>",
    "head_op": { "kind": "keep" } |
               { "kind": "abort_one",  "head_id": "...", "reason": "..." } |
               { "kind": "abort_all",  "reason": "..." } |
               { "kind": "add",        "spec": {"task": "...", "rationale": "...",
                                               "bound_event_ids": ["..."]} } |
               { "kind": "merge_now",  "reason": "..." },
    "event_op": { "kind": "handle" } |
                { "kind": "defer",  "revisit_at": <RevisitCondition> } |
                { "kind": "drop",   "reason": "..." }
  }

Decision guide:

  ALLOW continue   = head_op: keep,        event_op: handle  (event is
                                                              informational;
                                                              merge will see it)
  DEFER quietly    = head_op: keep,        event_op: defer   (event can wait
                                                              for next turn)
  ADD a head       = head_op: add,         event_op: handle  (event opens a
                                                              new branch worth
                                                              exploring in
                                                              parallel)
  MERGE NOW        = head_op: merge_now,   event_op: handle  (heads have
                                                              enough; event
                                                              needs a
                                                              coordinated
                                                              response)
  ABORT + REPLAN   = head_op: abort_all,   event_op: handle  (event invalidates
                                                              the current task
                                                              framing entirely)
  DROP noise       = head_op: keep,        event_op: drop    (event is
                                                              irrelevant /
                                                              low-trust noise;
                                                              only allowed for
                                                              external events
                                                              if you have
                                                              authenticated
                                                              trust)

Legality rules (the runtime will reject invalid combinations):
 - abort_one / abort_all / add require event_op: handle.
 - merge_now permits handle or defer.
 - drop requires reactor trust >= authenticated AND every event in this batch
   has trust = external.
 - add cannot fire if any head has begun merging.
`;

export const RevisitConditionSchema = v.union([
  v.object({ kind: v.literal('at'), ts: v.number() }),
  v.object({ kind: v.literal('after_phase'), phase: v.union([v.literal('idle'), v.literal('merging')]) }),
  v.object({
    kind: v.literal('after_event'),
    variant: v.string(),
    source: v.optional(v.string()),
  }),
  v.object({ kind: v.literal('after_seconds'), n: v.pipe(v.number(), v.minValue(0), v.maxValue(3600)) }),
]);

const HeadOpSchema = v.union([
  v.object({ kind: v.literal('keep') }),
  v.object({
    kind: v.literal('abort_one'),
    head_id: v.string(),
    reason: v.string(),
  }),
  v.object({ kind: v.literal('abort_all'), reason: v.string() }),
  v.object({
    kind: v.literal('add'),
    spec: v.object({
      task: v.string(),
      rationale: v.string(),
      bound_event_ids: v.array(v.string()),
      budget: v.optional(v.object({
        max_steps: v.optional(v.number()),
        max_tokens: v.optional(v.number()),
      })),
    }),
  }),
  v.object({ kind: v.literal('merge_now'), reason: v.string() }),
]);

const EventOpSchema = v.union([
  v.object({ kind: v.literal('handle') }),
  v.object({ kind: v.literal('defer'), revisit_at: RevisitConditionSchema }),
  v.object({ kind: v.literal('drop'), reason: v.string() }),
]);

export const ReactorOutputSchema = v.object({
  reasoning: v.pipe(v.string(), v.minLength(1)),
  head_op: HeadOpSchema,
  event_op: EventOpSchema,
});

export type ReactorOutput = v.InferOutput<typeof ReactorOutputSchema>;

/** Convert the model's structured output into our internal ReactorDecision. */
export function decisionFromOutput(out: ReactorOutput): ReactorDecision {
  return {
    head_op: out.head_op as ReactorDecision['head_op'],
    event_op: out.event_op as ReactorDecision['event_op'],
    reasoning: out.reasoning,
  };
}

// ── Fallback decision (LLM failure / budget exhausted) ───────────

/** The default emitted whenever the reactor LLM can't produce a valid
 *  output: timeout, parse error, exception, budget exhaustion. Always safe. */
export function reactorFallback(now: number): ReactorDecision {
  return {
    head_op: { kind: 'keep' },
    event_op: { kind: 'defer', revisit_at: { kind: 'after_phase', phase: 'idle' } },
    reasoning: `Fallback at ${new Date(now).toISOString()}: reactor LLM unavailable or budget exhausted; events deferred until next idle.`,
  };
}

// ── Decision applier ─────────────────────────────────────────────

export interface ApplyContext {
  snapshot: ReactorSnapshot;
  log: EventLog;
  heads: HeadController;
  /** The events the reactor was reacting to. */
  events: ProteusEvent[];
  now: number;
}

export interface ApplyOutcome {
  decision_row_id: string;
  /** True if the decision was legal and ran. False if rejected and the
   *  fallback was applied instead. */
  applied: boolean;
  /** The decision that actually ran (either the input or the fallback). */
  effective: ReactorDecision;
}

/**
 * Apply a reactor decision against the head set + EventLog. Idempotent
 * within a turn (each event is moved out of `pending` exactly once).
 *
 * On illegality: the fallback (keep, defer) runs and the original is
 * recorded for audit with `__legality_rejected: true`.
 */
export async function applyDecision(
  decision: ReactorDecision,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  const legal = isLegalDecision(decision, {
    reactor_head_trust: ctx.snapshot.reactor_head_trust,
    events_trust_class: ctx.snapshot.events_trust_class,
    current_phase: ctx.snapshot.phase,
  });

  const effective = legal ? decision : reactorFallback(ctx.now);

  // Record the decision row first (audit-first ordering).
  const decision_row_id = ctx.log.appendNonEventRow({
    kind: 'reactor_decision',
    turn_id: ctx.snapshot.turn_id,
    step_idx: null,
    parent_id: ctx.snapshot.initiator.event_id,
    trace_id: ctx.snapshot.trace_id,
    payload: {
      attempted: decision,
      effective,
      legality_rejected: !legal,
      events: ctx.events.map(e => ({ id: e.id, variant: e.variant, trust: e.trust })),
      reactor_head_trust: ctx.snapshot.reactor_head_trust,
    },
    now: ctx.now,
  });

  // Apply head_op
  switch (effective.head_op.kind) {
    case 'keep':
      // No-op
      break;
    case 'abort_one':
      await ctx.heads.abort(effective.head_op.head_id, effective.head_op.reason);
      break;
    case 'abort_all':
      await ctx.heads.abortAll(effective.head_op.reason);
      break;
    case 'add':
      await ctx.heads.spawn(effective.head_op.spec, ctx.snapshot.reactor_head_trust);
      break;
    case 'merge_now':
      await ctx.heads.forceMerge();
      break;
  }

  // Apply event_op (to every event in the batch)
  for (const ev of ctx.events) {
    switch (effective.event_op.kind) {
      case 'handle':
        // Caller binds events to the turn that's about to consume them.
        // Here we simply leave them in their existing turn binding (the
        // initiating turn) or, if unbound, bind them to the snapshot's turn.
        if (ev.id !== ctx.snapshot.initiator.event_id) {
          ctx.log.markConsumed(ev.id, ctx.snapshot.turn_id, -3 /* reactor */);
        }
        break;
      case 'defer':
        ctx.log.defer(ev.id, effective.event_op.revisit_at as RevisitCondition);
        break;
      case 'drop':
        ctx.log.dismiss(ev.id, effective.event_op.reason, 'reactor');
        break;
    }
  }

  return { decision_row_id, applied: legal, effective };
}

// ── Prompt assembly helper ───────────────────────────────────────

export function renderReactorPrompt(snapshot: ReactorSnapshot): string {
  const headsBlock = snapshot.heads.length === 0
    ? '(no heads currently running)'
    : snapshot.heads.map(h =>
        `  - head ${h.id}: "${h.task.slice(0, 80)}"\n` +
        `    progress: ${h.step_count} steps, last_tool=${h.last_tool ?? 'none'}\n` +
        `    summary: ${h.last_step_summary.slice(0, 200)}`,
      ).join('\n');

  const eventsBlock = snapshot.pending_events_batch.map(e =>
    `  - id=${e.id} variant=${e.variant} from=${e.triggered_by} (${e.is_self_caused ? 'self-caused' : 'external'})\n` +
    `    ${e.brief.slice(0, 300)}`,
  ).join('\n');

  return REACTOR_PROMPT
    .replace('{{HEADS_BLOCK}}', headsBlock)
    .replace('{{EVENTS_BLOCK}}', eventsBlock);
}
