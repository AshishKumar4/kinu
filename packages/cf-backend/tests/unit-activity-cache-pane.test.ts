// Defends: a rate under another's label, and an unreported counter drawn as 0%. Type scale: the browser suite.
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeSteps } from '@kinu.run/core';
import { CacheBlock } from '../src/components/surfaces/ActivitySurface';

/** Each `<dt>` label with the visible text of the `<dd>` after it, in order. */
const metrics = (html: string): [string, string][] =>
  [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((match) => [match[1] ?? '', (match[2] ?? '').replace(/<[^>]+>/g, '')]);

describe('the Activity prompt-cache panel', () => {
  test('each rate stands under its own label, EMA first, over the steps it sampled', () => {
    const { cacheHit } = summarizeSteps(Array.from({ length: 100 }, (_, index) => ({
      usage: { input: 100, cacheRead: index + 1 },
    })), { windowLimit: 200 });

    const html = renderToStaticMarkup(createElement(CacheBlock, { cacheHit }));

    expect(metrics(html)).toEqual([['EMA', expect.stringMatching(/%$/)], ['Last', '100.0%'], ['Mean', '50.5%'], ['p95', '95.0%'], ['p99', '99.0%']]);
    expect(html).toContain('100 sampled steps');
  });

  test('unreported cache counters render no rate at all, never an invented zero', () => {
    const { cacheHit } = summarizeSteps([{ usage: { input: 100 } }], { windowLimit: 200 });
    const html = renderToStaticMarkup(createElement(CacheBlock, { cacheHit }));

    expect(metrics(html)).toEqual([]);
    expect(html).not.toContain('%');
  });
});
