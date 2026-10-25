/**
 * Terminal chrome vocabulary shared by the TUI and every surface that depicts it; the CLI is the authority.
 * Textual marks only: emoji code points render differently per terminal font.
 */

import type { ChangelogEntryKind } from './evolution/changelog';

export const ELAPSED_COUNTER = { prefix: ' · ', suffix: 's' } as const;

export const TUI_MARKS = {
  toolCall: '›',
  toolResult: '↳',
  failure: '✗',
  /** A lesson, a crafted tool, or a scaffold change. */
  evolution: '✦',
  thinking: '∴',
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

/** Shared by the changelog overlay and the console event stream. */
export const CHANGE_KIND_GLYPH = {
  scaffold: '⟳',
  fact: '✦',
  ratings: '✓',
  artifact: '➤',
  refinement: '⌁',
  workspace: '⊞',
} satisfies Record<ChangelogEntryKind, string>;

const COMPOSER_MAX_ROWS = 8;

/** Visible composer rows for an editor-wrapped draft: at least 1 (placeholder row, or no layout yet), at most `maxRows` (then it scrolls). */
export function composerVisibleRows(virtualLines: number, maxRows: number = COMPOSER_MAX_ROWS): number {
  if (!Number.isFinite(virtualLines)) return 1;
  const rows = Math.floor(virtualLines);
  const cap = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : Number.POSITIVE_INFINITY;

  if (rows < 1) return 1;

  return Math.min(rows, cap);
}
