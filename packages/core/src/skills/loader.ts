/**
 * Resolve which skills are active for a given turn.
 *
 * Three activation paths:
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
 */

import type { ParsedSkill, ActiveSkillSet, ActivationReason } from './types';

export interface LoadActiveSkillsOpts {
  /** Every skill the agent can see (built-ins + VFS). */
  available: ReadonlyArray<ParsedSkill>;
  /** Skill names explicitly invoked this turn via `/name` in the user
   *  message (extractExplicitInvocations). */
  explicit: ReadonlyArray<string>;
  /** The user's plain-text message for keyword matching. */
  userMessage: string;
  /** Skills the operator has pinned via `agent_config.always_active_skills`. */
  alwaysActive: ReadonlyArray<string>;
}

export function resolveActiveSkills(opts: LoadActiveSkillsOpts): ActiveSkillSet {
  const byName = new Map<string, ParsedSkill>();
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

  const active = Array.from(reasons.keys()).map((n) => byName.get(n)!).filter(Boolean);
  const reasonList = Array.from(reasons.entries()).map(([name, reason]) => ({ name, reason }));
  return { active, reasons: reasonList };
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
