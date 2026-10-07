/**
 * Every unit of durable work still owed, by the phase its own store records: actor turns from their claims, turns out at
 * agents' own isolates from the workspace's open-turn rows, terminal effects from their ledger, what each agent's
 * isolate answers of its own, and jobs, whose own list carries {@link jobPhase}. Nothing here is kept; each read folds
 * the stores afresh.
 */
import type { BackgroundJobStatus } from '../types/jobs';
import type { StoredActorClaim } from '../orchestrator/actor-claims';
import type { OwedTerminalEffect } from '../orchestrator/terminal-effects';

export type WorkPhase = 'running' | 'waiting' | 'blocked' | 'settled';

export interface InspectedWork {
  readonly kind: 'turn' | 'effect';
  /** The name of the actor that owes it; null for the workspace's own. */
  readonly actor: string | null;
  readonly id: string;
  readonly label: string;
  readonly phase: Exclude<WorkPhase, 'settled'>;
  /** Null when its store keeps no count: an agent's isolate counts its own. */
  readonly attempt: number | null;
  /** Why it cannot go on by itself. */
  readonly blocked: string | null;
  /** When a waiting unit is next tried; null when it waits on another's move. */
  readonly until: number | null;
}

const STRANDED_TURN = 'no activation is running it';

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

function turnWork(turn: OwedTurn, executing: ReadonlySet<string>): InspectedWork {
  const live = executing.has(turn.turnId);

  return {
    kind: 'turn', id: turn.turnId, actor: turn.actor, label: turn.label, phase: live ? 'running' : 'blocked',
    attempt: turn.attempt, blocked: live ? null : STRANDED_TURN, until: null,
  };
}

interface OwnedEffect {
  readonly effect: OwedTerminalEffect;
  readonly actor: string | null;
}

/** Blocked by what this build can run, not by the row's last attempt: a row recorded blocked is retried on its clock. */
function effectWork({ effect, actor }: OwnedEffect, now: number): InspectedWork {
  const base = { kind: 'effect', id: effect.key, actor, label: effect.rawName, attempt: effect.attempts } as const;

  if (effect.blocked !== null) return { ...base, phase: 'blocked', blocked: effect.blocked, until: null };

  if (effect.status === 'parked') return { ...base, phase: 'waiting', blocked: null, until: null };

  return effect.nextAttemptAt > now
    ? { ...base, phase: 'waiting', blocked: null, until: effect.nextAttemptAt }
    : { ...base, phase: 'running', blocked: null, until: null };
}

const ORDER: Readonly<Record<InspectedWork['phase'], number>> = { blocked: 0, running: 1, waiting: 2 };

/** Blocked first, since nothing in flight will move it; then what runs; then what waits. */
export function inspectWork(input: {
  readonly claims: readonly { readonly claim: StoredActorClaim; readonly actor: string | null }[];
  /** Turns handed to an agent's isolate; one the agent reports itself is its report's row. */
  readonly agentTurns: readonly { readonly turnId: string; readonly actor: string }[];
  /** The turns this isolate is executing or awaiting from an agent; any other is stranded. */
  readonly executing: ReadonlySet<string>;
  readonly effects: readonly OwnedEffect[];
  /** What other isolates answered of their own, already folded. */
  readonly reported?: readonly InspectedWork[];
  readonly now: number;
}): InspectedWork[] {
  const reported = input.reported ?? [];
  const answered = new Set(reported.filter((row) => row.kind === 'turn').map((row) => row.id));

  return [
    ...input.claims.filter(({ claim }) => claim.outcome === null)
      .map(({ claim, actor }) => turnWork({ turnId: claim.turnId, actor, label: `${claim.workMode} turn`, attempt: claim.epoch }, input.executing)),
    ...input.agentTurns.filter((turn) => !answered.has(turn.turnId))
      .map((turn) => turnWork({ ...turn, label: 'delegated turn', attempt: null }, input.executing)),
    ...input.effects.map((owned) => effectWork(owned, input.now)),
    ...reported,
  ].sort((a, b) => ORDER[a.phase] - ORDER[b.phase]);
}
