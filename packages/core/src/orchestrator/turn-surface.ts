import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Per-turn skill resolution, tool-surface restriction and facts block, shared by both backends. */

import type { ToolSet } from 'ai';
import {
  resolveActiveSkills, extractExplicitInvocations, admitSkillsIndex, admitActiveSkills,
} from '../skills/loader';
import { discoverSkills, BUILTIN_SKILL_HEADERS, type DiscoverOpts } from '../skills/discover';
import { unionAllowedTools, toolAllowedBySkills, trustedActiveSkills, renderActiveSkillsSection } from '../skills/render';
import { renderUnverifiedInstructions } from '../prompt';
import type { ActiveSkillSet, SkillsIndex } from '../skills/types';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { stepContextLimit, type ModelWindow } from '../context-window';
import { factLine, renderMemoryBlock, type FactsStore } from '../memory/facts';
import type { RecalledMemory } from '../memory/turn-recall';
import type { AccountTurnView } from '../memory/account-profile';
import { isoDate } from '../utils/date';
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
 * Bounded by `stepContextLimit`: the ambient index is charged first, active bodies get the rest.
 * Never fails the turn: falls back to built-ins.
 */
export function resolveTurnSkills(opts: {
  vfs: VFS;
  config: TurnSkillsConfig;
  userText: string;
  limits: ModelWindow;
  /** Required, so no caller can obtain unclassified skills. */
  trust: InstructionTrustResolver;
  roleSkills?: readonly string[];
  hides?: DiscoverOpts['hides'];
  shared?: DiscoverOpts['shared'];
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

  return skillsBlock(STEER_SKILLS_HEADING, { active: activeSkills.active.filter((skill) => !opts.alreadyActive.has(skill.name) && skill.body !== null) });
}

/** A pin rides the system prompt every turn; a person's `/name` rides that turn's opening message. */
export interface TurnSkillPlacement {
  readonly pinned: ActiveSkillSet | undefined;
  readonly invoked: ActiveSkillSet | undefined;
}

export function splitTurnSkills(set: ActiveSkillSet | undefined): TurnSkillPlacement {
  if (set === undefined) return { pinned: undefined, invoked: undefined };
  const part = (active: ActiveSkillSet['active']) => active.length === 0 ? undefined : { active };

  return {
    pinned: part(set.active.filter((skill) => skill.reason.kind !== 'explicit')),
    invoked: part(set.active.filter((skill) => skill.reason.kind === 'explicit')),
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
  const parts = [renderActiveSkillsSection(set, 'system', 'reason').trim(), renderUnverifiedInstructions({ activeSkills: set }) ?? '']
    .filter((part) => part !== '');

  return parts.length === 0 ? null : `${heading}\n\n${parts.join('\n\n')}`;
}

async function admitTurnSkills(
  opts: Omit<Parameters<typeof resolveTurnSkills>[0], 'limits'>,
  admissionTokens: number,
): Promise<TurnSkillSurface> {
  const discovery = await discoverSkills(opts.vfs, {
    admissionTokens, trust: opts.trust, ...(opts.hides !== undefined && { hides: opts.hides }), ...(opts.shared !== undefined && { shared: opts.shared }),
  });

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

/** The memory block's allowance in characters: 2,000, about 500 tokens at four characters a token. What the turn recalls
 *  takes the place of newer facts, never more room. */
const MEMORY_BLOCK_CHARS = 2000;

/** The newest workspace facts the block shows after what the turn matched. */
const NEWEST_FACTS = 20;

/** A recalled note's line: dated where its heading dates it, marked where a fact has since changed what it says. */
function noteLine(note: Extract<RecalledMemory, { kind: 'note' }>): string {
  const marks = [...(note.at === null ? [] : [isoDate(note.at)]), ...(note.supersededBy === null ? [] : [`superseded by fact ${note.supersededBy}`])];

  return `note ${note.ref}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}: ${note.text.replace(/\s+/gu, ' ').trim()}`;
}

/**
 * Rendered fresh each step, so it never enters the cacheable prefix: first what the turn's words recalled
 * (`recallForTurn`), then the workspace's newest facts, within {@link MEMORY_BLOCK_CHARS}: a matched fact or note is
 * never crowded out by a newer one, and one long note crowds out nothing after it. A key the account's profile shows
 * (this workspace's value in its place where it holds one) is not shown again; the account's limits near their end lead.
 */
export function renderMemoryForTurn(
  facts: Pick<FactsStore, 'recentTopK' | 'recall'>, recalled: readonly RecalledMemory[] = [], account?: AccountTurnView,
): string | undefined {
  const shown = new Set(account?.profile.shown);
  const limits = account?.limits == null ? [] : [factLine({ key: 'account limits', value: account.limits, scope: 'account' })];

  const matched = recalled.flatMap((memory) => {
    if (memory.kind === 'note') return [noteLine(memory)];
    const fact = memory.scope === 'workspace' ? facts.recall(memory.key) : null;

    if (fact === null || shown.has(fact.key)) return [];
    shown.add(fact.key);

    return [factLine(fact, `as of ${isoDate(fact.lastObservedAt)}`)];
  });

  const newest = facts.recentTopK(NEWEST_FACTS).filter((fact) => !shown.has(fact.key)).map((fact) => factLine(fact));

  const block = renderMemoryBlock(matched.length === 0 ? [{ lines: [...limits, ...newest] }] : [
    { lines: limits },
    { heading: "# What this turn's words match, best first", lines: matched },
    { heading: '# Your newest facts', lines: newest },
  ], MEMORY_BLOCK_CHARS);

  return block === '' ? undefined : block;
}
