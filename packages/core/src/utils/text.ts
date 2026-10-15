/** Cut text to a budget without splitting a surrogate pair; lone surrogates are data. Cuts move at most one unit, never outward. */

const isHigh = (code: number): boolean => code >= 0xD800 && code <= 0xDBFF;

const isLow = (code: number): boolean => code >= 0xDC00 && code <= 0xDFFF;

export const BOM = '\uFEFF';

/** The text a UTF-8 read returns: one leading byte-order mark is encoding metadata, not content. */
export function withoutBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

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

/** UTF-16 code-unit order: the same on every host, which `localeCompare` is not. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;

  return a > b ? 1 : 0;
}

/** A trailing newline ends the last line rather than opening an empty one; empty text spans none. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** XML's five named references. */
export const XML_ENTITIES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

/** XML's, and the non-breaking space a page writes between words, read as a space. */
export const HTML_ENTITIES: ReadonlyMap<string, string> = new Map([...XML_ENTITIES, ['nbsp', ' ']]);

/**
 * Character references decoded in one pass, so each is decoded once (`&amp;lt;` reads `&lt;`): a name in `named`, or a
 * decimal or hex code point. A code point outside Unicode, or zero, decodes to nothing; a name outside `named` stays.
 */
export function decodeEntities(value: string, named: ReadonlyMap<string, string>): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (reference: string, code: string) => {
    const lowered = code.toLowerCase();

    if (!lowered.startsWith('#')) return named.get(lowered) ?? reference;
    const point = lowered.startsWith('#x') ? Number.parseInt(lowered.slice(2), 16) : Number.parseInt(lowered.slice(1), 10);

    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
  });
}

/** `value` as UTF-8 bytes, in a buffer Web Crypto takes. */
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

/** Whitespace collapsed to single spaces and clipped to `max`, a clip marked with `...`. */
export function oneLineClip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** The length of `text` in UTF-8 bytes, the unit a row or body limit counts. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
