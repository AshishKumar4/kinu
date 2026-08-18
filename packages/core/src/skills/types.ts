/**
 * Proteus skills — Claude-Code / Hermes-compatible SKILL.md files stored
 * in the agent's VFS at `/workspace/skills/<name>.md`.
 *
 * A skill is natural-language workflow instructions with a typed front-
 * matter header. When active, the body is prepended to the system prompt
 * and the agent's tool surface is intersected with `allowed_tools`.
 *
 * This is fundamentally different from a CraftedTool: a CraftedTool is
 * executable JavaScript the agent wrote and can call as `codemode.<name>`;
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
 */

import type { JsonObject } from '../utils/json';

/** Discriminated outcome of parsing a SKILL.md file. */
export type SkillParseResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; error: string; line?: number };

/** What a parsed skill carries — strictly typed front-matter + body. */
export interface ParsedSkill {
  /** kebab-case identifier; must match the filename stem. */
  name: string;
  /** One-sentence summary; surfaced to the LLM in `skills({action:'list'})`. */
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
  /** Skill body (the natural-language instructions). */
  body: string;
  /** Forward-compat: any unknown front-matter keys preserved verbatim. */
  ext: JsonObject;
  /** Where this skill came from. Used by the loader for precedence. */
  source: SkillSource;
}

export type SkillSource =
  /** Shipped with Proteus core (built-in skills). */
  | 'builtin'
  /** Discovered in the agent's VFS at /workspace/skills/. */
  | 'vfs'
  /** Authored via `skills({action:'create'})` mid-turn — same as vfs once
   *  written, but the loader tags it so the UI can distinguish. */
  | 'agent';

/** Outcome of resolving which skills are active for a given turn. */
export interface ActiveSkillSet {
  active: ParsedSkill[];
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
