/**
 * Cutting text to a budget without cutting a character in half.
 *
 * A JS string is UTF-16 units and an astral character (emoji, rare CJK, most
 * symbols) is two of them, so a `slice` at an arbitrary length lands between
 * the halves as often as not. A lone surrogate is not text: it renders as a
 * replacement character, and re-encoded it is not valid UTF-8. Every budgeted
 * cut in the harness — the tool-result clamp's head and tail, the file
 * reader's one oversize line — goes through here rather than carrying its own
 * copy of the rule.
 *
 * Both return a length/offset that is never FURTHER from the budget than one
 * unit, so a caller's cap still holds.
 */

/** The cut point at or below `len` that ends a whole character. */
export function headEnd(text: string, len: number): number {
  const code = len > 0 ? text.charCodeAt(len - 1) : 0;

  return code >= 0xD800 && code <= 0xDBFF ? len - 1 : len;
}

/** The start of the last `len` units, moved forward if that split a pair. */
export function tailStart(text: string, len: number): number {
  const start = text.length - len;
  const code = text.charCodeAt(start);

  return code >= 0xDC00 && code <= 0xDFFF ? start + 1 : start;
}
