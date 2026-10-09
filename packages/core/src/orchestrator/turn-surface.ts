import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Per-turn skill resolution, tool-surface restriction and facts block, shared by both backends. */

import type { ToolSet } from 'ai';
import {
  resolveActiveSkills, extractExplicitInvocations, admitSkillsIndex, admitActiveSkills,
} from '../skills/loader';
import { discoverSkills, BUILTIN_SKILL_HEADERS } from '../skills/discover';
import { unionAllowedTools, toolAllowedBySkills, trustedActiveSkills, renderActiveSkillsSection } from '../skills/render';
import { renderUnverifiedInstructions } from '../prompt';
import type { ActiveSkillSet, SkillsIndex } from '../skills/types';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { stepContextLimit, type ModelWindow } from '../context-window';
import { renderFactsBlock, unifiedFacts, type Fact, type FactsStore } from '../memory/facts';
import { Cause, Effect } from 'effect';
import { diagnostics, settle, toKinuError } from '../obs/index';
import { STEER_SKILLS_HEADING, TURN_SKILLS_HEADING } from '../utils/prompt-sections';

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
export function resolveTurnSkills(opts: {
  vfs: VFS;
  config: TurnSkillsConfig;
  userText: string;
  limits: ModelWindow;
  /** Required, so no caller can obtain unclassified skills. */
  trust: InstructionTrustResolver;
  roleSkills?: readonly string[];
}): Promise<TurnSkillSurface> {
  const admissionTokens = stepContextLimit(opts.limits);

  return settle(Effect.catchCause(Effect.promise(() => admitTurnSkills(opts, admissionTokens)), (failed) => Effect.sync((): TurnSkillSurface => {
    diagnostics.failure(
      'skills.discovery_failed',
      toKinuError({ doing: 'discover the turn\'s skills', cause: Cause.squash(failed), otherwise: 'io' }),
    );

    // Built-in bodies are module constants: no VFS needed.
    return {
      available: admitSkillsIndex({ skills: [...BUILTIN_SKILL_HEADERS], unread: [], omitted: 0 }, admissionTokens),
      activeSkills: undefined,
    };
  })));
}

/** Skills a mid-turn message activates that the turn lacks, rendered for that step; null when none. */
export async function steerSkillsBlock(opts: Parameters<typeof resolveTurnSkills>[0] & {
  readonly alreadyActive: ReadonlySet<string>;
}): Promise<string | null> {
  const { activeSkills } = await resolveTurnSkills(opts);

  if (activeSkills === undefined) return null;

  return skillsBlock(STEER_SKILLS_HEADING, onlySkills(activeSkills, (skill) => !opts.alreadyActive.has(skill.name) && skill.body !== null));
}

/** A pin rides the system prompt every turn; a person's `/name` rides that turn's opening message. */
export interface TurnSkillPlacement {
  readonly pinned: ActiveSkillSet | undefined;
  readonly invoked: ActiveSkillSet | undefined;
}

export function splitTurnSkills(set: ActiveSkillSet | undefined): TurnSkillPlacement {
  if (set === undefined) return { pinned: undefined, invoked: undefined };
  const invoked = new Set(set.reasons.filter(({ reason }) => reason.kind === 'explicit').map(({ name }) => name));
  const nonEmpty = (part: ActiveSkillSet) => part.active.length === 0 ? undefined : part;

  return {
    pinned: nonEmpty(onlySkills(set, (skill) => !invoked.has(skill.name))),
    invoked: nonEmpty(onlySkills(set, (skill) => invoked.has(skill.name))),
  };
}

/**
 * Skills a person's message activates, as one turn-only message just before it; null when none renders. Never the
 * system prompt, where a body would rewrite the cached prefix on the turn it arrives and again on the next.
 */
export function activatedSkillsBlock(set: ActiveSkillSet): string | null {
  return skillsBlock(TURN_SKILLS_HEADING, set);
}

/** Unapproved bodies ride sealed, as the instruction files do. */
function skillsBlock(heading: string, set: ActiveSkillSet): string | null {
  const parts = [renderActiveSkillsSection(set, 'system').trim(), renderUnverifiedInstructions({ activeSkills: set }) ?? '']
    .filter((part) => part !== '');

  return parts.length === 0 ? null : `${heading}\n\n${parts.join('\n\n')}`;
}

function onlySkills(set: ActiveSkillSet, keep: (skill: ActiveSkillSet['active'][number]) => boolean): ActiveSkillSet {
  const active = set.active.filter(keep);

  return { active, reasons: set.reasons.filter((reason) => active.some((skill) => skill.name === reason.name)) };
}

async function admitTurnSkills(
  opts: {
    vfs: VFS;
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

/** Trusted active skills' allowed_tools union, `eval` included; null when empty. */
function skillToolBound(activeSkills: ActiveSkillSet | undefined): ((name: string) => boolean) | null {
  if (!activeSkills) return null;
  const allowedUnion = unionAllowedTools(trustedActiveSkills(activeSkills));

  return allowedUnion.length === 0 ? null : (name) => toolAllowedBySkills(name, allowedUnion);
}

export function filterToolSetBySkills(tools: ToolSet, activeSkills: ActiveSkillSet | undefined): ToolSet {
  const allowed = skillToolBound(activeSkills);

  return allowed === null ? tools : Object.fromEntries(Object.entries(tools).filter(([name]) => allowed(name)));
}

/**
 * Rendered fresh each step, so it never enters the cacheable prefix, from the workspace's newest facts and the account's,
 * which the turn read once (`TurnAssemblySources.accountFacts`): the block's bytes change only when a fact does.
 */
export function renderFactsForTurn(facts: FactsStore, account: readonly Fact[] = []): string | undefined {
  // Every key this workspace holds suppresses the account's, not only the newest twenty the block shows.
  const held = account.length === 0 ? new Set<string>() : new Set(facts.all().map((fact) => fact.key));
  const shared = account.filter((fact) => !held.has(fact.key));

  return renderFactsBlock(unifiedFacts(facts.recentTopK(20), shared), { maxChars: account.length === 0 ? 2000 : 3000 }) || undefined;
}
