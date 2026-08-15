/**
 * Single canonical parser for the `---\n<yaml>\n---\n<body>` shape that
 * Claude-Code skills use (packages/core/src/skills/).
 *
 * Deliberately narrow YAML subset — sufficient for that use site,
 * deterministic, zero runtime deps. Supports:
 *
 *   - flat scalars:           `key: value`
 *   - quoted strings:         `key: "value"`  /  `key: 'value'`
 *   - booleans + null:        `key: true|false|null|~`
 *   - inline arrays:          `key: [a, b, c]`
 *   - block lists:            `key:\n  - item\n  - item`
 *   - one-level nested maps:  `key:\n  child: value\n  child2: value`
 *   - line comments:          `# …` (outside strings)
 *
 * Tabs are rejected. Multi-line strings are not supported (use `\n` in
 * quoted strings). Extra/unknown keys round-trip — callers slice into
 * an `ext` bag if they want forward-compat.
 */

import * as v from 'valibot';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';

/** Successful parse: full front-matter map + body. */
export interface MarkdownDoc {
  frontmatter: JsonObject;
  body: string;
}

export interface FrontmatterParseError {
  message: string;
  line: number;       // 1-based, within the front-matter block
}

export class MarkdownFrontmatterError extends Error {
  constructor(public readonly detail: FrontmatterParseError) {
    super(`front-matter parse error at line ${detail.line}: ${detail.message}`);
    this.name = 'MarkdownFrontmatterError';
  }
}

/** Parse a markdown file with `---` front-matter. Throws on malformed FM.
 *  Returns `{ frontmatter: {}, body: src }` when no front-matter is present. */
export function parseMarkdownFrontmatter(src: string): MarkdownDoc {
  if (!src.startsWith('---')) {
    return { frontmatter: {}, body: src };
  }
  // The opening `---` must be followed by a newline (or EOF), not e.g. `--- foo`.
  if (src.length > 3 && src[3] !== '\n' && src[3] !== '\r') {
    return { frontmatter: {}, body: src };
  }
  // Find the closing fence on its own line.
  const closeMatch = src.match(/\n---\s*(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new MarkdownFrontmatterError({
      message: 'unterminated front-matter (missing closing `---`)',
      line: 1,
    });
  }
  const fmRaw = src.slice(4, closeMatch.index);              // skip "---\n"
  const body = src.slice(closeMatch.index + closeMatch[0].length);
  return { frontmatter: parseFlatYaml(fmRaw), body };
}

/** Stringify a front-matter map back to the `---\n…\n---\n` form. Round-
 *  trips everything `parseMarkdownFrontmatter` can read. */
export function stringifyMarkdownFrontmatter(
  doc: MarkdownDoc,
): string {
  const fm = doc.frontmatter;
  if (Object.keys(fm).length === 0) return doc.body;
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(...renderEntry(k, v, 0));
  }
  lines.push('---', '');
  return lines.join('\n') + doc.body;
}

// ── implementation ───────────────────────────────────────────────

function parseFlatYaml(src: string): JsonObject {
  const lines = src.split('\n');
  const out: JsonObject = {};
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const stripped = stripComment(raw);
    if (stripped.trim() === '') { i++; continue; }
    if (stripped.includes('\t')) {
      throw new MarkdownFrontmatterError({ message: 'tabs not allowed (use spaces)', line: i + 1 });
    }
    const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      throw new MarkdownFrontmatterError({
        message: `expected \`key: value\`, got ${JSON.stringify(raw)}`,
        line: i + 1,
      });
    }
    const key = m[1];
    const inlineRest = m[2];

    if (inlineRest !== '') {
      out[key] = parseScalar(inlineRest);
      i++;
      continue;
    }

    // Block form — look at the next non-blank line's first non-space char to
    // disambiguate list (`- item`) from nested map (`childKey: ...`).
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

    // Nested map.
    const nested: JsonObject = {};
    i++;
    while (i < lines.length) {
      const next = stripComment(lines[i]);
      if (next.trim() === '') { i++; continue; }
      const childMatch = next.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!childMatch) break;
      // Require at least 2-space indent — anything less is a top-level row.
      if (childMatch[1].length < 2) break;
      nested[childMatch[2]] = parseScalar(childMatch[3].trim());
      i++;
    }
    out[key] = nested;
  }

  return out;
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

// ── stringification ──────────────────────────────────────────────

function renderEntry(key: string, value: JsonValue, indent: number): string[] {
  const pad = '  '.repeat(indent);
  if (value === null) {
    return [`${pad}${key}: null`];
  }
  const bool = v.safeParse(v.boolean(), value);
  if (bool.success) {
    return [`${pad}${key}: ${String(bool.output)}`];
  }
  const number = v.safeParse(v.number(), value);
  if (number.success) {
    return [`${pad}${key}: ${String(number.output)}`];
  }
  const string = v.safeParse(v.string(), value);
  if (string.success) {
    return [`${pad}${key}: ${quoteIfNeeded(string.output)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    const lines: string[] = [`${pad}${key}:`];
    for (const item of value) {
      if (isJsonObject(item)) {
        lines.push(`${pad}  - ${JSON.stringify(item)}`);
      } else {
        const itemString = v.safeParse(v.string(), item);
        lines.push(`${pad}  - ${itemString.success ? quoteIfNeeded(itemString.output) : String(item)}`);
      }
    }
    return lines;
  }
  if (isJsonObject(value)) {
    const inner = Object.entries(value);
    if (inner.length === 0) return [`${pad}${key}: {}`];
    const lines: string[] = [`${pad}${key}:`];
    for (const [k, v] of inner) lines.push(...renderEntry(k, v, indent + 1));
    return lines;
  }
  return [`${pad}${key}: ${JSON.stringify(value)}`];
}

function quoteIfNeeded(s: string): string {
  if (s === '' || /[:#"'\\[\]{},]/.test(s) || /^[-?\s]/.test(s) || /\s$/.test(s) || s.includes('\n')) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return s;
}
