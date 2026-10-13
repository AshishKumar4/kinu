// In-episode fitness for crafted tools: host-observed invocation results feed injection only.
// Execution-grounded evidence says "it ran", never "it was right"; creating blocks earn no credit.

import type { SqlExecutor } from '../types/primitives';
import { BUILTIN_TOOL_NAMES } from '../tools/registry';
import { isMcpToolKey } from '../tools/mcp-naming';
import { DEFAULT_CONFIG } from '../config';
import { nowMs } from '../utils/date';
import { filterByEffectiveScore, updateCraftScores } from './ema';
import { renderThrownChain } from '../obs/index';
import { namespacedCalls, parseCodemodeProgram } from '../safety/evolved-code';

/** `returned` matches the machine-evidence ceiling (below the 0.9 user pole); `raised` must stay
 *  below the injection floor's asymptote or tools can never be retired. */
const CRAFT_INVOCATION_QUALITY = { returned: 0.7, raised: 0.1 } as const;

/** Seeded at creation: an unscored tool is exempt from the injection filter forever (craft/ema.ts). */
export const CRAFT_NEUTRAL_PRIOR = 0.5;

/** Shared by admission and the injection filter so they agree on reserved names. */
export function isReservedCraftToolName(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name) || isMcpToolKey(name);
}

const CRAFT_NAMESPACES = ['tools'] as const;

export function craftInvocationSites(code: string, known: readonly string[]): string[] {
  if (known.length === 0) return [];
  const program = parseCodemodeProgram(code);

  if (program === null) return [];
  const calls = namespacedCalls(program, CRAFT_NAMESPACES);

  return known.filter((name) => CRAFT_NAMESPACES.some((namespace) => calls.has(`${namespace}.${name}`)));
}

/** Whether the block itself called `workspace.createTool(` (not inside a string body). */
function craftCreatesTool(code: string): boolean {
  const program = parseCodemodeProgram(code);

  return program !== null && namespacedCalls(program, ['workspace']).has('workspace.createTool');
}

/** Also emitted by core/src/execution/codemode-node-shim.ts `defineCrafted`; keep the format in sync. */
export function craftFailureMarker(name: string): string {
  return `[crafted:${name}]`;
}

export function craftInvocationError(name: string, cause: Error | string): Error {
  const message = renderThrownChain({ cause: cause });

  return new Error(`${craftFailureMarker(name)} ${message}`, { cause });
}

/** Blame only stamped tools; a block failing on its own code blames nobody. */
export function craftFailureBlame(failure: string, invoked: readonly string[]): string[] {
  return invoked.filter((name) => failure.includes(craftFailureMarker(name)));
}

/** One `eval` call's crafted-tool evidence, as the isolate that ran it observed it ({@link observeCraftCall}). */
export interface CraftCall {
  /** Tools its program created (`workspace.createTool`) that are callable now. */
  readonly created: readonly string[];
  /** Crafted tools its program called. */
  readonly invoked: readonly string[];
  /** Of `invoked`, those its result names as failing: scored as raised. */
  readonly raised: readonly string[];
  /** Of `invoked`, those callable before it ran that returned clean: scored as returned. */
  readonly returned: readonly string[];
  /** Tools its scores retired below the injection floor. */
  readonly dropped: readonly string[];
}

/**
 * One settled `eval` call, scored on `ledger`. `before` is the callable set as the call was dispatched, `result` what it
 * closed with (its output, or its error), `failed` whether it threw. Null when it neither created nor called a crafted
 * tool.
 */
export function observeCraftCall(ledger: CraftLedger, call: {
  readonly code: string; readonly before: ReadonlySet<string>; readonly result: string; readonly failed: boolean;
}): CraftCall | null {
  const known = ledger.names();
  // The set can also grow from the turn-outcome review (evolution/engine.ts); only attribute asked-for creation.
  const created = craftCreatesTool(call.code) ? known.filter((name) => !call.before.has(name)) : [];
  const invoked = craftInvocationSites(call.code, known);

  if (created.length === 0 && invoked.length === 0) return null;
  // The stamp is the evidence, not the call's own verdict: a failure the program caught and returned still names it.
  const raised = craftFailureBlame(call.result, invoked);
  // A tool cannot certify itself in the call that created it.
  const returned = call.failed ? [] : invoked.filter((name) => call.before.has(name) && !raised.includes(name));
  const scored = (names: readonly string[], quality: number): readonly string[] => (names.length === 0 ? [] : ledger.observe(names, quality));
  const dropped = [...scored(raised, CRAFT_INVOCATION_QUALITY.raised), ...scored(returned, CRAFT_INVOCATION_QUALITY.returned)];

  return { created, invoked, raised, returned, dropped };
}

export interface CraftLedger {
  /** Effective-score survivors (what the sandboxes bind), read fresh each call. */
  names(): readonly string[];
  /** Returns the names this observation retired below the injection floor. */
  observe(names: readonly string[], quality: number): readonly string[];
}

export interface CraftLedgerDeps {
  craftStore: { list(): ReadonlyArray<{ name: string }> };
  sql: SqlExecutor;
}

export function createCraftLedger(deps: CraftLedgerDeps): CraftLedger {
  const floor = DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection;

  return {
    names() {
      // Same injection policy the sandboxes use, so the callable set cannot drift.
      return filterByEffectiveScore(deps.sql, deps.craftStore.list(), floor).map((t) => t.name);
    },
    observe(names, quality) {
      if (names.length === 0) return [];
      updateCraftScores(deps.sql, [...names], quality);

      const surviving = new Set(
        filterByEffectiveScore(deps.sql, names.map((name) => ({ name })), floor, nowMs())
          .map((t) => t.name),
      );

      return names.filter((name) => !surviving.has(name));
    },
  };
}
