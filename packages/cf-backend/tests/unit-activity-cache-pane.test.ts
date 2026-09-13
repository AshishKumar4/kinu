import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeSteps } from '@kinu.run/core';
import { CacheBlock } from '../src/components/surfaces/ActivitySurface';

describe('the Activity prompt-cache panel', () => {
  test('EMA leads; last and mean retain row size; p95 and p99 use metadata size', () => {
    const { cacheHit } = summarizeSteps(Array.from({ length: 100 }, (_, index) => ({
      usage: { input: 100, cacheRead: index + 1 },
    })), { windowLimit: 200 });

    const html = renderToStaticMarkup(createElement(CacheBlock, { cacheHit }));

    expect(html.indexOf('>EMA<')).toBeLessThan(html.indexOf('>Last<'));
    expect(html).toContain('text-[22px] leading-none p-text');
    expect(html).toMatch(/>Last<\/dt><dd><span class="[^"]*p-row-text p-text[^"]*">100\.0%/);
    expect(html).toMatch(/>Mean<\/dt><dd><span class="[^"]*p-row-text p-text[^"]*">50\.5%/);
    expect(html).toMatch(/>p95<\/dt><dd><span class="[^"]*p-meta p-text-2[^"]*">95\.0%/);
    expect(html).toMatch(/>p99<\/dt><dd><span class="[^"]*p-meta p-text-2[^"]*">99\.0%/);
    expect(html).toContain('100 sampled steps');
  });

  test('unreported cache counters do not render invented zero percentiles', () => {
    const { cacheHit } = summarizeSteps([{ usage: { input: 100 } }], { windowLimit: 200 });
    const html = renderToStaticMarkup(createElement(CacheBlock, { cacheHit }));

    expect(html).toContain('there is no');
    expect(html).not.toContain('0.0%');
  });
});
