/**
 * Crafted source selection and host-side execution contracts.
 *
 * CF compiles source at module scope in a Worker Loader sandbox; local
 * Node/Bun execution compiles it in-process. The platform catalog's
 * `isolate.codegen_blocked` measurement pins why CF cannot use a host callback.
 *
 * Both adapters select source through this module. Only host-side execution
 * needs `CraftedToolExecute`; CF compiles the selected source in its sandbox
 * prelude and explicitly declares no host-side callable.
 */

import type { CraftedTool } from '../types/craft';
import type { JsonValue } from '../utils/json';
import type { CraftStore } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import { filterByEffectiveScore } from '../craft/ema';
import { isReservedCraftToolName } from '../craft/in-episode';
import { diagnostics, KinuError } from '../obs/index';
import { craftedToolDescription } from './sandbox-contract';

/**
 * Input shape the executor needs from a crafted tool. Not a full CraftedTool
 * — we deliberately accept only the fields needed so test harnesses can mock
 * with a literal.
 */
export interface CraftedToolSource {
  name: string;
  description: string;
  code: string;
}

/**
 * Produced by `craftedToolExecute(tool)`: an `execute` callback compatible
 * with codemode's `options.tools` entry shape. Each call goes to a child
 * Worker (CF) or an in-process eval (CLI). On error, returns a string-form
 * error so the caller's codemode proxy can surface it to the LLM.
 */
export type CraftedToolExecuteFn = (arg: JsonValue) => Promise<JsonValue | undefined>;

/**
 * Platform factory. Given a crafted tool row, return the host-side execute
 * function that codemode will invoke via RPC whenever the sandbox calls
 * `tools.<name>(arg)`. Implementations MUST be idempotent — the crafted set is
 * resolved once per `execute_tools` call (so a tool crafted mid-turn is
 * callable on the next one), and each resolve calls the factory once per tool.
 */
export type CraftedToolExecute = (tool: CraftedToolSource) => CraftedToolExecuteFn;

/**
 * Lift a storage-row CraftedTool into the narrow CraftedToolSource shape.
 * Filters null/comment-only code so the executor never has to special-case.
 *
 * `??`, NOT the `||` that {@link craftedToolDescription} applies, and the
 * difference is deliberate (pinned by unit-crafted-executor.test.ts). This is a
 * CODEC: a description stored as `''` is carried as `''`, because a row is
 * reported as written. The label helper answers a different question — what to
 * SHOW a model that has nothing useful to read — and there an empty string is
 * worth replacing. Unifying them would have quietly made the codec lossy.
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
