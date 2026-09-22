/**
 * SKILL.md parser over `utils/markdown-frontmatter.ts`. Accepts hyphen and snake
 * spellings of each field and enforces Anthropic's constraints (name ≤ 64 chars,
 * kebab-case, no reserved words; description ≤ 1024 chars, no XML tags). A missing
 * `name:` falls back to the filename stem.
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

/** Reserved by Anthropic's spec; matched as substrings. */
const RESERVED_WORDS = ['anthropic', 'claude'];

/** @param fallbackName File/directory stem used when frontmatter omits `name:`. */
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

  let name = asString(fm.name).trim();

  if (!name && fallbackName) name = fallbackName.trim();

  if (!name) {
    return { ok: false, error: 'front-matter `name` is required when no fallback name (filename) is supplied' };
  }

  const nameProblem = skillNameProblem(name);

  if (nameProblem) return { ok: false, error: `front-matter \`name\` ${nameProblem}` };

  const description = asString(fm.description).trim();

  if (!description) return { ok: false, error: 'front-matter `description` is required' };

  if (description.length > DESCRIPTION_MAX_LEN) {
    return { ok: false, error: `front-matter \`description\` exceeds ${DESCRIPTION_MAX_LEN} characters (${description.length})` };
  }

  if (/<[a-zA-Z][^>]*>/.test(description)) {
    return { ok: false, error: 'front-matter `description` must not contain XML tags' };
  }

  const allowed_tools = asStringArray(fm['allowed-tools'] ?? fm.allowed_tools ?? []);
  const keywords = asStringArray(fm.keywords ?? []).map(k => k.toLowerCase());

  // Only a real boolean opts in or out: a quoted "false" is truthy.
  const disable_model_invocation =
    (fm['disable-model-invocation'] ?? fm.disable_model_invocation ?? false) === true;

  const user_invocable = userInvocable(fm);

  // `disable_model_invocation` forces `auto_activate` off.
  const auto_activate_raw = (fm.auto_activate ?? fm.autoActivate ?? false) === true;
  const auto_activate = disable_model_invocation ? false : auto_activate_raw;

  const known = new Set([
    'name', 'description', 'allowed-tools', 'allowed_tools',
    'keywords', 'auto_activate', 'autoActivate',
    'disable-model-invocation', 'disable_model_invocation',
    'user-invocable', 'user_invocable',
  ]);

  const ext: JsonObject = {};

  for (const [key, value] of Object.entries(fm)) if (!known.has(key)) ext[key] = value;

  return {
    ok: true,
    skill: {
      name, description, allowed_tools, keywords, auto_activate,
      disable_model_invocation, user_invocable,
      body: doc.body, ext, source,
    },
  };
}

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

  for (const [key, value] of Object.entries(skill.ext)) fm[key] = value;

  return stringifyMarkdownFrontmatter({ frontmatter: fm, body: skill.body });
}

/** Why `name` is not a legal skill name, or null. Shared by the parser and discovery. */
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

function userInvocable(fm: JsonObject): boolean {
  if (fm['user-invocable'] !== undefined) return fm['user-invocable'] !== false;

  if (fm.user_invocable !== undefined) return fm.user_invocable !== false;

  return true;
}

/** A mapping or list states no text, so it reads as absent rather than `[object Object]`. */
function asString(value: JsonValue | undefined): string {
  const text = v.safeParse(v.string(), value);

  if (text.success) return text.output;
  const scalar = v.safeParse(v.union([v.number(), v.boolean()]), value);

  return scalar.success ? String(scalar.output) : '';
}

/** Accepts a YAML list or the Agent Skills spec's space-separated string (`Bash(git:*) Read`). */
function asStringArray(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean);
  const parsed = v.safeParse(v.string(), value);

  if (parsed.success && parsed.output.trim()) return parsed.output.trim().split(/\s+/).filter(Boolean);

  return [];
}
