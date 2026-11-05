/**
 * The two inline constructs of CommonMark the chat reads without parsing a whole answer: code spans, whose delimiter is
 * a backtick run closed by a run of the same length, and inline links, whose destination may hold balanced parentheses.
 * Read as the renderer reads them (react-markdown over micromark), so a link or a picture it draws is the one found here.
 */

/** `line` cut at its code spans: even parts are prose, odd parts are spans with their backticks. A run no run of its
 *  length closes is text. */
export function splitCodeSpans(line: string): string[] {
  const parts: string[] = [];
  let prose = 0;
  let at = 0;

  while (at < line.length) {
    const open = line.indexOf('`', at);

    if (open === -1) break;
    const run = runLength(line, open);
    const close = closingRun(line, open + run, run);

    if (close === -1) {
      at = open + run;
      continue;
    }

    parts.push(line.slice(prose, open), line.slice(open, close + run));
    prose = close + run;
    at = prose;
  }

  return [...parts, line.slice(prose)];
}

function runLength(text: string, from: number): number {
  let end = from;

  while (text[end] === '`') end += 1;

  return end - from;
}

/** Where the next backtick run of exactly `length` starts, from `from`; -1 for none. */
function closingRun(text: string, from: number, length: number): number {
  let at = text.indexOf('`', from);

  while (at !== -1) {
    const run = runLength(text, at);

    if (run === length) return at;
    at = text.indexOf('`', at + run);
  }

  return -1;
}

/** One inline link or image: where it starts and ends in the text, and its destination's span. */
export interface InlineLink {
  readonly start: number;
  readonly end: number;
  readonly destination: string;
  readonly destinationStart: number;
}

/** Each `[label](destination "title")` in `text`, or each `![alt](…)` with `image`; a destination's parentheses may nest. */
export function inlineLinks(text: string, image = false): InlineLink[] {
  const found: InlineLink[] = [];
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf(image ? '![' : '[', at);

    if (open === -1) break;
    const label = (image ? open + 1 : open);
    const link = linkAt(text, label);

    if (link === null) {
      at = label + 1;
      continue;
    }

    found.push({ start: open, ...link });
    at = link.end;
  }

  return found;
}

function linkAt(text: string, label: number): Omit<InlineLink, 'start'> | null {
  const closed = balancedEnd(text, label, '[', ']');

  if (closed === -1 || text[closed + 1] !== '(') return null;
  let at = skipSpaces(text, closed + 2);
  const destination = destinationAt(text, at);

  if (destination === null) return null;
  at = skipSpaces(text, destination.end);
  const title = titleEnd(text, at);

  if (title !== at) at = skipSpaces(text, title);

  return text[at] === ')' ? { end: at + 1, destination: destination.value, destinationStart: destination.start } : null;
}

/** The index of the `close` that balances the `open` at `from`, honouring backslash escapes; -1 for none on the line. */
function balancedEnd(text: string, from: number, open: string, close: string): number {
  let depth = 0;

  for (let at = from; at < text.length; at += 1) {
    const char = text[at];

    if (char === '\\') {
      at += 1;
      continue;
    }

    if (char === '\n') return -1;

    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return at;
  }

  return -1;
}

function skipSpaces(text: string, from: number): number {
  let at = from;

  while (text[at] === ' ' || text[at] === '\t') at += 1;

  return at;
}

/** `<…>`, or a run with no space or control character whose parentheses balance. */
function destinationAt(text: string, from: number): { readonly value: string; readonly start: number; readonly end: number } | null {
  if (text[from] === '<') {
    const close = text.indexOf('>', from);
    const value = close === -1 ? '' : text.slice(from + 1, close);

    return close === -1 || value.includes('\n') ? null : { value, start: from + 1, end: close + 1 };
  }

  let depth = 0;
  let at = from;

  for (; at < text.length; at += 1) {
    const char = text[at];

    if (char === '\\') {
      at += 1;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\n') break;

    if (char === '(') depth += 1;
    else if (char === ')' && depth-- === 0) break;
  }

  return depth > 0 ? null : { value: text.slice(from, at), start: from, end: at };
}

/** Past a `"…"`, `'…'` or `(…)` title at `from`; `from` itself where there is none. */
function titleEnd(text: string, from: number): number {
  const open = text[from];
  const close = open === '(' ? ')' : open;

  if (open !== '"' && open !== "'" && open !== '(') return from;
  const end = text.indexOf(close ?? '', from + 1);

  return end === -1 ? from : end + 1;
}
