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
export const CRAFT_INVOCATION_QUALITY = { returned: 0.7, raised: 0.1 } as const;

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
export function craftCreatesTool(code: string): boolean {
  const program = parseCodemodeProgram(code);

  return program !== null && namespacedCalls(program, ['workspace']).has('workspace.createTool');
}

/** Also emitted by cf-backend/src/codemode-node-shim.ts `defineCrafted`; keep the format in sync. */
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
