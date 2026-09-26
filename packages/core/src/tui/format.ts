import { codenameFor } from '../identity/naming';

const NARROW_ONLY = /^[\x20-\x7e]*$/;

/** Two columns, as wcwidth counts; ambiguous width counts one. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]|\ufe0f|\p{Emoji_Presentation}/u;

/** Marks and format characters take no column. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeColumns(grapheme: string): number {
  if (WIDE.test(grapheme)) return 2;

  return ZERO_WIDTH.test(grapheme) ? 0 : 1;
}

/** At most `max` terminal columns, cut between graphemes, ending in `…` when cut. */
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

const CSI = 0x9b;

const ST = 0x9c;

/** DCS, SOS, OSC, PM and APC. */
const STRING_COMMANDS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

const STRING_COMMANDS_AFTER_ESC = new Set(['P', 'X', ']', '^', '_'].map((c) => c.charCodeAt(0)));

/** Unicode Cc: C0, DEL and C1. */
const CONTROL_CHARACTER = /\p{Cc}/gu;

function within(text: string, at: number, low: number, high: number): boolean {
  const code = text.charCodeAt(at);

  return code >= low && code <= high;
}

function skipWithin(text: string, at: number, low: number, high: number): number {
  let next = at;

  while (within(text, next, low, high)) next++;

  return next;
}

/** `null` when the final byte is missing. */
function csiEnd(text: string, at: number): number | null {
  const final = skipWithin(text, skipWithin(text, at, 0x30, 0x3f), 0x20, 0x2f);

  return within(text, final, 0x40, 0x7e) ? final + 1 : null;
}

/** To BEL, ESC \\, ST or the end of the line. */
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

/** Where a 7- or 8-bit escape at `at` ends; `null` when none starts there. */
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

/** Stray controls stay for {@link controlPicture}. */
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

/** One column, so it shows rather than acts; C1 has none. */
function controlPicture(control: string): string {
  const code = control.charCodeAt(0);

  if (code === 0x7f) return '\u2421';

  return code < 0x20 ? String.fromCharCode(0x2400 + code) : '\ufffd';
}

function visible(control: string): string {
  return control === '\n' || control === '\t' ? control : controlPicture(control);
}

/** Output shown, not obeyed: escapes dropped, a CR keeps the last overwrite. */
export function terminalText(value: string): string {
  return withoutEscapes(value)
    .split('\n')
    .map((line) => (line.includes('\r') ? line.split('\r').filter((overwrite) => overwrite !== '').at(-1) ?? '' : line))
    .join('\n')
    .replace(CONTROL_CHARACTER, visible);
}

/** For approval: nothing dropped, so what shows is what runs. */
export function literalText(value: string): string {
  return value.replace(CONTROL_CHARACTER, visible);
}

/** Blank label means a pre-codename row: show the codename its slug would get (same rule as web `agentTitle`). */
export function agentDisplayLabel(entry: { name: string; label: string }): string {
  return entry.label.trim() || codenameFor(entry.name);
}
