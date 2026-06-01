/**
 * Skill-file parser. Thin layer over the shared
 * `core/src/utils/markdown-frontmatter.ts` — maps the canonical front-matter
 * shape onto our typed `ParsedSkill` and validates Anthropic's published
 * SKILL.md constraints.
 *
 * Aliases / compat:
 *   - `allowed-tools` ⟷ `allowed_tools`         (Claude Code uses hyphen; Hermes uses snake)
 *   - `auto_activate` ⟷ `autoActivate`           (Proteus extension)
 *   - `disable-model-invocation` ⟷ `disable_model_invocation` (Anthropic uses hyphen)
 *   - `user-invocable` ⟷ `user_invocable`       (Anthropic uses hyphen)
 *
 * Anthropic-spec constraints we enforce:
 *   - name: ≤ 64 chars, kebab-case, no reserved words (`anthropic`, `claude`)
 *   - description: ≤ 1024 chars, non-empty, no XML tags
 *   - name in frontmatter is OPTIONAL — falls back to the caller-supplied
 *     `fallbackName` (directory name in Anthropic's spec; filename stem here).
 *     Round-trip authored-by-Claude-Code skills without a `name:` line.
 */

import {
  parseMarkdownFrontmatter,
  stringifyMarkdownFrontmatter,
  MarkdownFrontmatterError,
} from '../utils/markdown-frontmatter.js';
import type { ParsedSkill, SkillParseResult, SkillSource } from './types.js';
import { SkillError } from './types.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
/** Names containing these substrings are rejected by Anthropic's spec.
 *  Whole-substring match — `claudette` would NOT match because the spec
 *  defines whole-token reservation; we approximate with substring since
 *  the spec doesn't carve out compound names. */
const RESERVED_WORDS = ['anthropic', 'claude'];

/** Parse a SKILL.md source string → ParsedSkill (or error).
 *
 * @param fallbackName Used when frontmatter omits `name:`. Pass the file/
 *   directory stem; if both source and fallback are missing we error. */
export function parseSkillFile(
  src: string,
  source: SkillSource = 'vfs',
  fallbackName?: string,
): SkillParseResult {
  let doc;
  try { doc = parseMarkdownFrontmatter(src); }
  catch (err) {
    if (err instanceof MarkdownFrontmatterError) {
      return { ok: false, error: err.detail.message, line: err.detail.line };
    }
    return { ok: false, error: (err as Error).message };
  }

  if (Object.keys(doc.frontmatter).length === 0) {
    return { ok: false, error: 'missing front-matter (file must start with `---`)' };
  }

  const fm = doc.frontmatter;

  // name — optional, falls back to provided file/dir stem.
  let name = asString(fm.name).trim();
  if (!name && fallbackName) name = fallbackName.trim();
  if (!name) {
    return { ok: false, error: 'front-matter `name` is required when no fallback name (filename) is supplied' };
  }
  if (name.length > NAME_MAX_LEN) {
    return { ok: false, error: `front-matter \`name\` exceeds ${NAME_MAX_LEN} characters (${name.length})` };
  }
  if (!NAME_RE.test(name)) {
    return { ok: false, error: `front-matter \`name\` must be kebab-case (${NAME_RE.source}); got ${JSON.stringify(name)}` };
  }
  const lcName = name.toLowerCase();
  for (const reserved of RESERVED_WORDS) {
    if (lcName.includes(reserved)) {
      return { ok: false, error: `front-matter \`name\` contains reserved word "${reserved}" (Anthropic SKILL.md spec)` };
    }
  }

  // description — required, ≤1024 chars, no XML tags.
  const description = asString(fm.description).trim();
  if (!description) return { ok: false, error: 'front-matter `description` is required' };
  if (description.length > DESCRIPTION_MAX_LEN) {
    return { ok: false, error: `front-matter \`description\` exceeds ${DESCRIPTION_MAX_LEN} characters (${description.length})` };
  }
  if (/<[a-zA-Z][^>]*>/.test(description)) {
    return { ok: false, error: 'front-matter `description` must not contain XML tags' };
  }

  // Optional with defaults. Accept hyphen + snake variants for cross-tool compat.
  const allowed_tools = asStringArray(fm['allowed-tools'] ?? fm.allowed_tools ?? []);
  const keywords = asStringArray(fm.keywords ?? []).map(k => k.toLowerCase());

  // Behavioral gates — Anthropic-spec fields that Proteus now honors.
  // `disable-model-invocation: true` forces `auto_activate` off regardless of
  // frontmatter (the LLM cannot trigger this skill via description match or
  // keyword fire). Explicit user invocation still works (subject to
  // user_invocable).
  const disable_model_invocation =
    Boolean(fm['disable-model-invocation'] ?? fm.disable_model_invocation ?? false);
  // `user-invocable: false` blocks `/skill-name` from the user's message.
  // Default true (matches Anthropic spec).
  const user_invocable =
    fm['user-invocable'] !== undefined ? Boolean(fm['user-invocable'])
    : fm.user_invocable !== undefined  ? Boolean(fm.user_invocable)
    : true;
  // auto_activate is the Proteus-only keyword-fire flag. We force it false
  // when the author asked us not to model-invoke — the two contradict
  // otherwise.
  const auto_activate_raw = Boolean(fm.auto_activate ?? fm.autoActivate ?? false);
  const auto_activate = disable_model_invocation ? false : auto_activate_raw;

  const known = new Set([
    'name', 'description', 'allowed-tools', 'allowed_tools',
    'keywords', 'auto_activate', 'autoActivate',
    'disable-model-invocation', 'disable_model_invocation',
    'user-invocable', 'user_invocable',
  ]);
  const ext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!known.has(k)) ext[k] = v;

  return {
    ok: true,
    skill: {
      name, description, allowed_tools, keywords, auto_activate,
      disable_model_invocation, user_invocable,
      body: doc.body, ext, source,
    },
  };
}

/** Serialize a ParsedSkill back to a SKILL.md string. Round-trippable. */
export function stringifySkillFile(skill: ParsedSkill): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.allowed_tools.length > 0) fm['allowed-tools'] = skill.allowed_tools;
  if (skill.keywords.length > 0) fm.keywords = skill.keywords;
  if (skill.auto_activate) fm.auto_activate = true;
  if (skill.disable_model_invocation) fm['disable-model-invocation'] = true;
  if (!skill.user_invocable) fm['user-invocable'] = false;
  for (const [k, v] of Object.entries(skill.ext)) fm[k] = v;
  return stringifyMarkdownFrontmatter({ frontmatter: fm, body: skill.body });
}

/** Validation used by `skills({action: 'create'|'edit'})` before write.
 *  Enforces the same Anthropic-spec constraints the parser does. */
export function validateSkillName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new SkillError('invalid_name', 'name must be a non-empty string');
  }
  if (name.length > NAME_MAX_LEN) {
    throw new SkillError('invalid_name', `name exceeds ${NAME_MAX_LEN} characters`);
  }
  if (!NAME_RE.test(name)) {
    throw new SkillError('invalid_name',
      `name must be kebab-case (${NAME_RE.source}); got ${JSON.stringify(name)}`);
  }
  const lc = name.toLowerCase();
  for (const reserved of RESERVED_WORDS) {
    if (lc.includes(reserved)) {
      throw new SkillError('invalid_name',
        `name contains reserved word "${reserved}" (Anthropic SKILL.md spec)`);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}
