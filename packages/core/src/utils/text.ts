/**
 * Cutting text to a budget without cutting a character in half.
 *
 * An astral character (emoji, rare CJK) is two UTF-16 units, so a `slice` at
 * an arbitrary length can land between them and hand back a half. Only a real
 * pair is protected: a lone surrogate already in the text is data, and moving
 * the cut to drop one would change what the caller stored.
 *
 * Both move the cut by at most one unit, and never outward, so a caller's cap
 * still holds.
 */

const isHigh = (code: number): boolean => code >= 0xD800 && code <= 0xDBFF;

const isLow = (code: number): boolean => code >= 0xDC00 && code <= 0xDFFF;

/** The cut point at or below `len` that does not split a pair. */
export function headEnd(text: string, len: number): number {
  const splitsPair = len > 0 && len < text.length
    && isHigh(text.charCodeAt(len - 1)) && isLow(text.charCodeAt(len));

  return splitsPair ? len - 1 : len;
}

/** The start of the last `len` units, moved forward only if that split a pair. */
export function tailStart(text: string, len: number): number {
  const start = text.length - len;

  const splitsPair = start > 0 && start < text.length
    && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1));

  return splitsPair ? start + 1 : start;
}
