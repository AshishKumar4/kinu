/**
 * Claude-Code / Hermes-compatible SKILL.md files at `/workspace/skills/<name>.md`.
 * An active skill's body joins the system prompt and its `allowed_tools`
 * bounds the tool surface. Unknown front-matter keys round-trip via `ext`.
 */

import type { JsonObject } from '../utils/json';
import type { InstructionTrust } from '../types/instruction-trust';

export type SkillParseResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; error: string; line?: number };

/** A skill's front matter: everything known without holding its body. */
export interface SkillHeader {
  /** kebab-case; must match the filename stem. */
  name: string;
  description: string;
  /** Glob-suffix (`workspace.*`) or exact patterns; empty means no restriction. */
  allowed_tools: string[];
  /** Case-insensitive whole-word triggers, used only when `auto_activate` is true. */
  keywords: string[];
  /** Default false: only explicit `/skill-name` activates. */
  auto_activate: boolean;
  /** When true, `keywords`/`auto_activate` are forced off; explicit invocation still works. */
  disable_model_invocation: boolean;
  /** When false, `/skill-name` in a user message cannot activate it. Default true. */
  user_invocable: boolean;
  ext: JsonObject;
  source: SkillSource;
}

/** A whole parsed SKILL.md. Discovery never produces one; it returns `DiscoveredSkill`. */
export interface ParsedSkill extends SkillHeader {
  body: string;
}

/** Where a body is and its cost in chars (front matter excluded), known without reading it. */
export type SkillBodyRef =
  | { readonly kind: 'builtin'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string; readonly chars: number };

/** Header plus body location; admission re-reads one source to derive body, policy, and trust. */
export interface DiscoveredSkill extends SkillHeader {
  bodyRef: SkillBodyRef;
}

/**
 * `body` is null when the allocation had no room; the rendered block points at
 * `bodyRef`. `trust` is settled over the exact bytes rendered, so an unfetched
 * body cannot be approved.
 */
export interface ActiveSkill extends DiscoveredSkill {
  body: string | null;
  readonly trust: InstructionTrust;
}

export function skillBodyChars(ref: SkillBodyRef): number {
  return ref.kind === 'builtin' ? ref.text.length : ref.chars;
}

/** `lines` are the paid-for entries in discovery order; `omitted` counts skills it could not name. */
export interface SkillsIndex {
  readonly lines: ReadonlyArray<string>;
  readonly omitted: number;
  /** Tokens the index charged; active bodies get the remainder. */
  readonly tokens: number;
}

export type SkillSource =
  | 'builtin'
  | 'vfs'
  /** Owner's shared Drive at /shared/skills/; shadowed by a same-named workspace skill. */
  | 'shared'
  /** Created mid-turn; same as vfs once written, tagged for the UI. */
  | 'agent';

export interface ActiveSkillSet {
  active: ActiveSkill[];
  reasons: Array<{ name: string; reason: ActivationReason }>;
}

export type ActivationReason =
  | { kind: 'explicit'; matched_token: string }
  | { kind: 'keyword'; matched_keyword: string }
  | { kind: 'always_active'; via: 'config' };

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

/** Index line for a workspace file: provenance only, no unapproved description. */
export function workspaceSkillIndexLine(name: string, source: SkillSource = 'vfs'): string {
  const origin = source === 'shared' ? 'shared drive skill' : 'workspace skill';

  return `- **${name}** (${origin}; contents are reference material until the owner approves them)`;
}
