/**
 * Skill-file parser. Thin layer over the shared
 * `core/src/utils/markdown-frontmatter.ts` — maps the canonical front-matter
 * shape onto our typed `ParsedSkill` and validates Anthropic's published
 * SKILL.md constraints.
 *
 * Aliases / compat:
 *   - `allowed-tools` ⟷ `allowed_tools`         (Claude Code uses hyphen; Hermes uses snake)
 *   - `auto_activate` ⟷ `autoActivate`           (Kinu extension)
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
} from '../utils/markdown-frontmatter';
import type { ParsedSkill, SkillParseResult, SkillSource } from './types';
import * as v from 'valibot';
import type { JsonObject, JsonValue } from '../utils/json';
import { renderThrownChain } from '../obs/index';

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
    return { ok: false, error: renderThrownChain({ cause: err }) };
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
  const nameProblem = skillNameProblem(name);
  if (nameProblem) return { ok: false, error: `front-matter \`name\` ${nameProblem}` };

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

  // Behavioral gates — Anthropic-spec fields that Kinu now honors.
  // `disable-model-invocation: true` forces `auto_activate` off regardless of
  // frontmatter (the LLM cannot trigger this skill via description match or
  // keyword fire). Explicit user invocation still works (subject to
  // user_invocable).
  // Only a real boolean opts in or out. A quoted "false" is a non-empty
  // string, so Boolean() reads it as true.
  const disable_model_invocation =
    (fm['disable-model-invocation'] ?? fm.disable_model_invocation ?? false) === true;
  // `user-invocable: false` blocks `/skill-name` from the user's message.
  // Default true (matches Anthropic spec).
  const user_invocable =
    fm['user-invocable'] !== undefined ? fm['user-invocable'] !== false
    : fm.user_invocable !== undefined  ? fm.user_invocable !== false
    : true;
  // auto_activate is the Kinu-only keyword-fire flag. We force it false
  // when the author asked us not to model-invoke — the two contradict
  // otherwise.
  const auto_activate_raw = (fm.auto_activate ?? fm.autoActivate ?? false) === true;
  const auto_activate = disable_model_invocation ? false : auto_activate_raw;

  const known = new Set([
    'name', 'description', 'allowed-tools', 'allowed_tools',
    'keywords', 'auto_activate', 'autoActivate',
    'disable-model-invocation', 'disable_model_invocation',
    'user-invocable', 'user_invocable',
  ]);
  const ext: JsonObject = {};
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
  const fm: JsonObject = {
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

/** Why `name` is not a legal skill name, or null when it is.
 *
 *  The one authority for the Anthropic-spec name rules: the parser and
 *  discovery — which reads a name off a filename stem before it will spend
 *  anything on that file — both ask this, so a name cannot be legal to one
 *  and illegal to the other. */
export function skillNameProblem(name: string): string | null {
  if (name.length === 0) return 'must be a non-empty string';
  if (name.length > NAME_MAX_LEN) return `exceeds ${NAME_MAX_LEN} characters (${name.length})`;
  if (!NAME_RE.test(name)) {
    return `must be kebab-case (${NAME_RE.source}); got ${JSON.stringify(name)}`;
  }
  const lc = name.toLowerCase();
  for (const reserved of RESERVED_WORDS) {
    if (lc.includes(reserved)) {
      return `contains reserved word "${reserved}" (Anthropic SKILL.md spec)`;
    }
  }
  return null;
}

// ── helpers ──────────────────────────────────────────────────────

function asString(value: JsonValue | undefined): string {
  const parsed = v.safeParse(v.string(), value);
  return parsed.success ? parsed.output : value == null ? '' : String(value);
}

/**
 * Our own skills (and Hermes's) write `allowed-tools`/`keywords` as a YAML
 * list. The Agent Skills spec (agentskills.io) writes `allowed-tools` as ONE
 * space-separated scalar string — `Bash(git:*) Read` is two tools, not one.
 * Treating the whole string as a single pattern (the bug this replaces)
 * produces a pattern that matches nothing, so a spec-conformant skill that
 * restricts the surface at all collapses it to nothing: every real tool name
 * fails to match the one bogus giant pattern. Splitting on whitespace handles
 * both dialects with one rule, since our own values never contain spaces.
 */
function asStringArray(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const parsed = v.safeParse(v.string(), value);
  if (parsed.success && parsed.output.trim()) return parsed.output.trim().split(/\s+/).filter(Boolean);
  return [];
}
