/** Third-party text shown as a quotation (an MCP server's prose, an approval's command) reads as what it is. */

/** C0 but tab, LF and CR; DEL, C1, soft hyphen; Arabic letter mark; marks, zero-width, bidi, joiners; BOM. */
const MISREPRESENTING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];

const MISREPRESENTING = new RegExp(
  `[${MISREPRESENTING_RANGES.map(([lo, hi]) =>
    lo === hi
      ? `\\u{${lo.toString(16)}}`
      : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`).join('')}]`,
  'gu',
);

/** Each becomes a visible U+FFFD. */
export function revealMisrepresenting(text: string): string {
  return text.replace(MISREPRESENTING, '\uFFFD');
}

const TAG_OPENER = /<(?=[a-zA-Z/!?])/g;

const HEADING_MARKER = /^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/gm;

const THEMATIC_BREAK = /^([ \t]{0,3})([-*_])((?:[ \t]*\2){2,}[ \t]*)$/gm;

const TILDES = /~+/g;

/** Also HTML tags, headings, rules and strikethrough become inert text. */
export function quoteUntrusted(text: string): string {
  return revealMisrepresenting(text)
    .replace(TAG_OPENER, '&lt;')
    .replace(HEADING_MARKER, (_match, indent: string, marks: string) => `${indent}${marks.replace(/#/g, '\\#')}`)
    .replace(THEMATIC_BREAK, (_match, indent: string, mark: string, rest: string) => `${indent}\\${mark}${rest}`)
    .replace(TILDES, (run) => run.replace(/~/g, '\\~'));
}
