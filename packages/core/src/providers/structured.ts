import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { parseJsonArray, parseJsonObject, type JsonObject, type JsonValue } from '../utils/json';

export interface MarkdownFencedBlock {
  readonly tag: string | null;
  readonly code: string;
}

const INLINE_JSON_FENCE = /```json\s*([\s\S]*?)```/i;

/** A fence line (CommonMark 4.5): its indentation, its run of three or more backticks or tildes, and the rest. */
const FENCE_LINE = /^([ \t]*)(`{3,}|~{3,})(.*)$/u;

/** A fence opened at the end of a line of text, as a head report renders its evidence (`Evidence [artifact]: ```js`)
 *  and models write one: CommonMark reads none there, so it opens only on a bare language word. */
const TRAILING_FENCE = /[^`~](`{3,}|~{3,})([\w+#.-]*)[ \t]*$/u;

interface OpenFence {
  readonly fence: string;
  readonly indent: number;
  readonly tag: string | null;
  readonly lines: string[];
}

/** The fence `line` opens, or null for a line that opens none. */
function fenceOpening(line: string): OpenFence | null {
  const fence = FENCE_LINE.exec(line);

  if (fence !== null) {
    const run = fence[2] ?? '';
    const rest = fence[3] ?? '';

    // A backtick fence's info string holds no backtick: one that does is inline code, not a fence.
    if (run.startsWith('`') && rest.includes('`')) return null;

    return { fence: run, indent: fence[1]?.length ?? 0, tag: rest.trim().split(/\s+/u)[0]?.toLowerCase() || null, lines: [] };
  }

  const trailing = TRAILING_FENCE.exec(line);

  return trailing === null ? null : { fence: trailing[1] ?? '', indent: 0, tag: trailing[2]?.toLowerCase() || null, lines: [] };
}

/** Whether `line` closes `open`: its own fence character, at least as long, nothing after it, and at most three columns in
 *  from its opener's, so a deeper one is a line of the code. */
function closesFence(open: OpenFence, line: string): boolean {
  const fence = FENCE_LINE.exec(line);
  const run = fence?.[2] ?? '';

  return fence !== null && run[0] === open.fence[0] && run.length >= open.fence.length && (fence[3] ?? '').trim() === ''
    && (fence[1]?.length ?? 0) <= open.indent + 3;
}

/**
 * Each closed fenced block, read line by line as CommonMark reads one: it ends only at a line of its own fence character,
 * at least as long and with nothing after it, so a fence in the code's own text, a longer outer fence or a tilde fence
 * reads as written. An unclosed fence is no block.
 */
export function markdownFencedBlocks(text: string): MarkdownFencedBlock[] {
  const blocks: MarkdownFencedBlock[] = [];
  let open: OpenFence | null = null;

  for (const line of text.split(/\r?\n/u)) {
    if (open === null) {
      open = fenceOpening(line);
    } else if (closesFence(open, line)) {
      blocks.push({ tag: open.tag, code: open.lines.join('\n').trim() });
      open = null;
    } else {
      // The fence's own indentation is stripped from each line, as far as the line has it.
      open.lines.push(line.slice(Math.min(open.indent, line.length - line.trimStart().length)));
    }
  }

  return blocks;
}

export function jsonObjectOnlyInstruction(): string {
  return 'Return a single minified JSON object, with no markdown fences or prose.';
}

export function jsonArrayOnlyInstruction(): string {
  return 'Return a single minified JSON array, with no markdown fences or prose.';
}

export function extractJsonObject(text: string): JsonObject {
  return settleSync(Effect.map(balancedJson(text, '{', '}'), parseJsonObject));
}

export function extractJsonArray(text: string): JsonValue[] {
  return settleSync(Effect.map(balancedJson(text, '[', ']'), parseJsonArray));
}

function balancedJson(text: string, open: '{' | '[', close: '}' | ']'): Effect.Effect<string> {
  // A JSON block on lines of its own, else the inline envelope a model may write on one (```json{...}```).
  const inner = markdownFencedBlocks(text).find((block) => block.tag === 'json')?.code ?? text.match(INLINE_JSON_FENCE)?.[1] ?? '';
  const src = inner.includes(open) ? inner : text;
  const start = src.indexOf(open);

  if (start === -1) return Effect.die(new SyntaxError(`no JSON ${open === '{' ? 'object' : 'array'} in model output`));

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return Effect.succeed(src.slice(start, i + 1));
  }

  return Effect.die(new SyntaxError(`unterminated JSON ${open === '{' ? 'object' : 'array'} in model output`));
}

