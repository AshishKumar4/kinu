// In-episode fitness for crafted tools: host-observed invocation results feed injection only.
// Execution-grounded evidence says "it ran", never "it was right"; creating blocks earn no credit.

import type { SqlExecutor } from '../types/primitives';
import { BUILTIN_TOOL_NAMES } from '../tools/registry';
import { isMcpToolKey } from '../tools/mcp-naming';
import { DEFAULT_CONFIG } from '../config';
import { nowMs } from '../utils/date';
import { filterByEffectiveScore, updateCraftScores } from './ema';
import { renderThrownChain } from '../obs/index';

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

// Non-dot-callable names are skipped, which also keeps stored names out of the built regex.
const DOT_CALLABLE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Blank comments and literal text (keeping template interpolations) so tool bodies passed
 *  as strings are not read as calls. Not a parser: failures miss call sites, never invent them. */
export function stripNonCode(source: string): string {
  const out: string[] = [];
  const interpolations: number[] = [];
  let inTemplateText = false;
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (inTemplateText) {
      if (c === '\\') { i += 2; continue; }

      if (c === '`') { inTemplateText = false; out.push(' '); i++; continue; }

      if (c === '$' && source[i + 1] === '{') {
        interpolations.push(0);
        inTemplateText = false;
        out.push(' ');
        i += 2;
        continue;
      }

      i++;
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out.push(' ');
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      i += 2;

      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out.push(' ');
      continue;
    }

    if (c === '"' || c === "'") {
      i++;

      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') i++;
        i++;
      }

      i++;
      out.push(' ');
      continue;
    }

    if (c === '`') { inTemplateText = true; out.push(' '); i++; continue; }

    if (interpolations.length > 0) {
      const depth = interpolations[interpolations.length - 1];

      if (c === '{') interpolations[interpolations.length - 1] = depth + 1;
      else if (c === '}') {
        if (depth === 0) {
          interpolations.pop();
          inTemplateText = true;
          out.push(' ');
          i++;
          continue;
        }

        interpolations[interpolations.length - 1] = depth - 1;
      }
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

export function craftInvocationSites(code: string, known: readonly string[]): string[] {
  if (known.length === 0) return [];
  const source = stripNonCode(code);
  const namespaces = CRAFT_NAMESPACES.join('|');

  return known.filter((name) => {
    if (!DOT_CALLABLE.test(name)) return false;

    return new RegExp(`(?:^|[^\\w$.])(?:${namespaces})\\.${name}\\s*\\(`).test(source);
  });
}

/** Whether the block itself called `workspace.createTool(` (not inside a string body). */
export function craftCreatesTool(code: string): boolean {
  return /(?:^|[^\w$.])workspace\.createTool\s*\(/.test(stripNonCode(code));
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
