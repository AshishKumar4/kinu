/**
 * Front-matter parser for skills: a narrow YAML subset (scalars, quoted strings,
 * inline/block lists, one-level maps, `#` comments). Tabs and multi-line strings are rejected.
 */

import { Cause, Data, Effect } from 'effect';
import { settleSync } from '../obs/effect';
import type { JsonObject, JsonValue } from './json';

export interface MarkdownDoc {
  frontmatter: JsonObject;
  body: string;
}

export interface FrontmatterParseError {
  message: string;
  line: number;       // 1-based, within the front-matter block
}

export class MarkdownFrontmatterError extends Data.TaggedError('MarkdownFrontmatterError')<{ readonly message: string }> {
  constructor(public readonly detail: FrontmatterParseError) {
    super({ message: `front-matter parse error at line ${detail.line}: ${detail.message}` });
  }
}

/** Throws on malformed front-matter; returns the whole source as body when there is none. */
export function parseMarkdownFrontmatter(src: string): MarkdownDoc {
  return settleSync(frontmatterDoc(src));
}

/** `parseMarkdownFrontmatter`, answering null for malformed front-matter instead of throwing it. */
export function readMarkdownFrontmatter(src: string): MarkdownDoc | null {
  return settleSync(Effect.catchCause(frontmatterDoc(src), (failed) => (Cause.squash(failed) instanceof MarkdownFrontmatterError ? Effect.succeed(null) : Effect.failCause(failed))));
}

function frontmatterDoc(src: string): Effect.Effect<MarkdownDoc> {
  if (!src.startsWith('---')) {
    return Effect.succeed({ frontmatter: {}, body: src });
  }

  if (src.length > 3 && src[3] !== '\n' && src[3] !== '\r') {
    return Effect.succeed({ frontmatter: {}, body: src });
  }

  const closeMatch = src.match(/\n---\s*(\r?\n|$)/);

  if (!closeMatch || closeMatch.index === undefined) {
    return Effect.die(new MarkdownFrontmatterError({
      message: 'unterminated front-matter (missing closing `---`)',
      line: 1,
    }));
  }

  const fmRaw = src.slice(4, closeMatch.index);              // skip "---\n"
  const body = src.slice(closeMatch.index + closeMatch[0].length);

  return Effect.map(flatYaml(fmRaw), (frontmatter) => ({ frontmatter, body }));
}

function flatYaml(src: string): Effect.Effect<JsonObject> {
  return Effect.gen(function* () {
    const lines = src.split('\n');
    const out: JsonObject = {};
    let i = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const stripped = stripComment(raw);

      if (stripped.trim() === '') { i++; continue; }

      if (stripped.includes('\t')) {
        return yield* Effect.die(new MarkdownFrontmatterError({ message: 'tabs not allowed (use spaces)', line: i + 1 }));
      }

      const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);

      if (!m) {
        return yield* Effect.die(new MarkdownFrontmatterError({
          message: `expected \`key: value\`, got ${JSON.stringify(raw)}`,
          line: i + 1,
        }));
      }

      const key = m[1];
      const inlineRest = m[2];

      if (inlineRest !== '') {
        out[key] = parseScalar(inlineRest);
        i++;
        continue;
      }

      // Next non-blank line decides list (`- item`) vs nested map.
      const peek = findNextIndentedLine(lines, i + 1);

      if (peek == null) { out[key] = null; i++; continue; }

      if (peek.kind === 'list') {
        const items: JsonValue[] = [];
        i++;

        while (i < lines.length) {
          const next = stripComment(lines[i]);

          if (next.trim() === '') { i++; continue; }

          const lm = next.match(/^\s+-\s+(.*)$/);

          if (!lm) break;
          items.push(parseScalar(lm[1].trim()));
          i++;
        }

        out[key] = items;
        continue;
      }

      const nested: JsonObject = {};
      i++;

      while (i < lines.length) {
        const next = stripComment(lines[i]);

        if (next.trim() === '') { i++; continue; }

        const childMatch = next.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);

        if (!childMatch) break;

        if (childMatch[1].length < 2) break;
        nested[childMatch[2]] = parseScalar(childMatch[3].trim());
        i++;
      }

      out[key] = nested;
    }

    return out;
  });
}

interface PeekResult { kind: 'list' | 'map' }

type FrontmatterScalar = string | number | boolean | null | FrontmatterScalar[];

function findNextIndentedLine(lines: string[], from: number): PeekResult | null {
  for (let j = from; j < lines.length; j++) {
    const stripped = stripComment(lines[j]);

    if (stripped.trim() === '') continue;

    if (!stripped.startsWith(' ')) return null;        // returned to top-level
    const trimmed = stripped.trimStart();

    if (trimmed.startsWith('- ') || trimmed === '-') return { kind: 'list' };

    return { kind: 'map' };
  }

  return null;
}

function stripComment(line: string): string {
  let inS = false, inD = false;

  for (let j = 0; j < line.length; j++) {
    const c = line[j];

    if (c === '"' && !inS) inD = !inD;
    else if (c === "'" && !inD) inS = !inS;
    else if (c === '#' && !inS && !inD) return line.slice(0, j);
  }

  return line;
}

function parseScalar(s: string): FrontmatterScalar {
  const t = s.trim();

  if (t === '') return null;

  if (t === 'true') return true;

  if (t === 'false') return false;

  if (t === 'null' || t === '~') return null;

  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1)
      .replace(/\\\\/g, '\u0000')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replaceAll('\u0000', '\\');
  }

  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }

  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();

    if (!inner) return [];

    return inner.split(',').map(x => parseScalar(x.trim()));
  }

  if (/^-?\d+$/.test(t)) return Number(t);

  if (/^-?\d+\.\d+$/.test(t)) return Number(t);

  return t;
}
