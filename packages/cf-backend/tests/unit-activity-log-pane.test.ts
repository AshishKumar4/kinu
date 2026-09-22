/**
 * The Activity panel reads the `log` its own snapshot already fetches, rather than dropping it on every
 * revalidation. Derived from props, so it adds no fetch or cadence of its own.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityLogEntry } from '@kinu.run/core';
import { LogBlock } from '../src/components/surfaces/ActivitySurface';

const AT = Date.UTC(2026, 7, 30, 12, 0, 0);

/** Real `logActivity` names, oldest first (the order `readActivityLog` returns). */
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
    // `logActivity` writes 0 outside a turn (`_turnT0 > 0 ? … : 0`), so 0 must not render as a duration.
    const html = render([LOG[0]]);
    expect(html).toContain('—');
    expect(html).not.toContain('0 ms');
    expect(html).toContain('no elapsed time to report');
  });

  test('a null detail renders the row without inventing prose for it', () => {
    const html = render([{ event: 'gettools_start', detail: null, elapsedMs: 11, createdAt: AT }]);
    expect(html).toContain('gettools_start');
    expect(html).toContain('11 ms');
  });

  test('an empty log says nothing has been logged, not that the read failed', () => {
    const html = render([]);
    expect(html).toContain('Nothing has been logged');
    expect(html).not.toContain('0 rows');
  });

  test('the row count and its order are stated, so a truncated window is visible', () => {
    expect(render(LOG)).toContain('4 rows · newest first');
    expect(render([LOG[0]])).toContain('1 row · newest first');
  });
});
