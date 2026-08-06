/**
 * The per-turn capability surface — which skills are active this turn and how
 * they restrict the tool surface, plus the facts block that rides the
 * volatile turn context. One implementation for both backends (each
 * previously carried its own copy of the resolution gate, the union
 * filtering, the SkillsVfs shim, and the facts rendering).
 */

import type { ToolSet } from 'ai';
import { resolveActiveSkills, extractExplicitInvocations } from '../skills/loader.js';
import { discoverSkills, type SkillsVfs } from '../skills/discover.js';
import { BUILTIN_SKILLS } from '../skills/builtins.js';
import { unionAllowedTools, toolAllowedBySkills } from '../skills/render.js';
import type { ActiveSkillSet } from '../skills/types.js';
import { renderFactsBlock, type FactsStore } from '../memory/facts.js';
import type { VFS } from '../types/primitives.js';

/** Passthrough SkillsVfs shim over the runtime's Storage.vfs. */
export function skillsVfsOver(vfs: VFS): SkillsVfs {
  return {
    exists: (p) => vfs.exists(p),
    readFile: (p, opts) => vfs.readFile(p, opts),
    writeFile: (p, data) => vfs.writeFile(p, data),
    readdir: (p) => vfs.readdir(p),
    unlink: (p) => vfs.unlink(p),
    mkdir: (p, opts) => vfs.mkdir(p, opts),
  };
}

export interface TurnSkillsConfig {
  getAlwaysActiveSkills(): string[];
}

/**
 * Resolve the skills active for this turn — explicit /invocations, the
 * always-active config, and builtin auto-activation. Only scans the VFS when
 * activation is plausible (explicit invocation, always_active config, or an
 * auto-activating builtin), so vanilla turns pay no filesystem walk. The
 * activated names are recorded onto the per-turn `invoked` tracker so
 * skills.list reflects what is active right now. Never fails the turn.
 */
export async function resolveTurnSkills(opts: {
  vfs: SkillsVfs;
  config: TurnSkillsConfig;
  userText: string;
  invoked: Set<string>;
}): Promise<ActiveSkillSet | undefined> {
  try {
    const explicit = extractExplicitInvocations(opts.userText);
    const alwaysActive = opts.config.getAlwaysActiveSkills();
    const anyAutoActivate = BUILTIN_SKILLS.some((s) => s.auto_activate);
    if (explicit.length === 0 && alwaysActive.length === 0 && !anyAutoActivate) return undefined;
    const available = await discoverSkills(opts.vfs);
    const activeSet = resolveActiveSkills({
      available, explicit, userMessage: opts.userText, alwaysActive,
    });
    if (activeSet.active.length === 0) return undefined;
    for (const r of activeSet.reasons) opts.invoked.add(r.name);
    return activeSet;
  } catch (err) {
    console.warn('[proteus] skills resolution failed:', (err as Error).message);
    return undefined;
  }
}

/** The one restriction rule: the active skills' allowed_tools union bounds the
 *  surface (empty union = skills don't restrict), and the `skills` tool itself
 *  ALWAYS stays reachable so the LLM can list / read / invoke more skills
 *  mid-turn — filtering it out would lock the agent into the first activation. */
function allowedBySkills(name: string, allowedUnion: string[]): boolean {
  return name === 'skills' || toolAllowedBySkills(name, allowedUnion);
}

/** Restrict a tool-NAME list (the cf activeTools whitelist) to the active
 *  skills' allowed union. Returns the input array untouched when skills don't
 *  restrict. */
export function filterToolNamesBySkills<T extends string>(
  names: readonly T[],
  activeSkills: ActiveSkillSet | undefined,
): T[] {
  if (!activeSkills) return [...names];
  const allowedUnion = unionAllowedTools(activeSkills.active);
  if (allowedUnion.length === 0) return [...names];
  const filtered = names.filter((name) => allowedBySkills(name, allowedUnion));
  if (!filtered.includes('skills' as T)) filtered.push('skills' as T);
  return filtered;
}

/** Restrict a ToolSet (the CLI turn surface) to the active skills' allowed
 *  union. Returns the input object untouched when skills don't restrict. */
export function filterToolSetBySkills(tools: ToolSet, activeSkills: ActiveSkillSet | undefined): ToolSet {
  if (!activeSkills) return tools;
  const allowedUnion = unionAllowedTools(activeSkills.active);
  if (allowedUnion.length === 0) return tools;
  const filtered: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (allowedBySkills(name, allowedUnion)) filtered[name] = t;
  }
  return filtered;
}

/** The recent-facts world-model block for the volatile turn context (see
 *  prompting/volatile-context.ts) — rendered fresh each turn so it never
 *  enters the cacheable prefix. Undefined when there are no facts yet. */
export function renderFactsForTurn(facts: FactsStore): string | undefined {
  try {
    return renderFactsBlock(facts.recentTopK(20), { maxChars: 2000 }) || undefined;
  } catch { return undefined; /* facts table not yet initialized */ }
}
