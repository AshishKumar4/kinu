/**
 * Every unit of durable work still owed, by the phase its own store records: actor turns from their claims, turns out at
 * agents' own isolates from the workspace's open-turn rows, terminal effects from their ledger, what each agent's
 * isolate answers of its own, and jobs, whose own list carries {@link jobPhase}. Nothing here is kept; each read folds
 * the stores afresh. Each row says in a person's words what it is and, where it is not running, what it waits on or
 * what the person can do.
 */
import type { BackgroundJobStatus } from '../types/jobs';
import type { WorkMode } from '../types/turn';
import type { StoredActorClaim } from '../orchestrator/actor-claims';
import type { OwedTerminalEffect, TerminalEffectName } from '../orchestrator/terminal-effects';

export type WorkPhase = 'running' | 'waiting' | 'blocked' | 'settled';

export interface InspectedWork {
  readonly kind: 'turn' | 'effect';
  /** The name of the actor that owes it; null for the workspace's own. */
  readonly actor: string | null;
  readonly id: string;
  /** What it is, in a person's words. */
  readonly label: string;
  readonly phase: Exclude<WorkPhase, 'settled'>;
  /** Null when its store keeps no count: an agent's isolate counts its own. */
  readonly attempt: number | null;
  /** Null while it runs; else what it waits on, or why it cannot go on by itself and what the person can do. */
  readonly why: string | null;
  /** When a waiting unit is next tried; null when it waits on another's move. */
  readonly until: number | null;
}

/** The actor's session owes a turn (one runs, is being prepared, or waits in its queue), so a claim it is not executing
 *  is picked up again on its own; `at` is when it is next woken, null when it is not waiting on a wake. */
export interface Resuming {
  readonly at: number | null;
}

const TURN_LABELS: Readonly<Record<WorkMode, string>> = { build: 'working on a request', plan: 'planning a request' };

const DELEGATED_TURN = 'working on a task it was given';

/** A turn whose isolate was restarted under it, as a deploy or the platform's maintenance does. */
const RESUMING_TURN = 'stopped by a restart; it picks up again on its own';

/** A claim no live session runs or will resume, which the chat offers to recover (`turnLiveness`'s `stranded`). */
const STRANDED_TURN = 'stopped part-way and nothing will pick it up again: use Recover this turn in its chat';

/** What each effect a settled turn owes does, in a person's words. */
const EFFECT_LABELS: Readonly<Record<TerminalEffectName, string>> = {
  event_reply: 'replying to the message that asked',
  branches: 'starting the side tasks it split off',
  completion_gate: 'checking the work is finished',
  turn_end_extensions: 'finishing the turn',
  overflow_retry: 'retrying with a shorter conversation',
  output_continuation: 'continuing an answer that was cut off',
  task_reminder: 'reminding itself of open tasks',
  turn_record: 'saving the answer',
  event_drain: 'reading what arrived meanwhile',
  improvement_lanes: 'reviewing the turn to improve',
  turn_lessons: 'noting what the turn taught',
  sleep_time: 'tidying its memory',
  auto_title: 'naming the chat',
  workspace_logo: 'drawing the workspace logo',
  parent_report: 'reporting to the agent that hired it',
  turn_report: 'reporting its turn',
  workspace_settle: 'handing the finished turn to the workspace',
  run_settle: 'closing the run',
  answer_slates: 'linking the answer to what it changed',
  fleet_turn: 'recording the turn',
};

/** An effect an older or newer build recorded, which this build cannot name. */
const UNKNOWN_EFFECT = 'finishing work another version of Kinu started';

/** What a person can know of an effect this build cannot run: an update finishes it, nothing they do will. */
const EFFECT_BLOCKED = 'this version of Kinu cannot finish it; an update will';

const EFFECT_PARKED = 'waits for your answer to its question';

/** A job as its own list reports it; the page's copy may omit when it resumes. */
export function jobPhase(job: { readonly status: BackgroundJobStatus; readonly resumeAfter?: number | null }, now: number): WorkPhase {
  if (job.status !== 'running' && job.status !== 'serving') return 'settled';

  return (job.resumeAfter ?? now) > now ? 'waiting' : 'running';
}

interface OwedTurn {
  readonly turnId: string;
  readonly actor: string | null;
  readonly label: string;
  readonly attempt: number | null;
}

function turnWork(turn: OwedTurn, executing: ReadonlySet<string>, resuming: Resuming | null, now: number): InspectedWork {
  const base = { kind: 'turn', id: turn.turnId, actor: turn.actor, label: turn.label, attempt: turn.attempt } as const;

  if (executing.has(turn.turnId)) return { ...base, phase: 'running', why: null, until: null };

  if (resuming !== null) return { ...base, phase: 'waiting', why: RESUMING_TURN, until: resuming.at !== null && resuming.at > now ? resuming.at : null };

  return { ...base, phase: 'blocked', why: STRANDED_TURN, until: null };
}

interface OwnedEffect {
  readonly effect: OwedTerminalEffect;
  readonly actor: string | null;
}

/** Blocked by what this build can run, not by the row's last attempt: a row recorded blocked is retried on its clock. */
function effectWork({ effect, actor }: OwnedEffect, now: number): InspectedWork {
  const label = effect.name === null ? UNKNOWN_EFFECT : EFFECT_LABELS[effect.name];
  const base = { kind: 'effect', id: effect.key, actor, label, attempt: effect.attempts } as const;

  if (effect.blocked !== null) return { ...base, phase: 'blocked', why: EFFECT_BLOCKED, until: null };

  if (effect.status === 'parked') return { ...base, phase: 'waiting', why: EFFECT_PARKED, until: null };

  return effect.nextAttemptAt > now
    ? { ...base, phase: 'waiting', why: null, until: effect.nextAttemptAt }
    : { ...base, phase: 'running', why: null, until: null };
}

const ORDER: Readonly<Record<InspectedWork['phase'], number>> = { blocked: 0, running: 1, waiting: 2 };

/** Blocked first, since nothing in flight will move it; then what runs; then what waits. */
export function inspectWork(input: {
  /** Each with which try of its turn it is ({@link turnAttemptOf}). */
  readonly claims: readonly { readonly claim: StoredActorClaim; readonly actor: string | null; readonly attempt: number }[];
  /** Turns handed to an agent's isolate; one the agent reports itself is its report's row. */
  readonly agentTurns: readonly { readonly turnId: string; readonly actor: string }[];
  /** The turns this isolate is executing or awaiting from an agent. */
  readonly executing: ReadonlySet<string>;
  /** Where the claims' actor's own session owes a turn; absent, a claim it is not executing is stranded. */
  readonly resuming?: Resuming;
  readonly effects: readonly OwnedEffect[];
  /** What other isolates answered of their own, already folded. */
  readonly reported?: readonly InspectedWork[];
  readonly now: number;
}): InspectedWork[] {
  const reported = input.reported ?? [];
  const answered = new Set(reported.filter((row) => row.kind === 'turn').map((row) => row.id));
  const resuming = input.resuming ?? null;

  return [
    ...input.claims.filter(({ claim }) => claim.outcome === null)
      .map(({ claim, actor, attempt }) => turnWork({ turnId: claim.turnId, actor, label: TURN_LABELS[claim.workMode], attempt }, input.executing, resuming, input.now)),
    ...input.agentTurns.filter((turn) => !answered.has(turn.turnId))
      .map((turn) => turnWork({ ...turn, label: DELEGATED_TURN, attempt: null }, input.executing, null, input.now)),
    ...input.effects.map((owned) => effectWork(owned, input.now)),
    ...reported,
  ].sort((a, b) => ORDER[a.phase] - ORDER[b.phase]);
}
