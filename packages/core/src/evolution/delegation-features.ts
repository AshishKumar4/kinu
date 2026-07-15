import type { CompletedTurn } from './types.js';

export interface DelegationFeatures {
  stepCount: number;
  teamCalls: number;
  thinkCalls: number;
  peerCalls: number;
  executeToolsCalls: number;
  wallClockMs: number;
}

type TurnProcessRecord = Pick<CompletedTurn, 'toolCalls' | 'steps' | 'durationMs'>;

/** Deterministic process evidence derived from an existing completed turn. */
export function delegationFeatures(turn: TurnProcessRecord): DelegationFeatures {
  const count = (name: string): number => turn.toolCalls.filter((call) => call.name === name).length;
  return {
    stepCount: turn.steps,
    teamCalls: count('team'),
    thinkCalls: count('think'),
    peerCalls: count('peers'),
    executeToolsCalls: count('execute_tools'),
    wallClockMs: turn.durationMs,
  };
}

function compactDuration(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1_000).toFixed(1)}s`;
}

export function renderDelegationFeatures(features: DelegationFeatures): string {
  return `Turn process: ${features.stepCount} sequential steps, ${features.teamCalls} team, ` +
    `${features.thinkCalls} think, ${features.peerCalls} peers, ` +
    `${features.executeToolsCalls} execute_tools, ${compactDuration(features.wallClockMs)} wall clock`;
}
