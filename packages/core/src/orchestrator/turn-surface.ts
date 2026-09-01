/**
 * The per-turn capability surface — which skills are active this turn and how
 * they restrict the tool surface, plus the facts block that rides the
 * volatile turn context. One implementation for both backends (each
 * previously carried its own copy of the resolution gate, the union
 * filtering, the SkillsVfs shim, and the facts rendering).
 */

import type { ToolSet } from 'ai';
import {
  resolveActiveSkills, extractExplicitInvocations, admitSkillsIndex, admitActiveSkills,
} from '../skills/loader';
import { discoverSkills, BUILTIN_SKILL_HEADERS, type SkillsVfs } from '../skills/discover';
import { unionAllowedTools, toolAllowedBySkills, trustedActiveSkills } from '../skills/render';
import type { ActiveSkillSet, SkillsIndex } from '../skills/types';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { stepContextLimit, type ModelWindow } from '../prompting/step-prune';
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
    stat: (p) => vfs.stat(p),
    unlink: (p) => vfs.unlink(p),
    mkdir: (p, opts) => vfs.mkdir(p, opts),
  };
}

export interface TurnSkillsConfig {
  getAlwaysActiveSkills(): string[];
}

/** What a turn needs from the skills store: the ambient index (rendered every
 *  turn) plus whichever skills are active this turn (for the expanded-body
 *  section and the tool-surface restriction). Both are what the turn's
 *  allocation ADMITTED, not everything the store holds. */
export interface TurnSkillSurface {
  available: SkillsIndex;
  activeSkills: ActiveSkillSet | undefined;
}

/**
 * Resolve this turn's skill surface — the ambient name+description index every
 * turn renders, and which skills are active (explicit /invocation, always-active
 * config, or an auto-activate keyword match).
 *
 * Bounded by the model rather than by a char cap: `stepContextLimit` over the
 * resolved window and its answer reserve IS the allocation, the ambient index is
 * charged against it first, and the active bodies get the remainder — the same
 * derivation the MCP catalogue admission uses (cf-backend/src/user/mcp.ts). That
 * same number is what stops discovery from opening a file it could never afford.
 *
 * Discovery runs on every turn: the ambient index needs the full catalogue
 * whether or not anything activates. It reads front matter only — bodies are
 * fetched here, for the active skills the allocation admitted, and for nothing
 * else. Never fails the turn: a VFS failure still yields the built-in floor so
 * the index isn't silently empty.
 */
export async function resolveTurnSkills(opts: {
  vfs: SkillsVfs;
  config: TurnSkillsConfig;
  userText: string;
  /** The resolved model's window and the answer allowance it reserves. */
  limits: ModelWindow;
  /** Whether the owner approved a workspace skill's exact bytes. Required, so
   *  no caller can obtain skills that were never classified. */
  trust: InstructionTrustResolver;
  roleSkills?: readonly string[];
}): Promise<TurnSkillSurface> {
  const admissionTokens = stepContextLimit(opts.limits);
  try {
    return await admitTurnSkills(opts, admissionTokens);
  } catch (err) {
    diagnostics.failure(
      'skills.discovery_failed',
      toKinuError({ doing: 'discover the turn\'s skills', cause: err, otherwise: 'io' }),
    );
    // The built-in floor: those bodies are module constants, so this surface
    // needs no VFS at all and cannot fail the way the walk just did.
    return {
      available: admitSkillsIndex({ skills: [...BUILTIN_SKILL_HEADERS], unread: [] }, admissionTokens),
      activeSkills: undefined,
    };
  }
}

async function admitTurnSkills(
  opts: {
    vfs: SkillsVfs;
    config: TurnSkillsConfig;
    userText: string;
    trust: InstructionTrustResolver;
    roleSkills?: readonly string[];
  },
  admissionTokens: number,
): Promise<TurnSkillSurface> {
  const discovery = await discoverSkills(opts.vfs, { admissionTokens });
  const available = admitSkillsIndex(discovery, admissionTokens);
  const activated = resolveActiveSkills({
    available: discovery.skills,
    explicit: extractExplicitInvocations(opts.userText),
    userMessage: opts.userText,
    alwaysActive: [...opts.config.getAlwaysActiveSkills(), ...(opts.roleSkills ?? [])],
  });
  if (activated.length === 0) return { available, activeSkills: undefined };
  return {
    available,
    activeSkills: await admitActiveSkills({
      vfs: opts.vfs,
      activated,
      admissionTokens: admissionTokens - available.tokens,
      trust: opts.trust,
    }),
  };
}

/** The one restriction rule: the active skills' allowed_tools union bounds
 *  the surface (empty union = skills don't restrict). No name is exempted —
 *  there is no `skills` tool left to protect from its own restriction, and
 *  `execute_tools` (the only remaining path to a skill's own VFS bytes) is
 *  deliberately NOT exempted either: a skill that restricts the surface
 *  and omits execute_tools means it, the same as it means it for any other
 *  tool. Discovering or authoring more skills mid-restriction can wait for
 *  the next turn, where resolveTurnSkills re-evaluates from the new message,
 *  unaffected by what the previous turn excluded.
 *
 *  Only TRUSTED skills are counted (KINU-N028). `allowed_tools` is policy, and
 *  the union is a widening operation, so an unapproved file could otherwise
 *  hand itself a tool a legitimately active skill had excluded — or invent a
 *  restriction where the owner intended none. A skill the agent may have
 *  written renders as reference material and sets no policy.
 *
 *  Applied by the two filters below — a tool-NAME list (the cf activeTools
 *  whitelist) and a ToolSet (the CLI turn surface) — through the one predicate
 *  `toolAllowedBySkills` owns.
 *
 *  Restrict a tool-NAME list to the active skills' allowed union. Returns the
 *  input array untouched when skills don't restrict. */
export function filterToolNamesBySkills<T extends string>(
  names: readonly T[],
  activeSkills: ActiveSkillSet | undefined,
): T[] {
  if (!activeSkills) return [...names];
  const allowedUnion = unionAllowedTools(trustedActiveSkills(activeSkills));
  if (allowedUnion.length === 0) return [...names];
  return names.filter((name) => toolAllowedBySkills(name, allowedUnion));
}

/** The same restriction over a ToolSet (the CLI turn surface). Returns the
 *  input object untouched when skills don't restrict. */
export function filterToolSetBySkills(tools: ToolSet, activeSkills: ActiveSkillSet | undefined): ToolSet {
  if (!activeSkills) return tools;
  const allowedUnion = unionAllowedTools(trustedActiveSkills(activeSkills));
  if (allowedUnion.length === 0) return tools;
  const filtered: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (toolAllowedBySkills(name, allowedUnion)) filtered[name] = t;
  }
  return filtered;
}

/** The recent-facts world-model block for the volatile turn context (see
 *  prompting/volatile-context.ts) — rendered fresh each turn so it never
 *  enters the cacheable prefix. Undefined when there are no facts yet. */
export function renderFactsForTurn(facts: FactsStore): string | undefined {
  return renderFactsBlock(facts.recentTopK(20), { maxChars: 2000 }) || undefined;
}
