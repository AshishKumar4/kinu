/** Per-turn skill resolution, tool-surface restriction and facts block, shared by both backends. */

import type { ToolSet } from 'ai';
import {
  resolveActiveSkills, extractExplicitInvocations, admitSkillsIndex, admitActiveSkills,
} from '../skills/loader';
import { discoverSkills, BUILTIN_SKILL_HEADERS, type SkillsVfs } from '../skills/discover';
import { unionAllowedTools, toolAllowedBySkills, trustedActiveSkills, renderActiveSkillsSection } from '../skills/render';
import type { ActiveSkillSet, SkillsIndex } from '../skills/types';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { stepContextLimit, type ModelWindow } from '../context-window';
import { renderFactsBlock, type FactsStore } from '../memory/facts';
import { diagnostics, toKinuError } from '../obs/index';

export interface TurnSkillsConfig {
  getAlwaysActiveSkills(): string[];
}

/** What the turn's allocation admitted, not everything the store holds. */
export interface TurnSkillSurface {
  available: SkillsIndex;
  activeSkills: ActiveSkillSet | undefined;
}

/**
 * Bounded by `stepContextLimit`: the ambient index is charged first, active bodies get the rest
 * (same derivation as cf-backend/src/user/mcp.ts). Never fails the turn: falls back to built-ins.
 */
export async function resolveTurnSkills(opts: {
  vfs: SkillsVfs;
  config: TurnSkillsConfig;
  userText: string;
  limits: ModelWindow;
  /** Required, so no caller can obtain unclassified skills. */
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

    // Built-in bodies are module constants: no VFS needed.
    return {
      available: admitSkillsIndex({ skills: [...BUILTIN_SKILL_HEADERS], unread: [], omitted: 0 }, admissionTokens),
      activeSkills: undefined,
    };
  }
}

/** Skills a mid-turn message activates that the turn lacks, rendered for that step; null when none. */
export async function steerSkillsBlock(opts: Parameters<typeof resolveTurnSkills>[0] & {
  readonly alreadyActive: ReadonlySet<string>;
}): Promise<string | null> {
  const { activeSkills } = await resolveTurnSkills(opts);

  if (activeSkills === undefined) return null;
  const fresh = activeSkills.active.filter((skill) => !opts.alreadyActive.has(skill.name) && skill.body !== null);

  if (fresh.length === 0) return null;

  const rendered = renderActiveSkillsSection({
    active: fresh,
    reasons: activeSkills.reasons.filter((reason) => fresh.some((skill) => skill.name === reason.name)),
  }, 'system');

  return rendered === '' ? null : `${STEER_SKILLS_HEADING}\n${rendered}`;
}

const STEER_SKILLS_HEADING = 'The message above activates these skills; they apply for the rest of this turn.';

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

/** The trusted active skills' allowed_tools union bounds the surface (empty = no restriction).
 *  No tool is exempt, `eval` included. Untrusted skills set no policy (KINU-N028). */
export function filterToolNamesBySkills<T extends string>(
  names: readonly T[],
  activeSkills: ActiveSkillSet | undefined,
): T[] {
  if (!activeSkills) return [...names];
  const allowedUnion = unionAllowedTools(trustedActiveSkills(activeSkills));

  if (allowedUnion.length === 0) return [...names];

  return names.filter((name) => toolAllowedBySkills(name, allowedUnion));
}

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

/** Rendered fresh each turn so it never enters the cacheable prefix. */
export function renderFactsForTurn(facts: FactsStore): string | undefined {
  return renderFactsBlock(facts.recentTopK(20), { maxChars: 2000 }) || undefined;
}
