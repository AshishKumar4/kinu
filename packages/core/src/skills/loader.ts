import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Which skills are active for a turn, and which the turn can afford.
 *
 * Activation, highest precedence first: explicit `/skill-name` in the user's message, operator pin
 * (`always_active_skills`). Nothing else loads a body into the prompt: the model reads any other
 * skill from `/skills`, so ordinary words in a message never change the system prompt.
 *
 * Admission spends the turn's `stepContextLimit` allocation: the ambient index
 * first, then bodies in activation priority. An unadmitted body keeps its header
 * and a pointer; unnamed index entries are counted in the trailer.
 */

import { estimateTokens } from '../token-estimate';
import { Effect, Result } from 'effect';
import { attempt, diagnostics, settle } from '../obs/index';
import {
  readSkillFile, compareSkillNames,
  type SkillsDiscovery,
} from './discover';
import { parseSkillFile } from './parse';
import { skillIndexLine, unreadSkillLine } from './render';
import {
  type ActivationReason, type ActiveSkill, type ActiveSkillSet,
  type DiscoveredSkill, type ParsedSkill, type SkillBodyRef, type SkillsIndex,
  workspaceSkillIndexLine,
} from './types';
import type {
  InstructionTrust, InstructionTrustResolver,
} from '../types/instruction-trust';

export interface LoadActiveSkillsOpts {
  available: ReadonlyArray<DiscoveredSkill>;
  /** Names invoked via `/name` in the user message. */
  explicit: ReadonlyArray<string>;
  alwaysActive: ReadonlyArray<string>;
}

export interface ActivatedSkill {
  skill: DiscoveredSkill;
  reason: ActivationReason;
}

/** Admission spend order; must be total because it decides whose instructions survive. */
const REASON_PRIORITY = {
  explicit: 0,
  always_active: 1,
  // `satisfies` keeps exhaustiveness without widening entries to `number`.
} satisfies Record<ActivationReason['kind'], number>;

export function resolveActiveSkills(opts: LoadActiveSkillsOpts): ActivatedSkill[] {
  const byName = new Map<string, DiscoveredSkill>();

  for (const s of opts.available) byName.set(s.name, s);

  const reasons = new Map<string, ActivationReason>();

  for (const name of opts.alwaysActive) {
    if (byName.has(name) && !reasons.has(name)) {
      reasons.set(name, { kind: 'always_active', via: 'config' });
    }
  }

  // `user_invocable=false` ignores `/skill-name`. A pinned skill stays pinned: its body is already in the system
  // prompt, and an explicit reason would move it to the turn's opening message (splitTurnSkills).
  for (const name of opts.explicit) {
    const skill = byName.get(name);

    if (!skill || !skill.user_invocable || reasons.has(name)) continue;
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

/** Charge the ambient index; entries are priced as printed, in name order. */
export function admitSkillsIndex(
  discovery: SkillsDiscovery,
  admissionTokens: number,
): SkillsIndex {
  const priced = [
    ...discovery.skills.map((skill) => skill.bodyRef.kind === 'builtin'
      ? skillIndexLine(skill)
      : workspaceSkillIndexLine(skill.name, skill.source)),
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

  return { lines, omitted: priced.length - lines.length + (discovery.omitted ?? 0), tokens };
}


/**
 * Read the bodies the allocation can pay for, in activation priority order;
 * the rest stay with `body: null`. Trust is settled over the exact bytes read:
 * built-ins are trusted, files only if the owner approved these bytes at this path.
 */
export function admitActiveSkills(opts: {
  vfs: VFS;
  activated: ReadonlyArray<ActivatedSkill>;
  admissionTokens: number;
  trust: InstructionTrustResolver;
}): Promise<ActiveSkillSet> {
  return settle(Effect.gen(function* () {
    let remaining = Math.max(0, opts.admissionTokens);
    const active: ActiveSkill[] = [];
    const reasons: Array<{ name: string; reason: ActivationReason }> = [];

    for (const { skill, reason } of opts.activated) {
      // An unreadable body defers only its own skill.
      const read = yield* Effect.result(attempt({ doing: 'admit a skill body', otherwise: 'io' }, async (): Promise<string | null> => {
        // Stat first so a replacement that grew past the remaining allocation stays a pointer.
        if (skill.bodyRef.kind === 'file') {
          const stat = await opts.vfs.stat(skill.bodyRef.path);
          const declared = stat === null ? skill.bodyRef.chars : stat.size;

          if (estimateTokens(declared) > remaining) return null;
        }

        return readSkillFile(opts.vfs, skill.bodyRef, remaining);
      }));

      if (Result.isFailure(read)) diagnostics.failure('skills.admission_failed', read.failure, { skill: skill.name });

      if (Result.isFailure(read) || read.success === null) {
        active.push({ ...skill, body: null, trust: 'unverified' });
        reasons.push({ name: skill.name, reason });
        continue;
      }

      const source = read.success;

      if (skill.bodyRef.kind === 'builtin') {
        const cost = estimateTokens(source.length);

        if (cost > remaining) {
          // Body admission is a budget decision; the built-in's policy still narrows the tool surface.
          active.push({ ...skill, body: null, trust: 'builtin' });
        } else {
          remaining -= cost;
          active.push({ ...skill, body: source, trust: 'builtin' });
        }

        reasons.push({ name: skill.name, reason });
        continue;
      }

      // Policy, body, budget, and trust derive from this one read, so policy cannot be swapped between reads.
      const parsed = parseSkillFile(source, 'vfs', skill.name);

      if (Result.isFailure(parsed) || parsed.success.name !== skill.name) {
        active.push({ ...skill, body: null, trust: 'unverified' });
        reasons.push({ name: skill.name, reason });
        continue;
      }

      if (!reasonAllowedBySkill(parsed.success, reason)) continue;
      const cost = estimateTokens(parsed.success.body.length);

      if (cost > remaining) {
        active.push({ ...parsed.success, bodyRef: skill.bodyRef, body: null, trust: 'unverified' });
        reasons.push({ name: parsed.success.name, reason });
        continue;
      }

      remaining -= cost;
      const { body, ...header } = parsed.success;
      active.push({
        ...header,
        bodyRef: skill.bodyRef,
        body,
        trust: skillTrust(skill.bodyRef, source, opts.trust),
      });
      reasons.push({ name: parsed.success.name, reason });
    }

    return { active, reasons };
  }));
}

/** Re-check the activation reason against the same source whose policy reaches the prompt. */
function reasonAllowedBySkill(skill: ParsedSkill, reason: ActivationReason): boolean {
  return reason.kind === 'always_active' || skill.user_invocable;
}

/** A file is trusted only for the complete raw source the owner approved, front matter included. */
function skillTrust(
  ref: SkillBodyRef,
  source: string | null,
  trust: InstructionTrustResolver,
): InstructionTrust {
  if (ref.kind === 'builtin') return 'builtin';

  if (source === null) return 'unverified';

  return trust(ref.path, source);
}

/** `/skill-name` tokens from a user message, slash stripped, in order. */
export function extractExplicitInvocations(userMessage: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(userMessage)) != null) out.push(m[1]);

  return out;
}
