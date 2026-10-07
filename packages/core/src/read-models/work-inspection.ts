/**
 * Every unit of durable work still owed, by the phase its own store records: actor turns from their claims, turns out at
 * agents' own isolates from the workspace's open-turn rows, terminal effects from their ledger, and jobs, whose own list
 * carries {@link jobPhase}. Nothing here is kept; each read folds the stores afresh.
 */
import type { BackgroundJobStatus } from '../types/jobs';
import type { StoredActorClaim } from '../orchestrator/actor-claims';
import type { OwedTerminalEffect } from '../orchestrator/terminal-effects';
import type { AgentOpenTurn } from '../subordinates/open-turns';

export type WorkPhase = 'running' | 'waiting' | 'blocked' | 'settled';

export interface InspectedWork {
  readonly kind: 'turn' | 'effect';
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

function turnWork(turn: { readonly turnId: string; readonly label: string; readonly attempt: number | null }, executing: ReadonlySet<string>): InspectedWork {
  const live = executing.has(turn.turnId);

  return {
    kind: 'turn', id: turn.turnId, label: turn.label, phase: live ? 'running' : 'blocked',
    attempt: turn.attempt, blocked: live ? null : STRANDED_TURN, until: null,
  };
}

/** Blocked by what this build can run, not by the row's last attempt: a row recorded blocked is retried on its clock. */
function effectWork(effect: OwedTerminalEffect, now: number): InspectedWork {
  const base = { kind: 'effect', id: effect.key, label: effect.rawName, attempt: effect.attempts } as const;

  if (effect.blocked !== null) return { ...base, phase: 'blocked', blocked: effect.blocked, until: null };

  if (effect.status === 'parked') return { ...base, phase: 'waiting', blocked: null, until: null };

  return effect.nextAttemptAt > now
    ? { ...base, phase: 'waiting', blocked: null, until: effect.nextAttemptAt }
    : { ...base, phase: 'running', blocked: null, until: null };
}

const ORDER: Readonly<Record<InspectedWork['phase'], number>> = { blocked: 0, running: 1, waiting: 2 };

/** Blocked first, since nothing in flight will move it; then what runs; then what waits. */
export function inspectWork(input: {
  readonly turns: readonly StoredActorClaim[];
  readonly agentTurns: readonly AgentOpenTurn[];
  /** The turns this activation is executing or awaiting from an agent; any other is stranded. */
  readonly executing: ReadonlySet<string>;
  readonly effects: readonly OwedTerminalEffect[];
  readonly now: number;
}): InspectedWork[] {
  return [
    ...input.turns.filter((claim) => claim.outcome === null)
      .map((claim) => turnWork({ turnId: claim.turnId, label: `${claim.workMode} turn`, attempt: claim.epoch }, input.executing)),
    ...input.agentTurns.map((turn) => turnWork({ turnId: turn.turnId, label: 'agent turn', attempt: null }, input.executing)),
    ...input.effects.map((effect) => effectWork(effect, input.now)),
  ].sort((a, b) => ORDER[a.phase] - ORDER[b.phase]);
}
