import type { CompletedTurn, ToolCallRecord } from './types';
import * as v from 'valibot';
import { decodeJsonValue, isJsonObject, type JsonValue } from '../utils/json';
import { stableStringify } from '../safety/argument-digest';

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
  return `${call.name}:${stableStringify(decodeJsonValue({ value: call.args }))}`;
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
 * Path effects readable from a call's arguments. Kinu has no file tool —
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
function stringLeaves(value: JsonValue, into: string[] = []): string[] {
  const text = v.safeParse(v.string(), value);
  if (text.success) into.push(text.output);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, into);
  else if (isJsonObject(value)) {
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
    const text = stringLeaves(decodeJsonValue({ value: call.args }));
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
 *  name; the delegation evidence still separates exploration / hiring / messaging
 *  by ACTION — and keeps counting the legacy tool names so stored turns from
 *  before the unification report the same signal. */
function agentsAction(call: ToolCallRecord): string | null {
  if (call.name !== 'agents') return null;
  const input = v.safeParse(v.object({ action: v.optional(v.string()) }), call.args);
  return input.success ? input.output.action ?? null : null;
}

/** `staff` is the pre-2026-08-17 name of `hire` and is kept for the same reason
 *  the legacy TOOL names below are: this reader runs over STORED turns, and a
 *  row written before the rename must report the same signal it did when it was
 *  written. It is history tolerance in a read model, not an alias on the
 *  model-facing surface — nothing accepts `staff` as an action any more. */
const STAFFING_ACTIONS = { hire: true, staff: true, list: true, dismiss: true } satisfies Record<string, true>;
const MESSAGING_ACTIONS = { ask: true, send: true, reply: true } satisfies Record<string, true>;
/** The ephemeral-search rung, and the two spellings it had before. `fork` is the
 *  action removed on 2026-08-18 and `think` the tool that preceded it; both are
 *  kept for the reason `staff` is, one paragraph up — a stored row must report the
 *  signal it reported when it was written. */
const EXPLORATION_ACTIONS = { swarm: true, fork: true } satisfies Record<string, true>;

/** Whether an action read off a stored row is in one of the tables above. The
 *  action is `string | null` off the wire, so the lookup narrows rather than
 *  indexing a known-key record with an unknown key. */
function hasKey<Table extends object>(table: Table, action: string | null): boolean {
  return action !== null && action in table;
}

/** Deterministic process evidence derived from an existing completed turn. */
export function delegationFeatures(turn: TurnProcessRecord): DelegationFeatures {
  const count = (predicate: (call: ToolCallRecord) => boolean): number =>
    turn.toolCalls.filter(predicate).length;
  return {
    stepCount: turn.steps,
    teamCalls: count((call) => call.name === 'team' || hasKey(STAFFING_ACTIONS, agentsAction(call))),
    thinkCalls: count((call) => call.name === 'think' || hasKey(EXPLORATION_ACTIONS, agentsAction(call))),
    peerCalls: count((call) => call.name === 'peers' || hasKey(MESSAGING_ACTIONS, agentsAction(call))),
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
  return `Turn process: ${features.stepCount} sequential steps, ${features.teamCalls} hiring, ` +
    `${features.thinkCalls} exploration, ${features.peerCalls} messaging, ` +
    `${features.executeToolsCalls} execute_tools, ${compactDuration(features.wallClockMs)} wall clock` +
    (path.length > 0 ? `. Wasted motion: ${path.join(', ')} tool calls` : '');
}

/**
 * What a reader of the evidence above is asked to DO with it.
 *
 * Both readers of {@link renderDelegationFeatures} state this rubric — the turn
 * reflection (evolution/engine.ts) and the GEPA reflector (gepa/mutate.ts) — and
 * they used to state it in two independently-edited sentences that had already
 * drifted into two vocabularies for one ladder: `team`/`think`/`heads` in one and
 * `hire`/`search` in the other, neither of them the words the evidence line above
 * actually prints. One string, printed beside the counts it reads.
 *
 * One clause per line, because they are three separate rules keyed on three
 * different turn outcomes. Fused into one sentence, a reader looking for the rule
 * that applies to ITS turn has to parse all three to find out that two do not.
 */
export const DELEGATION_RUBRIC = [
  'Delegation rubric, against the counts above:',
  '- A corrected or frustrated turn with 2+ independent parts, ground through inline with no hiring',
  '  and no exploration, is a lesson to decompose the work and delegate it.',
  '- An accepted turn that hired or explored effectively earns credit for having done so.',
  '- Spawns that contributed nothing are delegation overhead, and count against the turn.',
].join('\n');
