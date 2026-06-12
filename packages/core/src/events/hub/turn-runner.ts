/**
 * TurnRunner — phase machine + head orchestration.
 *
 * The top-level driver. Owns:
 *
 *   - phase transitions persisted as `kind='phase'` rows
 *   - turn lifecycle: admit pending events, run LINEAR, optionally fan
 *     into HEADS, run REACTOR on mid-heads events, MERGE, return to IDLE
 *   - reactor invocation gating (ReactorBudget consult before spawn)
 *   - urgent-event abort via AbortController
 *   - recovery on DO eviction
 *   - scaffold-version binding (all heads of a turn use the initiator's
 *     scaffold; on rollback every in-flight head is aborted with summary)
 *
 * This module does NOT execute LLM calls itself. It delegates to a
 * `StepRunner` (one step) and a `HeadController` (multi-head ops) supplied
 * by the cf-backend layer. That keeps the core runtime-agnostic and
 * testable with stubs.
 */

import {
  type EventId, type HeadId, type Phase, type Priority, type ProteusEvent,
  type ReactorDecision, type Role, type TrustLevel, type TurnId, type TraceId,
  type ToolSurfaceContext, type ReplyChannelRef,
  BudgetExhaustedError,
} from './types.js';
import { meetAll } from './trust.js';
import { type EventLog } from './log.js';
import { type ReplyChannelStore } from './reply-channel.js';
import { type ReactorBudget } from './budget.js';
import {
  type HeadController, type ReactorSnapshot, applyDecision,
  decisionFromOutput, reactorFallback, renderReactorPrompt, snapshotForReactor,
  ReactorOutputSchema,
} from './reactor.js';
import { renderForLLM } from './visibility.js';
import { ulid } from './ulid.js';

// ── External plug-points ─────────────────────────────────────────

/** One LLM step. Returns whether the agent signaled done + tool calls
 *  + any branch-spawn intent. */
export interface StepRunner {
  runStep(opts: StepInput, signal: AbortSignal): Promise<StepOutcome>;
}

export interface StepInput {
  turn_id: TurnId;
  trace_id: TraceId;
  step_idx: number;
  head_trust: TrustLevel;
  tool_surface: ToolSurfaceContext;
  context_messages: ContextMessage[];
  /** Events appearing as synthetic `pending_events.poll()` tool results. */
  events_for_injection: ProteusEvent[];
  /** Where any chat-style assistant reply should go (null = no chat sink). */
  reply_channel: ReplyChannelRef | null;
  /** Snapshot of the current turn's scaffold version. */
  scaffold_version: number;
}

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; [k: string]: unknown }>;
  tool_call_id?: string;
}

export interface StepOutcome {
  /** True if the agent signaled it is done (no more steps). */
  finished: boolean;
  /** Assistant text emitted in this step (if any). Routed via reply channel
   *  by the StepRunner already; the TurnRunner just records it. */
  assistant_text?: string;
  /** Tool calls executed; the StepRunner persisted tool_call/tool_result
   *  rows for these. */
  tool_calls: Array<{ name: string; arguments: unknown; result: unknown }>;
  /** If the agent invoked `think({strategy:'heads'})`, this carries the branch spec. */
  branch_request?: BranchRequest;
  /** Diagnostic — events the step consumed as injected context. */
  injected_event_ids: EventId[];
}

export interface BranchRequest {
  heads: Array<{ task: string; rationale: string }>;
  budget?: { max_steps_per_head?: number };
}

/** The reactor's LLM call. cf-backend wires this to the same model as
 *  chat — but the system prompt is fixed (renderReactorPrompt) and the
 *  expected output is the ReactorOutputSchema JSON. */
export interface ReactorRunner {
  runOneShot(prompt: string, schema: unknown, signal: AbortSignal): Promise<unknown>;
}

/** The scaffold version source. Returns the current version; emits an
 *  event when it changes. cf-backend wires this to the shadow-rollout
 *  machinery. */
export interface ScaffoldVersionSource {
  currentVersion(): number;
  subscribeToChange(cb: (newVersion: number) => void): () => void;
}

/** Tool-surface composer. Pure function — cf-backend provides the actual
 *  tool implementations via a separate registry. */
export type ToolSurfaceComposer = (ctx: ToolSurfaceContext) => string[];

// ── TurnRunner ───────────────────────────────────────────────────

export interface TurnRunnerDeps {
  log: EventLog;
  replies: ReplyChannelStore;
  budget: ReactorBudget;
  heads: HeadController;
  step: StepRunner;
  reactor: ReactorRunner;
  scaffold: ScaffoldVersionSource;
  toolSurface: ToolSurfaceComposer;
}

export class TurnRunner {
  private _activeTurnId: TurnId | null = null;
  private _activePhase: Phase = 'idle';
  private _activeAbortCtl: AbortController | null = null;
  private _scaffoldUnsubscribe: (() => void) | null = null;

  constructor(private readonly deps: TurnRunnerDeps) {
    // Watch for scaffold rollback during in-flight reactor / heads.
    this._scaffoldUnsubscribe = deps.scaffold.subscribeToChange((newVersion) => {
      this.onScaffoldChange(newVersion);
    });
  }

  /** Returns the currently-active turn id, or null. */
  activeTurnId(): TurnId | null { return this._activeTurnId; }
  activePhase(): Phase { return this._activePhase; }

  /** Admit ready events and drive a turn to completion. Called by the
   *  hub whenever pending events exist and the runner is IDLE. */
  async runUntilIdle(now: number): Promise<void> {
    while (true) {
      const seed = this.deps.log.pending({
        limit: 10,
        resolve_deferred: { now, phase: 'idle' },
      });
      if (seed.length === 0) return;
      await this.runOneTurn(seed, now);
    }
  }

  // ── Recovery ─────────────────────────────────────────────────

  /** Called on DO boot. Reads agent_log for any in-flight turn; if one
   *  exists, finishes it via the abort-summary path then drains pending. */
  async recover(now: number): Promise<void> {
    // Find the most-recent phase row across all turns.
    const lastTurn = this.deps.log.query({ limit: 1 });
    const turnIdRow = lastTurn[0];
    if (!turnIdRow) return;

    // Heuristic: if there are events with turn_id but no recent IDLE
    // phase row for that turn, the turn was interrupted.
    // For each interrupted turn, append ABORTED_TURN_SUMMARY and free events.
    // (Full recovery walks every turn_id seen in events not yet IDLE.)
    const candidates = this.deps.log.query({ limit: 1000 });
    const turns = new Set<string>();
    for (const e of candidates) {
      const r = e as unknown as { turn_id?: string };
      if (r.turn_id) turns.add(r.turn_id);
    }
    for (const tid of turns) {
      const phase = this.deps.log.currentPhase(tid);
      if (!phase || phase.phase === 'idle') continue;
      this.writeAbortedTurnSummary(tid, 'do_eviction', now);
    }
    // Drain anything still pending.
    await this.runUntilIdle(now);
  }

  /** Append an ABORTED_TURN_SUMMARY step + transition to idle. The summary
   *  carries the tool-call ledger so the agent can compensate next turn. */
  private writeAbortedTurnSummary(turn_id: TurnId, reason: string, now: number): void {
    const stepsAndCalls = this.deps.log.turnSteps(turn_id);
    const incomplete: typeof stepsAndCalls = [];
    const completedToolCalls = new Set<string>();
    for (const r of stepsAndCalls) {
      if (r.kind === 'tool_result' && r.parent_id) completedToolCalls.add(r.parent_id);
    }
    for (const r of stepsAndCalls) {
      if (r.kind === 'tool_call' && !completedToolCalls.has(r.id)) {
        incomplete.push(r);
      }
    }
    this.deps.log.appendNonEventRow({
      kind: 'step',
      turn_id,
      step_idx: -100,           // sentinel for abort-summary
      parent_id: null,
      trace_id: (stepsAndCalls[0]?.trace_id) ?? turn_id,
      payload: {
        kind: 'aborted_turn_summary',
        reason,
        incomplete_tool_calls: incomplete.map(r => ({
          id: r.id, payload: r.payload, at: r.received_at,
        })),
        total_steps: stepsAndCalls.filter(r => r.kind === 'step').length,
      },
      now,
    });
    // Mark turn as IDLE (sentinel phase row).
    this.setPhase(turn_id, 'idle', now);
    // Unbind any events bound to this turn so they can be re-dispatched.
    // (Caller may re-admit them; abort_summary tells the next turn what
    // got partially applied.)
  }

  // ── One turn ─────────────────────────────────────────────────

  private async runOneTurn(seed_events: ProteusEvent[], now: number): Promise<void> {
    const turn_id = ulid();
    const trace_id = seed_events[0].trace_id;
    this._activeTurnId = turn_id;
    this._activeAbortCtl = new AbortController();

    // Bind seed events to this turn.
    for (const e of seed_events) this.deps.log.markConsumed(e.id, turn_id, 0);

    // Compute head trust for the linear phase.
    const head_trust = meetAll(seed_events.map(e => e.trust));

    // Scaffold version binding for the whole turn.
    const scaffold_version = this.deps.scaffold.currentVersion();

    // Phase: LINEAR
    this.setPhase(turn_id, 'linear', now);

    try {
      await this.runLinearPhase({
        turn_id, trace_id, head_trust, scaffold_version,
        seed_events,
        now,
      });
    } catch (err) {
      if (this._activeAbortCtl?.signal.aborted) {
        this.writeAbortedTurnSummary(turn_id, 'urgent_event_abort', Date.now());
      } else {
        // Unhandled error during linear: write abort + propagate.
        this.writeAbortedTurnSummary(turn_id, `error: ${(err as Error).message}`, Date.now());
        throw err;
      }
    } finally {
      this.setPhase(turn_id, 'idle', Date.now());
      this._activeTurnId = null;
      this._activePhase = 'idle';
      this._activeAbortCtl = null;
    }
  }

  // ── LINEAR phase ─────────────────────────────────────────────

  private async runLinearPhase(opts: {
    turn_id: TurnId;
    trace_id: TraceId;
    head_trust: TrustLevel;
    scaffold_version: number;
    seed_events: ProteusEvent[];
    now: number;
  }): Promise<void> {
    let step_idx = 0;
    const seenInjected = new Set<EventId>(opts.seed_events.map(e => e.id));

    while (true) {
      // Pop interim events (priority desc) for this step boundary.
      const interim = this.deps.log
        .pending({ limit: 50, min_priority: 'background' })
        .filter(e => !seenInjected.has(e.id));
      for (const e of interim) seenInjected.add(e.id);

      // If an `urgent` event arrived, fire abort to re-enter as new turn.
      const urgent = interim.find(e => e.priority === 'urgent');
      if (urgent && step_idx > 0) {
        this._activeAbortCtl?.abort(new UrgentEventInterruption(urgent.id));
      }

      // Build context for the step.
      const context = this.buildLinearContext(opts.turn_id, opts.seed_events);
      const tool_surface_ctx: ToolSurfaceContext = {
        head_trust: opts.head_trust,
        phase: 'linear',
        role: 'worker',
      };

      // Determine reply channel from the seed event.
      const reply_channel = opts.seed_events[0]?.reply_channel ?? null;

      // Run one step.
      const outcome = await this.deps.step.runStep({
        turn_id: opts.turn_id,
        trace_id: opts.trace_id,
        step_idx,
        head_trust: opts.head_trust,
        tool_surface: tool_surface_ctx,
        context_messages: context,
        events_for_injection: interim,
        reply_channel,
        scaffold_version: opts.scaffold_version,
      }, this._activeAbortCtl!.signal);

      // Mark injected events as consumed by this step.
      for (const e of interim) {
        this.deps.log.markConsumed(e.id, opts.turn_id, step_idx);
      }

      // Record the step.
      this.deps.log.appendNonEventRow({
        kind: 'step',
        turn_id: opts.turn_id,
        step_idx,
        parent_id: null,
        trace_id: opts.trace_id,
        payload: {
          finished: outcome.finished,
          assistant_text_len: outcome.assistant_text?.length ?? 0,
          tool_call_count: outcome.tool_calls.length,
          injected_event_ids: outcome.injected_event_ids,
        },
        now: Date.now(),
      });

      if (outcome.finished) return;

      // Branch into HEADS phase?
      if (outcome.branch_request) {
        await this.runHeadsPhase({
          turn_id: opts.turn_id,
          trace_id: opts.trace_id,
          parent_step: step_idx,
          head_trust: opts.head_trust,
          scaffold_version: opts.scaffold_version,
          branch: outcome.branch_request,
          now: Date.now(),
        });
        // After HEADS+MERGING completes, return to LINEAR.
        this.setPhase(opts.turn_id, 'linear', Date.now());
      }

      step_idx++;
    }
  }

  // ── HEADS phase ──────────────────────────────────────────────

  private async runHeadsPhase(opts: {
    turn_id: TurnId;
    trace_id: TraceId;
    parent_step: number;
    head_trust: TrustLevel;
    scaffold_version: number;
    branch: BranchRequest;
    now: number;
  }): Promise<void> {
    this.setPhase(opts.turn_id, 'heads', opts.now);

    // Spawn the requested heads with the parent's head_trust.
    const headIds: HeadId[] = [];
    for (const head of opts.branch.heads) {
      const id = await this.deps.heads.spawn({
        task: head.task,
        rationale: head.rationale,
        bound_event_ids: [],   // worker heads see no events
        budget: opts.branch.budget ? {
          max_steps: opts.branch.budget.max_steps_per_head,
        } : undefined,
      }, opts.head_trust);
      headIds.push(id);
    }

    // Run heads concurrently with a reactor-watcher. The reactor fires
    // whenever (a) new events arrive AND (b) budget allows.
    const reactorActive = { value: false };
    const watcher = this.spawnReactorWatcher({
      turn_id: opts.turn_id,
      trace_id: opts.trace_id,
      scaffold_version: opts.scaffold_version,
      reactorActive,
    });

    try {
      // Wait for all heads to complete OR forceMerge to be called.
      await this.waitForHeadsOrForceMerge(headIds, opts);
    } finally {
      watcher.cancel();
    }

    // MERGING phase
    this.setPhase(opts.turn_id, 'merging', Date.now());
    await this.runMergePhase(opts.turn_id, opts.trace_id, headIds, Date.now());
  }

  private async waitForHeadsOrForceMerge(headIds: HeadId[], opts: {
    turn_id: TurnId; trace_id: TraceId;
  }): Promise<void> {
    // The HeadController's spawn+abort+forceMerge surface drives
    // completion. We poll for completeness; in practice the head runtime
    // pushes completion notifications via events but we don't depend on
    // that here.
    while (true) {
      const heads = await this.deps.heads.list();
      if (heads.length === 0) return;
      const phase = this.deps.log.currentPhase(opts.turn_id);
      if (phase?.phase === 'merging') return;
      // Yield to the event loop; in production a notification system
      // wakes us when heads complete or forceMerge fires.
      await sleep(50);
    }
  }

  /** Background watcher: while HEADS phase is active, observe pending
   *  events; on arrival, check budget and either spawn a reactor or
   *  defer with budget-exhausted reasoning. */
  private spawnReactorWatcher(opts: {
    turn_id: TurnId;
    trace_id: TraceId;
    scaffold_version: number;
    reactorActive: { value: boolean };
  }): { cancel: () => void } {
    let cancelled = false;
    const loop = async () => {
      while (!cancelled) {
        const pending = this.deps.log.pending({ limit: 50, min_priority: 'background' });
        if (pending.length === 0) {
          await sleep(100);
          continue;
        }
        if (opts.reactorActive.value) {
          // Reactor already running — events accumulate as the watcher
          // re-polls. Single-reactor invariant.
          await sleep(100);
          continue;
        }
        opts.reactorActive.value = true;
        try {
          await this.invokeReactor({
            turn_id: opts.turn_id,
            trace_id: opts.trace_id,
            scaffold_version: opts.scaffold_version,
            events: pending,
          });
        } finally {
          opts.reactorActive.value = false;
        }
      }
    };
    void loop();
    return { cancel: () => { cancelled = true; } };
  }

  // ── Reactor invocation ──────────────────────────────────────

  private async invokeReactor(opts: {
    turn_id: TurnId;
    trace_id: TraceId;
    scaffold_version: number;
    events: ProteusEvent[];
  }): Promise<void> {
    const now = Date.now();
    const source_key = `${opts.events[0].ingress}:${opts.events[0].dedupe_key ?? opts.events[0].id}`;

    // Check budget first.
    const ok = await this.deps.budget.check({
      turn_id: opts.turn_id,
      trace_id: opts.trace_id,
      source_key,
      now,
    });

    if (!ok.ok) {
      // Budget exhausted → fallback (keep, defer).
      const fallback = reactorFallback(now);
      const heads = await this.deps.heads.list();
      const snapshot = await snapshotForReactor({
        turn_id: opts.turn_id,
        trace_id: opts.trace_id,
        initiator_event: opts.events[0],
        scaffold_version: opts.scaffold_version,
        heads: this.deps.heads,
        pending_events: opts.events,
        budget_remaining: this.deps.budget.snapshot(opts.turn_id, opts.trace_id, now),
        phase: 'heads',
      });
      this.deps.budget.record({
        turn_id: opts.turn_id, trace_id: opts.trace_id, source_key,
        outcome: 'budget_exhausted', now,
      });
      await applyDecision(fallback, {
        snapshot, log: this.deps.log, heads: this.deps.heads,
        events: opts.events, now,
      });
      return;
    }

    // Build the snapshot + prompt.
    const snapshot = await snapshotForReactor({
      turn_id: opts.turn_id,
      trace_id: opts.trace_id,
      initiator_event: opts.events[0],
      scaffold_version: opts.scaffold_version,
      heads: this.deps.heads,
      pending_events: opts.events,
      budget_remaining: this.deps.budget.snapshot(opts.turn_id, opts.trace_id, now),
      phase: 'heads',
    });

    // Set phase to REACTOR for the duration of the LLM call.
    this.setPhase(opts.turn_id, 'reactor', now);

    let decision: ReactorDecision;
    try {
      const prompt = renderReactorPrompt(snapshot);
      const raw = await this.deps.reactor.runOneShot(
        prompt, ReactorOutputSchema, this._activeAbortCtl?.signal ?? new AbortController().signal,
      );
      decision = decisionFromOutput(raw as never);
      this.deps.budget.record({
        turn_id: opts.turn_id, trace_id: opts.trace_id, source_key,
        outcome: 'decided', now: Date.now(),
      });
    } catch (err) {
      decision = reactorFallback(Date.now());
      this.deps.budget.record({
        turn_id: opts.turn_id, trace_id: opts.trace_id, source_key,
        outcome: 'fallback_defer', now: Date.now(),
      });
    }

    // Apply.
    await applyDecision(decision, {
      snapshot, log: this.deps.log, heads: this.deps.heads,
      events: opts.events, now: Date.now(),
    });

    // Return to HEADS phase (unless decision was merge_now/abort_all).
    if (decision.head_op.kind === 'merge_now') {
      this.setPhase(opts.turn_id, 'merging', Date.now());
    } else {
      this.setPhase(opts.turn_id, 'heads', Date.now());
    }
  }

  // ── MERGING phase ───────────────────────────────────────────

  private async runMergePhase(turn_id: TurnId, trace_id: TraceId, headIds: HeadId[], now: number): Promise<void> {
    // The actual merge LLM call is the responsibility of the head
    // controller (it knows how to read each head's final state). The
    // TurnRunner just records the phase and waits.
    await this.deps.heads.forceMerge();
    this.deps.log.appendNonEventRow({
      kind: 'phase',
      turn_id, step_idx: null, parent_id: null, trace_id,
      payload: { phase: 'merging_complete', head_ids: headIds },
      now: Date.now(),
    });
  }

  // ── Phase helpers ───────────────────────────────────────────

  private setPhase(turn_id: TurnId, phase: Phase, now: number): void {
    this._activePhase = phase;
    this.deps.log.appendNonEventRow({
      kind: 'phase',
      turn_id,
      step_idx: null,
      parent_id: null,
      trace_id: turn_id,        // approximate; actual trace lives on events
      payload: { phase },
      now,
    });
  }

  // ── Scaffold rollback ───────────────────────────────────────

  private onScaffoldChange(newVersion: number): void {
    // If a turn is in-flight, abort all heads with summary; the next turn
    // will start on the new version.
    if (!this._activeTurnId) return;
    this.deps.heads.abortAll(`scaffold rollback to v${newVersion}`).then(() => {
      if (this._activeTurnId) {
        this.writeAbortedTurnSummary(this._activeTurnId, `scaffold_rollback_to_v${newVersion}`, Date.now());
      }
    }).catch(() => { /* nop */ });
  }

  // ── Cleanup ─────────────────────────────────────────────────

  dispose(): void {
    this._scaffoldUnsubscribe?.();
    this._scaffoldUnsubscribe = null;
  }

  // ── Context builder (linear phase) ──────────────────────────

  private buildLinearContext(turn_id: TurnId, seed_events: ProteusEvent[]): ContextMessage[] {
    // Build system message + seed event(s) as the initial user-equivalent.
    // The cf-backend Step runner overlays the agent's persistent system prompt
    // + memory blocks via its existing prompt-builder; this is the events-hub
    // layer's contribution to the message stream.
    const messages: ContextMessage[] = [];
    for (const event of seed_events) {
      messages.push({
        role: 'user',
        content: JSON.stringify(renderForLLM(event)),
      });
    }
    // Previous tool_call / tool_result rows from this turn are reconstructed
    // by the cf-backend step runner — TurnRunner doesn't replay them.
    return messages;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

export class UrgentEventInterruption extends Error {
  constructor(public readonly event_id: EventId) {
    super(`urgent event ${event_id} aborted current step`);
    this.name = 'UrgentEventInterruption';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
