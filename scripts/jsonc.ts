/**
 * Reading `wrangler.jsonc`, which is JSONC and which `JSON.parse` cannot read.
 *
 * This lived inside `tracing-gate.ts` while it had one caller. It now has two —
 * the tracing gate and the infrastructure manifest — and a second copy of a
 * hand-written comment stripper is the exact shape this repository's gates keep
 * catching: two parsers, two answers to "what does the config say", and nothing
 * comparing them.
 */

import * as v from 'valibot';

/**
 * wrangler's own JSONC parser is not exported, so this is a single string-aware
 * pass. String-aware rather than regex, because the regex version was wrong in a
 * way that mattered:
 *
 *   - `packages/cf-backend/wrangler.jsonc` ends its `vars` block with a TRAILING
 *     COMMA whose following entries are all comments, so stripping comments alone
 *     leaves `…,\n}` and `JSON.parse` throws. A gate that dies on its own config
 *     is at least loud, but it is still a gate that never ran.
 *   - A `//` inside a string value is not a comment (`"https://…"` appears three
 *     times in that file), and a `,` inside a string followed by a brace is not a
 *     trailing comma.
 *
 * The caller's `schema` decides what the result must be, applied here at the one
 * boundary where the file's shape is still open, so nothing downstream has to
 * re-narrow it.
 */
export function parseJsonc<TSchema extends v.GenericSchema>(
  source: string,
  schema: TSchema,
  label: string,
): v.InferOutput<TSchema> {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? '';
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    out += char;
  }
  // Trailing commas, now that no comment can hide one. Repeated because
  // `[1,2,,]`-shaped nesting can leave a second one behind after the first pass.
  let previous = '';
  let trimmed = out;
  while (trimmed !== previous) {
    previous = trimmed;
    trimmed = trimmed.replace(/,(\s*[}\]])/gu, '$1');
  }
  const parsed = v.safeParse(schema, JSON.parse(trimmed));
  if (!parsed.success) throw new Error(`${label}: ${v.summarize(parsed.issues)}`);
  return parsed.output;
}
