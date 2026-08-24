/**
 * The per-turn capability surface — which skills are active this turn and how
 * they restrict the tool surface, plus the facts block that rides the
 * volatile turn context. One implementation for both backends (each
 * previously carried its own copy of the resolution gate, the union
 * filtering, the SkillsVfs shim, and the facts rendering).
 */

import type { ToolSet } from 'ai';
import { resolveActiveSkills, extractExplicitInvocations } from '../skills/loader';
import { discoverSkills, type SkillsVfs } from '../skills/discover';
import { BUILTIN_SKILLS } from '../skills/builtins';
import { unionAllowedTools, toolAllowedBySkills } from '../skills/render';
import type { ActiveSkillSet, ParsedSkill } from '../skills/types';
import { renderFactsBlock, type FactsStore } from '../memory/facts';
import type { VFS } from '../types/primitives';
import { diagnostics, toKinuError } from '../obs/index';

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

/** What a turn needs from the skills store: every available skill (for the
 *  ambient index, always rendered) plus whichever ones are active this turn
 *  (for the expanded-body section and the tool-surface restriction). */
export interface TurnSkillSurface {
  available: ParsedSkill[];
  activeSkills: ActiveSkillSet | undefined;
}

/**
 * Resolve this turn's skill surface — every available skill (built-ins + VFS,
 * for the ambient name+description index every turn renders) and which of
 * them are active (explicit /invocation, always-active config, or a builtin's
 * auto-activate keyword match).
 *
 * Discovery now runs on every turn: the ambient index needs the full catalogue
 * regardless of whether anything activates, which is the one filesystem walk
 * this call was previously skipping on a vanilla turn. Never fails the turn —
 * a discovery error still returns the built-ins so the index isn't silently
 * empty. */
export async function resolveTurnSkills(opts: {
  vfs: SkillsVfs;
  config: TurnSkillsConfig;
  userText: string;
  roleSkills?: readonly string[];
}): Promise<TurnSkillSurface> {
  let available: ParsedSkill[];
  try {
    available = await discoverSkills(opts.vfs);
  } catch (err) {
    diagnostics.failure(
      'skills.discovery_failed',
      toKinuError({ doing: 'discover the turn\'s skills', cause: err, otherwise: 'io' }),
    );
    available = [...BUILTIN_SKILLS];
  }
  const explicit = extractExplicitInvocations(opts.userText);
  const alwaysActive = [
    ...opts.config.getAlwaysActiveSkills(),
    ...(opts.roleSkills ?? []),
  ];
  const activeSet = resolveActiveSkills({
    available, explicit, userMessage: opts.userText, alwaysActive,
  });
  return { available, activeSkills: activeSet.active.length > 0 ? activeSet : undefined };
}

/** The one restriction rule: the active skills' allowed_tools union bounds
 *  the surface (empty union = skills don't restrict). No name is exempted —
 *  there is no `skills` tool left to protect from its own restriction, and
 *  `execute_tools` (the only remaining path to a skill's own VFS bytes) is
 *  deliberately NOT exempted either: a skill that restricts the surface
 *  and omits execute_tools means it, the same as it means it for any other
 *  tool. Discovering or authoring more skills mid-restriction can wait for
 *  the next turn, where resolveTurnSkills re-evaluates from the new message,
 *  unaffected by what the previous turn excluded. */
function allowedBySkills(name: string, allowedUnion: string[]): boolean {
  return toolAllowedBySkills(name, allowedUnion);
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
  return names.filter((name) => allowedBySkills(name, allowedUnion));
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
  return renderFactsBlock(facts.recentTopK(20), { maxChars: 2000 }) || undefined;
}
