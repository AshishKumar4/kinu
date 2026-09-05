/**
 * The terminal chrome vocabulary — the marks, labels, and advertised
 * keybindings the TUI renders, shared so every surface that DEPICTS the TUI
 * (the landing page's terminal demo) draws the product rather than a sketch
 * of it. The CLI is the authority; this module is the contract both read.
 *
 * Textual marks only (dingbats, geometric shapes, technical symbols):
 * emoji-presentation code points render differently on every terminal font,
 * and the CLI's zero-emoji gate holds this module to that.
 */

import type { ChangelogEntryKind } from './evolution/changelog';

/** The transcript's mark language, one mark per row kind. */
export const TUI_MARKS = {
  /** A tool call row: `› run bun test`. */
  toolCall: '›',
  /** The call's result, indented under it: `↳ 7 pass`. */
  toolResult: '↳',
  /** A failed result or refusal. */
  failure: '✗',
  /** A self-evolution row: a lesson, a crafted tool, a scaffold change. */
  evolution: '✦',
  /** The composer prompt. */
  prompt: '❯',
  /** Connection state, in the StatusBar ONLY — is the client attached. */
  connected: '●',
  disconnected: '○',
  /** Agent activity, on navigator rows — is the AGENT working. The glyphs
   *  coincide with the connection marks today, but the contracts are
   *  distinct on purpose: a navigator row answers "is it doing something",
   *  the status bar answers "am I attached", and either pair can change
   *  without dragging the other with it. */
  activity: {
    running: '●',
    idle: '○',
  },
  /** The user gutter label on transcript rows. */
  userGutter: 'YOU',
} as const;

/** The resting composer placeholder. */
export const TUI_COMPOSER_PLACEHOLDER = 'Send a message…';
/** The composer placeholder while a turn runs. It names what typing does then.
 *  The first-run pty case waits on its arrival as the product's own word that
 *  a submitted draft went out. */
export const TUI_COMPOSER_STEERING_PLACEHOLDER = 'Type to steer the running turn';

/** One mark per evolution self-change kind, shared by the changelog overlay,
 *  the console event stream, and the landing page's workspace journal. */
export const CHANGE_KIND_GLYPH = {
  scaffold: '⟳',
  tool: '✎',
  fact: '✦',
  gepa: '◬',
  replay: '⟲',
  outcomes: '✓',
  prompt_section: '➤',
  refinement: '⌁',
} satisfies Record<ChangelogEntryKind, string>;

/** The pi-omp binding subset printed outside the TUI. The CLI preset imports
 * this object rather than repeating the four keys, so a marketing hint can only
 * change with the binding it describes. */
export const TUI_ADVERTISED_PRESET_BINDINGS = {
  'palette.toggle': 'ctrl+k',
  'workspace.toggle': 'alt+w',
  'hub.agents': 'alt+a',
  'tier.quick': 'alt+p',
} as const;

const tuiHintKey = (binding: string): string => binding
  .split('+')
  .map((part) => part === 'ctrl' ? 'Ctrl' : part === 'alt' ? 'Alt' : part.toUpperCase())
  .join('+');

/** The bindings the product advertises on chrome and marketing surfaces, as
 * the real default keymap resolves them. */
export const TUI_ADVERTISED_HINTS = [
  { action: 'palette.toggle', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['palette.toggle']), label: 'commands' },
  { action: 'workspace.toggle', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['workspace.toggle']), label: 'workspaces' },
  { action: 'hub.agents', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['hub.agents']), label: 'agents' },
  { action: 'tier.quick', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['tier.quick']), label: 'tiers' },
] as const;

/** Rows of a wrapped draft the chat composer grows to before it scrolls
 *  instead. Eight keeps a long paste readable without burying the transcript. */
const COMPOSER_MAX_ROWS = 8;

/** Rows the composer shows for a draft the editor wrapped to `virtualLines`
 *  visual rows.
 *
 *  A draft is not a line count: word wrap turns one typed line into as many
 *  VISUAL rows as the composer's width demands, over display columns — a CJK
 *  glyph costs two, a combining mark none. The editor owns that wrap and the
 *  cursor's row and column within it, and reports the result as a virtual line
 *  count; this is the display decision on top of it. Never none, so an empty
 *  draft keeps its placeholder row. Never more than `maxRows` — past the cap
 *  the draft scrolls inside the composer with the cursor still in view, so the
 *  cap bounds what is shown and never what can be typed. A count no editor
 *  could report (no layout yet, so no wrap width) reads as one row rather than
 *  a box height of NaN. */
export function composerVisibleRows(virtualLines: number, maxRows: number = COMPOSER_MAX_ROWS): number {
  if (!Number.isFinite(virtualLines)) return 1;
  const rows = Math.floor(virtualLines);
  const cap = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : Number.POSITIVE_INFINITY;
  if (rows < 1) return 1;
  return Math.min(rows, cap);
}
