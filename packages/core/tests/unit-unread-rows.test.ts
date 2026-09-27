/**
 * The chat reserves the height of history it has not loaded, so the scrollbar stands for the whole conversation.
 * The store counts every entry, tool rows included, which the chat never shows; the pages walked so far say what
 * share of entries shows, and the reserve is sized at that share.
 */
import { expect, test } from 'bun:test';
import { unreadRows } from '../src/read-models/fork-count';

interface Case {
  readonly total: number | undefined;
  readonly walked: number;
  readonly shown: number;
  readonly exhausted: boolean;
  readonly unread: number;
}

test.each<[string, Case]>([
  ['before any page, every counted entry the live window lacks is taken to show', { total: 1_000, walked: 0, shown: 0, exhausted: false, unread: 980 }],
  // Half the walked entries were tool rows, so the 20 live rows stand for 40 entries.
  ['once pages are walked, what is left is sized at the share that showed', { total: 1_000, walked: 400, shown: 200, exhausted: false, unread: 280 }],
  ['an exhausted walk reserves nothing, whatever the count says', { total: 1_000, walked: 400, shown: 200, exhausted: true, unread: 0 }],
  ['a pane with no count reserves nothing', { total: undefined, walked: 0, shown: 0, exhausted: false, unread: 0 }],
  ['a count below what was already seen reserves nothing, not a negative height', { total: 100, walked: 200, shown: 200, exhausted: false, unread: 0 }],
])('%s', (_why, { unread, ...counts }) => {
  expect(unreadRows({ ...counts, live: 20 })).toBe(unread);
});
