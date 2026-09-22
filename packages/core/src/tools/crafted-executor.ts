/**
 * Crafted source selection and host-side execution contracts. CF compiles source in a Worker Loader sandbox
 * (catalog `isolate.codegen_blocked` rules out a host callback); local Node/Bun compiles in-process.
 */

import type { CraftedTool } from '../types/craft';
import type { JsonValue } from '../utils/json';
import type { CraftStore } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import { filterByEffectiveScore } from '../craft/ema';
import { isReservedCraftToolName } from '../craft/in-episode';
import { diagnostics, KinuError } from '../obs/index';
import { craftedToolDescription } from './sandbox-contract';

export interface CraftedToolSource {
  name: string;
  description: string;
  code: string;
}

/** On error returns a string-form error so the codemode proxy can surface it to the LLM. */
export type CraftedToolExecuteFn = (arg: JsonValue) => Promise<JsonValue | undefined>;

/** Must be idempotent: the crafted set is resolved once per `eval` call, calling the factory once per tool. */
export type CraftedToolExecute = (tool: CraftedToolSource) => CraftedToolExecuteFn;

/**
 * Filters null/comment-only code. Uses `??`, not the `||` of {@link craftedToolDescription}: this is a codec,
 * so `''` round-trips (pinned by unit-crafted-executor.test.ts).
 */
export function toCraftedToolSource(t: CraftedTool): CraftedToolSource | null {
  const code = t.code?.trim();

  if (!code || code.startsWith('//')) return null;

  return { name: t.name, description: t.description ?? `Crafted tool: ${t.name}`, code };
}

/** Read failures must reach the caller, never masquerade as an empty tool set. */
export function selectInjectableCraftedTools(
  store: Pick<CraftStore, 'list'>, sql: SqlExecutor, minScore?: number,
): CraftedToolSource[] {
  const sources = store.list().flatMap((row) => {
    const source = toCraftedToolSource(row);

    if (!source || !source.name) return [];

    if (isReservedCraftToolName(source.name)) {
      diagnostics.failure('craft.tool_skipped', new KinuError('bad_input',
        `Crafted tool "${source.name}" is reserved — it collides with a built-in tool or the mcp_ prefix owned by MCP tools`),
      { tool: source.name });

      return [];
    }

    return [{ ...source, description: craftedToolDescription(source.name, source.description) }];
  });

  return filterByEffectiveScore(sql, sources, minScore);
}
