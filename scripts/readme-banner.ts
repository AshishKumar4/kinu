/**
 * Writes core's wordmark into both README banners (docs/assets/banner.svg and banner-dark.svg), in the ink of each
 * banner's palette, so the drawn letters have one source: `wordmark()` in packages/core/src/http/public-shell.ts.
 *
 *   bun scripts/readme-banner.ts
 */
import { join } from 'node:path';
import { wordmark } from '@kinu.run/core';

const ASSETS = join(import.meta.dir, '..', 'docs', 'assets');

const BEGIN = '<!-- wordmark: bun scripts/readme-banner.ts -->';

const END = '<!-- /wordmark -->';

/** The letters' box in the banner: centred on the tagline, cap top at y 121, baseline at y 233. */
const SCALE = 6.6;

const X = 639.3;

const Y = 98.6;

const drawn = wordmark(24);

const inner = drawn.slice(drawn.indexOf('>') + 1, drawn.lastIndexOf('</svg>')).replaceAll('currentColor', 'var(--ink)');

const group = `${BEGIN}\n  <g transform="translate(${String(X)} ${String(Y)}) scale(${String(SCALE)})" fill="none">${inner}</g>\n  ${END}`;

for (const name of ['banner.svg', 'banner-dark.svg']) {
  const path = join(ASSETS, name);
  const text = await Bun.file(path).text();
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);

  if (from < 0 || to < from) throw new Error(`${name} has no wordmark markers`);
  await Bun.write(path, `${text.slice(0, from)}${group}${text.slice(to + END.length)}`);
}

process.stdout.write('wrote the wordmark into both banners\n');
