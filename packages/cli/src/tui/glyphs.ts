import type { ChangelogEntry } from '@kinu.run/core';

/**
 * The chrome glyph language — textual marks only (dingbats, geometric shapes,
 * technical symbols). Emoji-presentation code points render differently on
 * every terminal font, so none ship here; see the zero-emoji gate in
 * tests/tui.test.tsx.
 */

/** One mark per evolution self-change kind, shared by the changelog overlay
 *  and the console event stream, so both surfaces speak the same language. */
export const CHANGE_KIND_GLYPH = {
  scaffold: '⟳',
  tool: '✎',
  view: '▦',
  fact: '✦',
  gepa: '◬',
  replay: '⟲',
  outcomes: '✓',
  prompt_section: '➤',
} satisfies Record<ChangelogEntry['kind'], string>;
