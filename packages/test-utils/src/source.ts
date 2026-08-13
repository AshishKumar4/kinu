/**
 * Source-reading assertions, made non-vacuous.
 *
 * Several suites assert wiring by reading source, because the seam under test
 * has no runtime harness in this repo. Their failure mode is silent: when a
 * refactor renames an anchor, `indexOf` returns -1, `slice(start, -1)` runs to
 * end-of-file, and the assertion then passes against the whole file instead of
 * the member it named. Three tests were live in that state — one guarding a
 * call that appears six times elsewhere in its file, so the call could be
 * deleted outright with the test still green.
 *
 * Every anchor here is required. A rename fails the test that depends on it,
 * which is the point of writing the test against source in the first place.
 */

/** Offset of `needle`, or throw naming what went missing. */
export function anchor(source: string, needle: string, label = 'source'): number {
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`anchor not found in ${label}: ${JSON.stringify(needle)}`);
  return at;
}

/** The region from the start of `from` to the start of `to`. Both required. */
export function between(source: string, from: string, to: string, label = 'source'): string {
  const start = anchor(source, from, label);
  const end = source.indexOf(to, start);
  if (end === -1) throw new Error(`closing anchor not found in ${label} after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** Index of the quote closing the literal that opens at `at`. */
function endOfString(src: string, at: number): number {
  const quote = src[at]!;
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') { i++; continue; }
    if (c === quote) return i;
    if (quote === '`' && c === '$' && src[i + 1] === '{') i = endOfTemplateExpr(src, i + 2);
  }
  throw new Error('unterminated string literal');
}

/** Index of the `}` closing a `${` interpolation opened at `at`. */
function endOfTemplateExpr(src: string, at: number): number {
  let depth = 1;
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') { i = endOfString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unterminated template expression');
}

/**
 * The body of the member declared at `declaration`, by brace matching.
 *
 * Anchored on the member itself and never on whatever follows it — a trailing
 * marker is exactly what drifted in all three vacuous tests. `declaration` must
 * reach its closing paren (e.g. `'async onStart()'`) so the first `{` found is
 * the body and not a parameter's object type. Strings, template
 * interpolations, and comments are skipped, so braces inside them do not
 * unbalance the scan.
 */
export function memberBody(source: string, declaration: string, label = 'source'): string {
  const start = anchor(source, declaration, label);
  const open = source.indexOf('{', start);
  if (open === -1) throw new Error(`no block after ${JSON.stringify(declaration)} in ${label}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { i = endOfString(source, i); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${JSON.stringify(declaration)} in ${label}`);
}
