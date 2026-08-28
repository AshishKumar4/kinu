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

/** One mark per evolution self-change kind, shared by the changelog overlay,
 *  the console event stream, and the landing page's workspace journal. */
export const CHANGE_KIND_GLYPH = {
  scaffold: '⟳',
  tool: '✎',
  view: '▦',
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
