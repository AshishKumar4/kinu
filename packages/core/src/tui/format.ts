import { codenameFor } from '../identity/naming';

/** Printable ASCII: one column a character, so the length is the width. */
const NARROW_ONLY = /^[\x20-\x7e]*$/;

/**
 * Two columns in a terminal, as wcwidth and the TUI renderer count them: East Asian wide and fullwidth letters, and a
 * character shown as an emoji. Approximate at the edges (ambiguous-width letters count one).
 */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]|\ufe0f|\p{Emoji_Presentation}/u;

/** A mark or a format character alone takes no column; it joins what it follows. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeColumns(grapheme: string): number {
  if (WIDE.test(grapheme)) return 2;

  return ZERO_WIDTH.test(grapheme) ? 0 : 1;
}

/**
 * At most `max` terminal columns of `value`, with `…` in the last one when it is cut. It counts columns, not UTF-16
 * units, so a wide letter or an emoji never pushes the row past `max`, and it cuts between graphemes, never through one.
 */
export function clipText(value: string, max: number): string {
  if (max <= 0) return '';

  if (NARROW_ONLY.test(value)) {
    if (value.length <= max) return value;

    return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
  }

  const room = max <= 1 ? max : max - 1;
  let used = 0;
  let kept = 0;

  for (const { segment, index } of GRAPHEMES.segment(value)) {
    used += graphemeColumns(segment);

    if (used > max) return max <= 1 ? value.slice(0, kept) : `${value.slice(0, kept)}…`;

    if (used <= room) kept = index + segment.length;
  }

  return value;
}

const ESC = 0x1b;

const BEL = 0x07;

/** The 8-bit CSI. */
const CSI = 0x9b;

/** The 8-bit string terminator. */
const ST = 0x9c;

/** The string commands (DCS, SOS, OSC, PM, APC): their 8-bit bytes, and the byte after ESC in their 7-bit form. */
const STRING_COMMANDS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

const STRING_COMMANDS_AFTER_ESC = new Set(['P', 'X', ']', '^', '_'].map((c) => c.charCodeAt(0)));

/** Every control character (Unicode Cc: C0, DEL and C1); newline and tab are kept by the caller. */
const CONTROL_CHARACTER = /\p{Cc}/gu;

function within(text: string, at: number, low: number, high: number): boolean {
  const code = text.charCodeAt(at);

  return code >= low && code <= high;
}

/** Past the bytes at `at` that lie in [low, high]. */
function skipWithin(text: string, at: number, low: number, high: number): number {
  let next = at;

  while (within(text, next, low, high)) next++;

  return next;
}

/** A CSI's body from `at`: parameters, intermediates, one final byte; `null` when the final byte is missing. */
function csiEnd(text: string, at: number): number | null {
  const final = skipWithin(text, skipWithin(text, at, 0x30, 0x3f), 0x20, 0x2f);

  return within(text, final, 0x40, 0x7e) ? final + 1 : null;
}

/** A string command's body from `at`, to its terminator (BEL, ESC \\ or ST) or the end of the line. */
function stringCommandEnd(text: string, at: number): number {
  let next = at;

  for (; next < text.length; next++) {
    const code = text.charCodeAt(next);

    if (code === BEL || code === ST) return next + 1;

    if (code === ESC) return text.charCodeAt(next + 1) === 0x5c ? next + 2 : next;

    if (code === 0x0a) return next;
  }

  return next;
}

/**
 * Where a terminal escape starting at `at` ends, 7- or 8-bit: CSI to its final byte; the string commands to their
 * terminator or the end of the line; else ESC, its intermediates and one final byte. `null`: no escape starts here.
 */
function escapeEnd(text: string, at: number): number | null {
  const code = text.charCodeAt(at);
  const next = text.charCodeAt(at + 1);

  if (code === CSI) return csiEnd(text, at + 1);

  if (STRING_COMMANDS.has(code)) return stringCommandEnd(text, at + 1);

  if (code !== ESC) return null;

  if (next === 0x5b) return csiEnd(text, at + 2);

  if (STRING_COMMANDS_AFTER_ESC.has(next)) return stringCommandEnd(text, at + 2);
  const final = skipWithin(text, at + 1, 0x20, 0x2f);

  return within(text, final, 0x30, 0x7e) ? final + 1 : null;
}

/** The text without its terminal escapes; a control character that opens none stays for {@link controlPicture}. */
function withoutEscapes(text: string): string {
  let kept = '';
  let from = 0;

  for (const match of text.matchAll(CONTROL_CHARACTER)) {
    if (match.index < from) continue;
    const end = escapeEnd(text, match.index);

    if (end === null) continue;
    kept += text.slice(from, match.index);
    from = end;
  }

  return kept + text.slice(from);
}

/** Its Unicode control picture, one column wide, so it shows rather than acts; C1 has none. */
function controlPicture(control: string): string {
  const code = control.charCodeAt(0);

  if (code === 0x7f) return '\u2421';

  return code < 0x20 ? String.fromCharCode(0x2400 + code) : '\ufffd';
}

/**
 * Text another program wrote, as a terminal can show it without obeying it: escapes dropped, a carriage return
 * leaving the line's last overwrite, and any other control character drawn as its picture.
 */
export function terminalText(value: string): string {
  return withoutEscapes(value)
    .split('\n')
    .map((line) => (line.includes('\r') ? line.split('\r').filter((overwrite) => overwrite !== '').at(-1) ?? '' : line))
    .join('\n')
    .replace(CONTROL_CHARACTER, (control) => (control === '\n' || control === '\t' ? control : controlPicture(control)));
}

/** Blank label means a pre-codename row: show the codename its slug would get (same rule as web `agentTitle`). */
export function agentDisplayLabel(entry: { name: string; label: string }): string {
  return entry.label.trim() || codenameFor(entry.name);
}
