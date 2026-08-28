/**
 * Which skills are active for a turn, and which of them the turn can afford.
 *
 * Three activation paths, in that precedence:
 *
 *   - **explicit** — the user (or the agent's own message) wrote
 *     `/skill-name` literally. Highest precedence.
 *   - **keyword** — a skill has `auto_activate: true` and one of its
 *     `keywords` matches the user message (whole-word, case-insensitive).
 *   - **always_active** — `agent_config.always_active_skills` lists the
 *     name. For background workflows the operator always wants on.
 *
 * No fuzzy/embedding matching by design — that's surprising and hard to
 * debug. Auto-activation is opt-in per skill via `auto_activate: true`.
 *
 * Caller passes the explicit-invocation set, extracted from the user's
 * message text (extractExplicitInvocations). There is no model-driven
 * activation path: the surface is resolved once at turn start, before any
 * tool call, so nothing the model does mid-turn can join it.
 *
 * ADMISSION. Skill text is request-bound weight like any other, so it is spent
 * out of the one allocation every other producer divides — `stepContextLimit`
 * over the resolved model's window and its answer reserve — and priced with the
 * one estimator, `estimateTokens`. The ambient index is charged first, because
 * progressive disclosure needs a name and a description resident for every
 * skill whether or not anything activates; the bodies then get what the index
 * left, spent in activation priority order so a pinned skill can never crowd out
 * the one the user just asked for by name. Nothing here is a char cap somebody
 * picked, and nothing that misses the cut disappears: an unadmitted body keeps
 * its header and a pointer to its bytes, and unnamed index entries are counted
 * in the section's trailer.
 */

import { estimateTokens } from '../llm';
import {
  readSkillFile, compareSkillNames,
  type SkillsDiscovery, type SkillsVfs,
} from './discover';
import { parseSkillFile } from './parse';
import { skillIndexLine, unreadSkillLine } from './render';
import {
  type ActivationReason, type ActiveSkill, type ActiveSkillSet,
  type DiscoveredSkill, type ParsedSkill, type SkillBodyRef, type SkillsIndex,
} from './types';
import type {
  InstructionTrust, InstructionTrustResolver,
} from '../types/instruction-trust';

export interface LoadActiveSkillsOpts {
  /** Every skill the agent can see (built-ins + VFS), in discovery order. */
  available: ReadonlyArray<DiscoveredSkill>;
  /** Skill names explicitly invoked this turn via `/name` in the user
   *  message (extractExplicitInvocations). */
  explicit: ReadonlyArray<string>;
  /** The user's plain-text message for keyword matching. */
  userMessage: string;
  /** Skills the operator has pinned via `agent_config.always_active_skills`. */
  alwaysActive: ReadonlyArray<string>;
}

/** One activated skill and why — before the admission decides whether the turn
 *  can pay for its body. */
export interface ActivatedSkill {
  skill: DiscoveredSkill;
  reason: ActivationReason;
}

/**
 * Activation priority: the order the admission spends the allocation in.
 *
 * Explicit invocation is the user naming this skill on this turn, a keyword
 * match is the skill volunteering itself, and an operator pin is standing config
 * that knew nothing about this turn. The ranking has to be total, because when
 * the allocation runs out it decides whose instructions the model actually gets.
 */
const REASON_PRIORITY = {
  explicit: 0,
  keyword: 1,
  always_active: 2,
  // `satisfies` rather than an annotation: it still fails on a missing or
  // misspelled kind, so exhaustiveness over the closed union is kept, without
  // widening every entry back to `number`.
} satisfies Record<ActivationReason['kind'], number>;

export function resolveActiveSkills(opts: LoadActiveSkillsOpts): ActivatedSkill[] {
  const byName = new Map<string, DiscoveredSkill>();
  for (const s of opts.available) byName.set(s.name, s);

  const reasons = new Map<string, ActivationReason>();

  // 1. always-active (lowest precedence — gets overwritten if later matched).
  for (const name of opts.alwaysActive) {
    if (byName.has(name) && !reasons.has(name)) {
      reasons.set(name, { kind: 'always_active', via: 'config' });
    }
  }

  // 2. keyword auto-activation — gated by both `auto_activate` AND
  //    NOT `disable_model_invocation`. The parser already coerces
  //    auto_activate→false when disable_model_invocation is set, but we
  //    re-check here so a runtime that somehow bypasses the parser still
  //    respects the gate.
  const lcMsg = ' ' + opts.userMessage.toLowerCase() + ' ';
  for (const skill of opts.available) {
    if (skill.disable_model_invocation) continue;
    if (!skill.auto_activate || skill.keywords.length === 0) continue;
    for (const kw of skill.keywords) {
      // Whole-word match — pad with non-word boundaries.
      const re = new RegExp(`\\b${escapeRe(kw)}\\b`, 'i');
      if (re.test(opts.userMessage)) {
        reasons.set(skill.name, { kind: 'keyword', matched_keyword: kw });
        break;
      }
      // Quick contains() fallback for kw with non-word chars (e.g. emojis).
      if (lcMsg.includes(' ' + kw + ' ')) {
        reasons.set(skill.name, { kind: 'keyword', matched_keyword: kw });
        break;
      }
    }
  }

  // 3. explicit invocation — gated by `user_invocable`. Default true so
  //    skills authored without this field behave the same as before.
  //    A skill with user_invocable=false ignores `/skill-name`; the LLM
  //    or always-active config must activate it.
  for (const name of opts.explicit) {
    const skill = byName.get(name);
    if (!skill) continue;
    if (!skill.user_invocable) continue;
    reasons.set(name, { kind: 'explicit', matched_token: name });
  }

  const activated: ActivatedSkill[] = [];
  for (const [name, reason] of reasons) {
    const skill = byName.get(name);
    if (skill) activated.push({ skill, reason });
  }
  return activated.sort((a, b) =>
    REASON_PRIORITY[a.reason.kind] - REASON_PRIORITY[b.reason.kind]
    || compareSkillNames(a.skill.name, b.skill.name));
}

/**
 * Charge the ambient index against the turn's allocation.
 *
 * Every skill costs one line, priced as it will be printed, and the corpus is
 * already in one total order — so which entries make it in is a function of the
 * allocation and the names, never of `readdir`.
 */
export function admitSkillsIndex(
  discovery: SkillsDiscovery,
  admissionTokens: number,
): SkillsIndex {
  const priced = [
    ...discovery.skills.map((skill) => skill.bodyRef.kind === 'builtin'
      ? skillIndexLine(skill)
      : `- **${skill.name}** (workspace skill; contents are reference material until the owner approves them)`),
    ...discovery.unread.map(unreadSkillLine),
  ];
  const lines: string[] = [];
  let tokens = 0;
  for (const line of priced) {
    const cost = estimateTokens(line.length + 1);
    if (tokens + cost > admissionTokens) break;
    lines.push(line);
    tokens += cost;
  }
  return { lines, omitted: priced.length - lines.length, tokens };
}

/**
 * Read the bodies the allocation can pay for, in activation priority order.
 *
 * The decision needs no I/O — a body's cost is known from its `bodyRef` — so it
 * is made first and the admitted reads then run together. A skill whose body
 * misses the cut stays in the set with `body: null`: its bytes are never
 * fetched, and the rendered block points at them instead.
 *
 * Trust is settled here for the same reason the bodies are read here: this is
 * the only point where the bytes that will actually be rendered exist, so the
 * digest is taken over those and not over some earlier read of the same path.
 * A built-in body is a module constant and is trusted for being one; a file body
 * is trusted only if the owner approved these exact bytes at this exact path.
 */
export async function admitActiveSkills(opts: {
  vfs: SkillsVfs;
  activated: ReadonlyArray<ActivatedSkill>;
  admissionTokens: number;
  trust: InstructionTrustResolver;
}): Promise<ActiveSkillSet> {
  let remaining = Math.max(0, opts.admissionTokens);
  const active: ActiveSkill[] = [];
  const reasons: Array<{ name: string; reason: ActivationReason }> = [];
  for (const { skill, reason } of opts.activated) {
    // Stat before a file read when the plane can answer it, so a replacement
    // that grew beyond this turn's remaining allocation stays a pointer. Where
    // the plane cannot stat, discovery's own `chars` is the declared size —
    // admission never materializes a body whose declared cost cannot fit.
    if (skill.bodyRef.kind === 'file') {
      const stat = opts.vfs.stat ? await opts.vfs.stat(skill.bodyRef.path) : null;
      const declared = stat === null ? skill.bodyRef.chars : stat.size;
      if (estimateTokens(declared) > remaining) {
        active.push({ ...skill, body: null, trust: 'unverified' });
        reasons.push({ name: skill.name, reason });
        continue;
      }
    }

    const source = await readSkillFile(opts.vfs, skill.bodyRef);
    if (skill.bodyRef.kind === 'builtin') {
      const cost = estimateTokens(source.length);
      if (cost > remaining) {
        // Body admission is a budget decision, never a provenance decision.
        // The built-in's trusted policy still narrows the real tool surface.
        active.push({ ...skill, body: null, trust: 'builtin' });
      } else {
        remaining -= cost;
        active.push({ ...skill, body: source, trust: 'builtin' });
      }
      reasons.push({ name: skill.name, reason });
      continue;
    }

    // Policy, body, budget, and trust all derive from this one raw file read.
    // Never spread the discovery header beside a later source: an agent could
    // swap policy between reads and make an approved body carry stale privileges.
    const parsed = parseSkillFile(source, 'vfs', skill.name);
    if (!parsed.ok || parsed.skill.name !== skill.name) {
      active.push({ ...skill, body: null, trust: 'unverified' });
      reasons.push({ name: skill.name, reason });
      continue;
    }
    if (!reasonAllowedBySkill(parsed.skill, reason)) continue;
    const cost = estimateTokens(parsed.skill.body.length);
    if (cost > remaining) {
      active.push({ ...parsed.skill, bodyRef: skill.bodyRef, body: null, trust: 'unverified' });
      reasons.push({ name: parsed.skill.name, reason });
      continue;
    }
    remaining -= cost;
    const { body, ...header } = parsed.skill;
    active.push({
      ...header,
      bodyRef: skill.bodyRef,
      body,
      trust: skillTrust(skill.bodyRef, source, opts.trust),
    });
    reasons.push({ name: parsed.skill.name, reason });
  }
  return { active, reasons };
}

/** Re-check the reason against the same complete source whose policy and trust
 * now reach the prompt. Discovery A may not activate a B that forbids it. */
function reasonAllowedBySkill(skill: ParsedSkill, reason: ActivationReason): boolean {
  switch (reason.kind) {
    case 'always_active':
      return true;
    case 'explicit':
      return skill.user_invocable;
    case 'keyword':
      return !skill.disable_model_invocation
        && skill.auto_activate
        && skill.keywords.includes(reason.matched_keyword);
  }
}

/** A built-in is trusted for what it is. A file is trusted only for the complete
 * raw source the owner approved: front matter is live policy, so binding only
 * the body would let an agent alter `allowed_tools` or activation after review. */
function skillTrust(
  ref: SkillBodyRef,
  source: string | null,
  trust: InstructionTrustResolver,
): InstructionTrust {
  if (ref.kind === 'builtin') return 'builtin';
  if (source === null) return 'unverified';
  return trust(ref.path, source);
}

/** Extract `/skill-name` tokens from a user message. Returns kebab-case
 *  names with the leading slash stripped, in the order they appear. */
export function extractExplicitInvocations(userMessage: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(userMessage)) != null) out.push(m[1]);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
