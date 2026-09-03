/**
 * Kinu skills — Claude-Code / Hermes-compatible SKILL.md files stored
 * in the agent's VFS at `/workspace/skills/<name>.md`.
 *
 * A skill is natural-language workflow instructions with a typed front-
 * matter header. When active, the body is prepended to the system prompt
 * and the agent's tool surface is intersected with `allowed_tools`.
 *
 * This is fundamentally different from a CraftedTool: a CraftedTool is
 * executable JavaScript the agent wrote and can call as `tools.<name>`;
 * a Skill is a prompt fragment + tool gate. The two coexist.
 *
 * Format (round-trippable with Anthropic Claude Code):
 *
 *   ---
 *   name: refactor-large-file
 *   description: Split a big file into focused modules without losing tests.
 *   allowed-tools:
 *     - workspace.readFile
 *     - workspace.writeFile
 *     - sandbox.exec
 *     - memory
 *   keywords: [refactor, split, modularize]
 *   auto_activate: false
 *   ---
 *
 *   # Refactor Large File
 *
 *   Step-by-step instructions for the LLM…
 *
 * Unknown front-matter keys are preserved in `ext` so future fields don't
 * round-trip-corrupt skills authored by newer tools.
 *
 * A body is the expensive part of a skill and the only part a turn may not be
 * able to afford, so the types keep it separate from the front matter: see
 * `SkillHeader` (what discovery holds), `ParsedSkill` (a whole file),
 * `DiscoveredSkill` (a header plus where its body is), and `ActiveSkill` (a
 * header plus the body the admission actually paid for).
 */

import type { JsonObject } from '../utils/json';
import type { InstructionTrust } from '../types/instruction-trust';

/** Discriminated outcome of parsing a SKILL.md file. */
export type SkillParseResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; error: string; line?: number };

/** A skill's front matter — everything discovery learns about a skill without
 *  holding its body. The ambient index renders from this and activation decides
 *  from it, which is why neither needs a body. */
export interface SkillHeader {
  /** kebab-case identifier; must match the filename stem. */
  name: string;
  /** One-sentence summary; the ambient skills index is this plus the name. */
  description: string;
  /** Tool / namespace patterns this skill restricts the surface to.
   *  Supports glob-suffix (`workspace.*`) and exact (`sandbox.exec`).
   *  Empty array = no restriction (uses full current surface). */
  allowed_tools: string[];
  /** Keywords that auto-activate this skill when matched in the user
   *  message AND `auto_activate` is true. Case-insensitive whole-word. */
  keywords: string[];
  /** Whether keyword match triggers auto-activation. Default false:
   *  explicit `/skill-name` invocation is the only path. */
  auto_activate: boolean;
  /** Anthropic Claude Code SKILL.md field. When true, the LLM cannot
   *  auto-invoke this skill via description match — i.e., `keywords` +
   *  `auto_activate` are also forced off for this skill regardless of
   *  what the frontmatter says. Default false. Explicit invocation
   *  still works. */
  disable_model_invocation: boolean;
  /** Anthropic Claude Code SKILL.md field. When false, the user
   *  cannot invoke this skill via `/skill-name` in their message —
   *  only the LLM (subject to `disable_model_invocation`) or the
   *  operator (via always-active pin) can activate it. Default true. */
  user_invocable: boolean;
  /** Forward-compat: any unknown front-matter keys preserved verbatim. */
  ext: JsonObject;
  /** Where this skill came from. Used by the loader for precedence. */
  source: SkillSource;
}

/** A parsed SKILL.md — its header and the body that came with it. Produced by
 *  `parseSkillFile`, never by discovery: a header whose `body` is sometimes the
 *  real instructions and sometimes a placeholder is an invariant no caller can
 *  trust, which is why discovery returns `DiscoveredSkill` instead. */
export interface ParsedSkill extends SkillHeader {
  /** Skill body (the natural-language instructions). */
  body: string;
}

/**
 * Where a body is, and what admitting it costs, known without holding it.
 *
 * A built-in body is a module constant that was never on disk, so admitting one
 * costs no read. A VFS body was measured when discovery parsed that file's front
 * matter — `chars` is the body's own length, front matter excluded — so the
 * admission prices exactly what the body would add to the prompt.
 */
export type SkillBodyRef =
  | { readonly kind: 'builtin'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string; readonly chars: number };

/** A skill discovery found: its header plus where the body it deliberately did
 * not hold lives. Admission re-reads one complete source and derives that
 * active skill's header, body, policy, and trust from the same snapshot. */
export interface DiscoveredSkill extends SkillHeader {
  bodyRef: SkillBodyRef;
}

/** An active skill as the turn's admission left it. `body` is null when the
 *  allocation had no room for it: those bytes were never read, and the rendered
 *  block points at `bodyRef` instead, so a deferred skill stays reachable rather
 *  than becoming a silent omission.
 *
 *  `trust` is what decides where the body renders and whether the skill's
 *  `allowed_tools` may bound the turn's tool surface. It is settled here, at the
 *  one point the body actually exists, so the digest is taken over the very
 *  bytes about to be rendered rather than over an earlier read of the file. A
 *  body the allocation never fetched cannot be digested, so it cannot be
 *  approved — which is the answer that fails closed. */
export interface ActiveSkill extends DiscoveredSkill {
  body: string | null;
  readonly trust: InstructionTrust;
}

/** What admitting this body would cost, in chars. */
export function skillBodyChars(ref: SkillBodyRef): number {
  return ref.kind === 'builtin' ? ref.text.length : ref.chars;
}

/**
 * The ambient skills index as the turn's admission left it.
 *
 * `lines` are the entry lines the allocation paid for, in discovery order,
 * rendered by the same formatter that priced them (render.ts) so what was
 * charged is what gets printed. `omitted` counts the discovered skills the
 * allocation could not even name — the section says how many and where they
 * live rather than trimming the list silently.
 */
export interface SkillsIndex {
  readonly lines: ReadonlyArray<string>;
  readonly omitted: number;
  /** Tokens the index charged. The active bodies get what it left. */
  readonly tokens: number;
}

export type SkillSource =
  /** Shipped with Kinu core (built-in skills). */
  | 'builtin'
  /** Discovered in the agent's VFS at /workspace/skills/. */
  | 'vfs'
  /** Authored via `skills({action:'create'})` mid-turn — same as vfs once
   *  written, but the loader tags it so the UI can distinguish. */
  | 'agent';

/** Outcome of resolving which skills are active for a given turn. */
export interface ActiveSkillSet {
  active: ActiveSkill[];
  /** Reasons each skill was activated. Used for audit + transparency. */
  reasons: Array<{ name: string; reason: ActivationReason }>;
}

export type ActivationReason =
  | { kind: 'explicit'; matched_token: string }
  | { kind: 'keyword'; matched_keyword: string }
  | { kind: 'always_active'; via: 'config' };

// There is no SkillsAction type anymore: skill CRUD (read/create/edit/
// delete) is ordinary workspace.readFile/writeFile/readdir/exec('rm …')
// inside execute_tools — no dispatcher takes a discriminated action union
// for it. `list`/`invoke` are gone outright: discovery is the ambient index
// (renderSkillsIndexSection), and activation is resolved once at turn start
// (resolveTurnSkills), never by a mid-turn call.

export class SkillError extends Error {
  constructor(public readonly code: SkillErrorCode, message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

export type SkillErrorCode =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_frontmatter'
  | 'duplicate'
  | 'vfs_error'
  | 'forbidden_action';

export const SKILLS_DIR = '/workspace/skills';
