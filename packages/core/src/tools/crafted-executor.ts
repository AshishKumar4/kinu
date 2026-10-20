/** Crafted source selection; each backend compiles a body in the program that calls it (`renderCraftedDefinitions`). */

import type { CraftedTool } from '../types/craft';
import type { CraftStore } from '../types/agent-runtime';
import type { SqlExecutor } from '../types/primitives';
import { rankByPreference } from '../craft/preference';
import { isReservedCraftToolName } from '../craft/in-episode';
import { holdsNoCode } from '../craft/source';
import { diagnostics, KinuError } from '../obs/index';
import { craftedToolDescription } from './sandbox-contract';

export interface CraftedToolSource {
  name: string;
  description: string;
  code: string;
}

/**
 * Filters a row that holds no code, comments aside; a tool whose source opens with a comment is still a tool. Uses
 * `??`, not the `||` of {@link craftedToolDescription}: this is a codec, so `''` round-trips (pinned by
 * unit-crafted-executor.test.ts).
 */
export function toCraftedToolSource(t: CraftedTool): CraftedToolSource | null {
  const code = t.code?.trim();

  if (!code || holdsNoCode(code)) return null;

  return { name: t.name, description: t.description ?? `Crafted tool: ${t.name}`, code };
}

/**
 * The crafted tools a turn is offered, best preference first and capped (craft/preference.ts); a broken one says so
 * in its description. Read failures must reach the caller, never masquerade as an empty tool set.
 */
export function selectInjectableCraftedTools(store: Pick<CraftStore, 'list'>, sql: SqlExecutor): CraftedToolSource[] {
  const sources = store.list().flatMap((row) => {
    const source = toCraftedToolSource(row);

    if (!source || !source.name) return [];

    if (isReservedCraftToolName(source.name)) {
      diagnostics.failure('craft.tool_skipped', new KinuError('bad_input',
        `Crafted tool "${source.name}" is reserved: it collides with a built-in tool or the mcp_ prefix owned by MCP tools`),
      { tool: source.name });

      return [];
    }

    return [{ ...source, description: craftedToolDescription(source.name, source.description) }];
  });

  return rankByPreference(sql, sources).map(({ broken, ...source }) => (broken === null ? source : {
    ...source,
    description: `${source.description} Broken: its last call raised ${JSON.stringify(broken)}. Rewrite it with `
      + '`workspace.createTool`, or retire it with `workspace.retireTool`.',
  }));
}
