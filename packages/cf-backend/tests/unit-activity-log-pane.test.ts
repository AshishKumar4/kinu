/**
 * The Activity panel reads the `log` its own snapshot fetches.
 *
 * THE FAILURE THIS LOCKS DOWN SHIPPED. `getActivitySnapshot` returns `log` — up
 * to 200 `activity_log` rows — and the panel's closing block was cut on the
 * argument that a person can read the same thing in chat. Nothing stopped
 * fetching it, so every revalidation (1.5s while a turn streams) pulled those
 * rows across the wire and dropped them. Either the payload goes or a reader
 * does; the owner asked for the reader.
 *
 * `renderToStaticMarkup` runs the block for real and returns what a reader would
 * see. No effects run and none are needed: the block is derived from its props,
 * which is also why it adds no fetch and no second cadence of its own — it
 * renders whatever the surface above already loaded.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityLogEntry } from '@kinu.run/core';
import { LogBlock } from '../src/components/surfaces/ActivitySurface';

const AT = Date.UTC(2026, 7, 30, 12, 0, 0);

/** One turn's worth of real `logActivity` names, oldest first — the order
 *  `readActivityLog` returns. */
const LOG: readonly ActivityLogEntry[] = [
  { event: 'getmodel', detail: null, elapsedMs: 0, createdAt: AT },
  { event: 'beforeturn', detail: 'streamText() called next', elapsedMs: 4, createdAt: AT + 1_000 },
  { event: 'gettools_end', detail: 'rebuilt — 24 tools', elapsedMs: 287, createdAt: AT + 2_000 },
  { event: 'response_complete', detail: 'ok', elapsedMs: 41_602, createdAt: AT + 43_000 },
];

const render = (log: readonly ActivityLogEntry[]): string =>
  renderToStaticMarkup(createElement(LogBlock, { log }));

describe('the Activity log pane renders the rows the snapshot already carried', () => {
  test('every fetched row reaches the reader — event, detail and elapsed', () => {
    const html = render(LOG);
    for (const row of LOG) {
      expect(html).toContain(row.event);
      if (row.detail !== null) expect(html).toContain(row.detail);
    }
    expect(html).toContain('287 ms');
    expect(html).toContain('41602 ms');
  });

  test('newest first, because a log is read from the top', () => {
    const html = render(LOG);
    expect(html.indexOf('response_complete')).toBeLessThan(html.indexOf('getmodel'));
    expect(html.indexOf('gettools_end')).toBeLessThan(html.indexOf('beforeturn'));
  });

  test('an elapsed of 0 reads as an em dash, never as a 0 ms measurement', () => {
    // `logActivity` writes 0 when no turn was in flight (`_turnT0 > 0 ? … : 0`),
    // so 0 means "outside a turn" and not "took no time". Printing `0 ms` would
    // be the plausible-zero this whole panel refuses.
    const html = render([LOG[0]!]);
    expect(html).toContain('—');
    expect(html).not.toContain('0 ms');
    expect(html).toContain('no turn-relative elapsed time');
  });

  test('a null detail renders the row without inventing prose for it', () => {
    const html = render([{ event: 'gettools_start', detail: null, elapsedMs: 11, createdAt: AT }]);
    expect(html).toContain('gettools_start');
    expect(html).toContain('11 ms');
  });

  test('an empty log says nothing has been logged, not that the read failed', () => {
    const html = render([]);
    expect(html).toContain('Nothing has been logged');
    // The row count note is absent rather than "0 rows": there is no window to
    // report when the table is empty.
    expect(html).not.toContain('0 rows');
  });

  test('the row count and its order are stated, so a truncated window is visible', () => {
    expect(render(LOG)).toContain('4 rows · newest first');
    expect(render([LOG[0]!])).toContain('1 row · newest first');
  });
});
