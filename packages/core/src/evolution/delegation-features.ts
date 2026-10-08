import type { CompletedTurn, ToolCallRecord } from './types';

/** Judge-free wasted-motion signals a trace proves on its own. */
export interface ExecutionPathSignals {
  /** Calls inside an immediately repeating cycle, beyond its first pass. */
  loopedCalls: number;
  /** Repeats of an identical (tool, arguments) fingerprint beyond the first; a superset of loopedCalls. */
  redundantCalls: number;
  /** Calls that re-read or undid a path an earlier call in the turn wrote. */
  backtrackCalls: number;
}

export interface DelegationFeatures extends ExecutionPathSignals {
  stepCount: number;
  teamCalls: number;
  thinkCalls: number;
  peerCalls: number;
  executeCodemodeCalls: number;
  wallClockMs: number;
}

type TurnProcessRecord = Pick<CompletedTurn, 'toolCalls' | 'steps' | 'durationMs'>;

const MAX_CYCLE_LENGTH = 4;

function countRedundant(prints: ReadonlyArray<string>): number {
  return prints.length - new Set(prints).size;
}

/** Greedy left-to-right: take the shortest immediately repeating block and charge its repeats.
 *  `[A,A,A]` = 2; `[A,B,A,B,A,B]` = 4; `[A,B,C,A]` = 0 (a revisit, not a loop). */
function countLooped(prints: ReadonlyArray<string>): number {
  let looped = 0;
  let i = 0;

  while (i < prints.length) {
    const cycle = shortestCycleAt(prints, i);

    if (!cycle) { i += 1; continue; }

    let repeats = 1;

    while (blockEquals(prints, i, i + repeats * cycle, cycle)) repeats += 1;
    looped += (repeats - 1) * cycle;
    i += repeats * cycle;
  }

  return looped;
}

function shortestCycleAt(prints: ReadonlyArray<string>, start: number): number | null {
  for (let k = 1; k <= MAX_CYCLE_LENGTH; k += 1) {
    if (blockEquals(prints, start, start + k, k)) return k;
  }

  return null;
}

function blockEquals(prints: ReadonlyArray<string>, a: number, b: number, length: number): boolean {
  if (b + length > prints.length) return false;

  for (let offset = 0; offset < length; offset += 1) {
    if (prints[a + offset] !== prints[b + offset]) return false;
  }

  return true;
}

function countBacktracks(calls: ReadonlyArray<ToolCallRecord>): number {
  const written = new Set<string>();
  let backtracks = 0;

  for (const call of calls) {
    if (call.revisitedPaths.some((path) => written.has(path))) backtracks += 1;

    for (const path of call.writtenPaths) written.add(path);
  }

  return backtracks;
}

export function executionPathSignals(calls: ReadonlyArray<ToolCallRecord>): ExecutionPathSignals {
  const prints = calls.map((call) => call.argsDigest).filter((print): print is string => print !== null);

  return {
    loopedCalls: countLooped(prints),
    redundantCalls: countRedundant(prints),
    backtrackCalls: countBacktracks(calls),
  };
}

function agentsAction(call: ToolCallRecord): string | null {
  return call.name === 'agents' ? call.op : null;
}

const STAFFING_ACTIONS = { hire: true, assign: true, hireWorkspace: true, list: true, dismiss: true } satisfies Record<string, true>;

const MESSAGING_ACTIONS = { message: true, reply: true } satisfies Record<string, true>;

const EXPLORATION_ACTIONS = { swarm: true } satisfies Record<string, true>;

function hasKey(table: Record<string, true>, action: string | null): boolean {
  return action !== null && action in table;
}

export function delegationFeatures(turn: TurnProcessRecord): DelegationFeatures {
  const count = (predicate: (call: ToolCallRecord) => boolean): number =>
    turn.toolCalls.filter(predicate).length;

  return {
    stepCount: turn.steps,
    teamCalls: count((call) => hasKey(STAFFING_ACTIONS, agentsAction(call))),
    thinkCalls: count((call) => hasKey(EXPLORATION_ACTIONS, agentsAction(call))),
    peerCalls: count((call) => hasKey(MESSAGING_ACTIONS, agentsAction(call))),
    executeCodemodeCalls: count((call) => call.name === 'eval'),
    wallClockMs: turn.durationMs,
    ...executionPathSignals(turn.toolCalls),
  };
}

function compactDuration(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1_000).toFixed(1)}s`;
}

export function renderDelegationFeatures(features: DelegationFeatures): string {
  // Only appended when non-zero, to save prompt tokens on clean turns.
  const path = [
    features.loopedCalls > 0 ? `${features.loopedCalls} looped` : null,
    features.redundantCalls > 0 ? `${features.redundantCalls} redundant` : null,
    features.backtrackCalls > 0 ? `${features.backtrackCalls} backtracking` : null,
  ].filter((part): part is string => part !== null);

  return `Turn process: ${features.stepCount} sequential steps, ${features.teamCalls} hiring, ` +
    `${features.thinkCalls} exploration, ${features.peerCalls} messaging, ` +
    `${features.executeCodemodeCalls} eval, ${compactDuration(features.wallClockMs)} wall clock` +
    (path.length > 0 ? `. Wasted motion: ${path.join(', ')} tool calls` : '');
}

/** Shared by both readers of {@link renderDelegationFeatures} (turn reflection and GEPA reflector) so their vocabularies cannot drift. One clause per line: three rules for three outcomes. */
export const DELEGATION_RUBRIC = [
  'Delegation rubric, against the counts above:',
  '- A low-rated turn with 2+ independent parts, ground through inline with no hiring',
  '  and no exploration, is a lesson to decompose the work and delegate it.',
  '- An accepted turn that hired or explored effectively earns credit for having done so.',
  '- Spawns that contributed nothing are delegation overhead, and count against the turn.',
].join('\n');
