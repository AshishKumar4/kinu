/** Cut text to a budget without splitting a surrogate pair; lone surrogates are data. Cuts move at most one unit, never outward. */

const isHigh = (code: number): boolean => code >= 0xD800 && code <= 0xDBFF;

const isLow = (code: number): boolean => code >= 0xDC00 && code <= 0xDFFF;

export function headEnd(text: string, len: number): number {
  const splitsPair = len > 0 && len < text.length
    && isHigh(text.charCodeAt(len - 1)) && isLow(text.charCodeAt(len));

  return splitsPair ? len - 1 : len;
}

export function tailStart(text: string, len: number): number {
  const start = text.length - len;

  const splitsPair = start > 0 && start < text.length
    && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1));

  return splitsPair ? start + 1 : start;
}

/** A trailing newline ends the last line rather than opening an empty one; empty text spans none. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
