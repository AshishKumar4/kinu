/**
 * Terminal chrome vocabulary shared by the TUI and every surface that depicts it; the CLI is the authority.
 * Textual marks only: emoji code points render differently per terminal font, and the CLI's zero-emoji gate enforces it.
 */

import type { ChangelogEntryKind } from './evolution/changelog';

export const TUI_MARKS = {
  toolCall: '›',
  toolResult: '↳',
  failure: '✗',
  /** A lesson, a crafted tool, or a scaffold change. */
  evolution: '✦',
  prompt: '❯',
  /** Status bar only: is the client attached. */
  connected: '●',
  disconnected: '○',
  /** Navigator rows: is the agent working. Distinct contract from the connection marks despite equal glyphs. */
  activity: {
    running: '●',
    idle: '○',
  },
  userGutter: 'YOU',
} as const;

export const TUI_COMPOSER_PLACEHOLDER = 'Send a message…';

/** The first-run pty case waits on this text as proof a submitted draft went out. */
export const TUI_COMPOSER_STEERING_PLACEHOLDER = 'Type to steer the running turn';

/** Shared by the changelog overlay, the console event stream, and the landing page's journal. */
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

/** The CLI preset imports these, so an advertised hint can only change with its binding. */
export const TUI_ADVERTISED_PRESET_BINDINGS = {
  'palette.toggle': 'ctrl+k',
  'workspace.toggle': 'alt+w',
  'hub.agents': 'alt+a',
  'tier.quick': 'alt+p',
} as const;

/** Any token that is not a modifier is a key name, shown upper-case. */
const TUI_HINT_MODIFIERS = new Map<string, string>([['ctrl', 'Ctrl'], ['alt', 'Alt']]);

const tuiHintKey = (binding: string): string => binding
  .split('+')
  .map((part) => TUI_HINT_MODIFIERS.get(part) ?? part.toUpperCase())
  .join('+');

export const TUI_ADVERTISED_HINTS = [
  { action: 'palette.toggle', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['palette.toggle']), label: 'commands' },
  { action: 'workspace.toggle', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['workspace.toggle']), label: 'workspaces' },
  { action: 'hub.agents', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['hub.agents']), label: 'agents' },
  { action: 'tier.quick', keys: tuiHintKey(TUI_ADVERTISED_PRESET_BINDINGS['tier.quick']), label: 'tiers' },
] as const;

const COMPOSER_MAX_ROWS = 8;

/** Visible composer rows for an editor-wrapped draft: at least 1 (placeholder row, or no layout yet), at most `maxRows` (then it scrolls). */
export function composerVisibleRows(virtualLines: number, maxRows: number = COMPOSER_MAX_ROWS): number {
  if (!Number.isFinite(virtualLines)) return 1;
  const rows = Math.floor(virtualLines);
  const cap = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : Number.POSITIVE_INFINITY;

  if (rows < 1) return 1;

  return Math.min(rows, cap);
}
