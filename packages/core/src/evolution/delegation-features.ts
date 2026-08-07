import type { CompletedTurn, ToolCallRecord } from './types.js';
import { stableStringify } from '../safety/argument-digest.js';

/** Execution-path validity: three things a trace proves on its own, with no
 *  judge and therefore no judge bias. All three are wasted motion — the agent
 *  spending steps without advancing. */
export interface ExecutionPathSignals {
  /** Calls inside an immediately-repeating cycle, beyond the cycle's first
   *  pass — the agent stuck doing the same thing. */
  loopedCalls: number;
  /** Repeats of an identical (tool, arguments) fingerprint anywhere in the
   *  turn, beyond the first occurrence. A superset of loopedCalls: a cycle
   *  repeats fingerprints, but a repeat need not be a cycle. */
  redundantCalls: number;
  /** Calls that re-read or undid a path an EARLIER call in the turn wrote. */
  backtrackCalls: number;
}

export interface DelegationFeatures extends ExecutionPathSignals {
  stepCount: number;
  teamCalls: number;
  thinkCalls: number;
  peerCalls: number;
  executeToolsCalls: number;
  wallClockMs: number;
}

type TurnProcessRecord = Pick<CompletedTurn, 'toolCalls' | 'steps' | 'durationMs'>;

// ── Loop / redundancy ────────────────────────────────────────────

/** Longest immediate repetition scanned for. Beyond four alternating calls the
 *  pattern is better described by the fingerprint-repeat count. */
const MAX_CYCLE_LENGTH = 4;

/**
 * A call's identity for repeat detection: its name plus its arguments in a
 * key-order-independent form. Calls with NO arguments return null and are
 * excluded — a call carrying no payload has no identity to repeat, so
 * invoking it twice is not evidence of doing the same work twice.
 */
function fingerprint(call: ToolCallRecord): string | null {
  const keys = Object.keys(call.args);
  if (keys.length === 0) return null;
  return `${call.name}:${stableStringify(call.args)}`;
}

/** Repeats of an identical fingerprint, beyond each fingerprint's first use. */
function countRedundant(prints: ReadonlyArray<string>): number {
  return prints.length - new Set(prints).size;
}

/**
 * Calls belonging to an immediately-repeated block, beyond its first pass.
 * Greedy left-to-right: at each position take the SHORTEST block that repeats
 * immediately, consume every consecutive repetition of it, and charge the
 * repeats. `[A,A,A]` charges 2; `[A,B,A,B,A,B]` charges 4; `[A,B,C,A]` charges
 * 0 (a revisit, not a loop — countRedundant is the lens for that).
 */
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

// ── Backtracking ─────────────────────────────────────────────────

/**
 * Path effects readable from a call's arguments. Proteus has no file tool —
 * files are touched from code-mode (`workspace.readFile` / `workspace.writeFile`,
 * the documented VFS surface) and from `run` shell commands, so those two
 * vocabularies are what a trace can actually show. Deliberately narrow: a
 * missed effect costs one missed signal, an invented one would poison the
 * evidence line this module feeds.
 */
const WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bworkspace\.writeFile\s*\(\s*['"`]([^'"`]+)/g,
  /(?:^|[|;&\n]|\s)>>?\s*(\S+)/g,
  /(?:^|[|;&\n]|\s)tee\s+(?:-\S+\s+)*(\S+)/g,
];

/** Reading or removing a path is how a turn backtracks over its own write. */
const REVISIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bworkspace\.readFile\s*\(\s*['"`]([^'"`]+)/g,
  /(?:^|[|;&\n]|\s)(?:cat|head|tail)\s+(?:-\S+\s+)*(\S+)/g,
  /(?:^|[|;&\n]|\s)rm\s+(?:-\S+\s+)*(\S+)/g,
  /\bgit\s+(?:checkout\s+--|restore)\s+(\S+)/g,
];

/** Every string leaf of an arguments object — the only place a path can hide. */
function stringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) stringLeaves(item, into);
  }
  return into;
}

/** Only path-shaped tokens (carrying a separator or an extension) count. The
 *  vocabularies above run over free-form code and shell text, and this is what
 *  keeps an English word after `tail` — or the right-hand side of a `>`
 *  comparison — out of the path sets. */
function normalizePath(raw: string): string | null {
  const path = raw.replace(/^['"`]+/, '').replace(/['"`;,)]+$/, '');
  return /[/.]/.test(path) ? path : null;
}

function pathsMatching(text: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>): Set<string> {
  const found = new Set<string>();
  for (const chunk of text) {
    for (const pattern of patterns) {
      for (const match of chunk.matchAll(pattern)) {
        const path = match[1] === undefined ? null : normalizePath(match[1]);
        if (path) found.add(path);
      }
    }
  }
  return found;
}

/** Calls that read or removed a path written by an earlier call in the turn. */
function countBacktracks(calls: ReadonlyArray<ToolCallRecord>): number {
  const written = new Set<string>();
  let backtracks = 0;
  for (const call of calls) {
    const text = stringLeaves(call.args);
    const revisited = pathsMatching(text, REVISIT_PATTERNS);
    if ([...revisited].some((path) => written.has(path))) backtracks += 1;
    for (const path of pathsMatching(text, WRITE_PATTERNS)) written.add(path);
  }
  return backtracks;
}

/** Deterministic execution-path validity for one turn's tool calls. */
export function executionPathSignals(calls: ReadonlyArray<ToolCallRecord>): ExecutionPathSignals {
  const prints = calls.map(fingerprint).filter((print): print is string => print !== null);
  return {
    loopedCalls: countLooped(prints),
    redundantCalls: countRedundant(prints),
    backtrackCalls: countBacktracks(calls),
  };
}

/** The unified `agents` tool folds the old think/team/peers surfaces into one
 *  name; the delegation evidence still separates fork / staffing / messaging
 *  by ACTION — and keeps counting the legacy tool names so stored turns from
 *  before the unification report the same signal. */
function agentsAction(call: ToolCallRecord): string | null {
  if (call.name !== 'agents') return null;
  const action = (call.args as { action?: unknown }).action;
  return typeof action === 'string' ? action : null;
}

const STAFFING_ACTIONS = new Set(['staff', 'list', 'dismiss']);
const MESSAGING_ACTIONS = new Set(['ask', 'send', 'reply']);

/** Deterministic process evidence derived from an existing completed turn. */
export function delegationFeatures(turn: TurnProcessRecord): DelegationFeatures {
  const count = (predicate: (call: ToolCallRecord) => boolean): number =>
    turn.toolCalls.filter(predicate).length;
  return {
    stepCount: turn.steps,
    teamCalls: count((call) => call.name === 'team' || STAFFING_ACTIONS.has(agentsAction(call) ?? '')),
    thinkCalls: count((call) => call.name === 'think' || agentsAction(call) === 'fork'),
    peerCalls: count((call) => call.name === 'peers' || MESSAGING_ACTIONS.has(agentsAction(call) ?? '')),
    executeToolsCalls: count((call) => call.name === 'execute_tools'),
    wallClockMs: turn.durationMs,
    ...executionPathSignals(turn.toolCalls),
  };
}

function compactDuration(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1_000).toFixed(1)}s`;
}

export function renderDelegationFeatures(features: DelegationFeatures): string {
  // The path clause is appended only when there is something to report: a
  // clean path is the norm, and "0 loops, 0 redundant calls" would spend
  // prompt tokens on every turn to say nothing.
  const path = [
    features.loopedCalls > 0 ? `${features.loopedCalls} looped` : null,
    features.redundantCalls > 0 ? `${features.redundantCalls} redundant` : null,
    features.backtrackCalls > 0 ? `${features.backtrackCalls} backtracking` : null,
  ].filter((part): part is string => part !== null);
  return `Turn process: ${features.stepCount} sequential steps, ${features.teamCalls} staffing, ` +
    `${features.thinkCalls} fork, ${features.peerCalls} messaging, ` +
    `${features.executeToolsCalls} execute_tools, ${compactDuration(features.wallClockMs)} wall clock` +
    (path.length > 0 ? `. Wasted motion: ${path.join(', ')} tool calls` : '');
}
