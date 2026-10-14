/**
 * Draws the README banners (docs/assets/banner.png and banner-dark.png) from core: the mark from public-shell.ts, the
 * palette from web/theme.ts, and the name and tagline set by Chrome in the app's own faces. PNG at twice the size the
 * README shows, because GitHub serves README images under a CSP that loads no font into an SVG, so an SVG would need
 * its text outlined by a font parser this repo does not carry.
 *
 *   bun scripts/readme-banner.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mark, THEME_TOKENS, type Mode } from '@kinu.run/core';
import { withTestChrome } from './test-chrome';

const REPO = join(import.meta.dir, '..');

const FONTS = join(REPO, 'packages', 'cf-backend', 'public', 'assets', 'fonts');

const OUT: Readonly<Record<Mode, string>> = {
  light: join(REPO, 'docs', 'assets', 'banner.png'),
  dark: join(REPO, 'docs', 'assets', 'banner-dark.png'),
};

const WIDTH = 1600;

const HEIGHT = 400;

function face(family: string, file: string, weight: string): string {
  const data = readFileSync(join(FONTS, file)).toString('base64');

  return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:${weight}}`;
}

function page(mode: Mode): string {
  const tokens = THEME_TOKENS[mode];

  return `<!doctype html><html><head><style>
${face('Schibsted Grotesk', 'schibsted-latin-var.woff2', '400 900')}
${face('Fragment Mono', 'fragmentmono-latin.woff2', '400')}
html,body{margin:0;width:${String(WIDTH)}px;height:${String(HEIGHT)}px;background:${tokens['--c-bg']};color:${tokens['--c-text']}}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;position:relative}
.lockup{display:flex;align-items:center;gap:30px;font:500 112px/1 "Schibsted Grotesk";letter-spacing:-.01em}
.lockup .mark{color:${tokens['--c-accent']}}
.tagline{display:flex;align-items:center;gap:22px;font:400 19px "Fragment Mono";letter-spacing:.26em;color:${tokens['--c-text-3']}}
.tagline::before,.tagline::after{content:"";width:58px;height:1px;background:${tokens['--c-border-strong']}}
.corner{position:absolute;width:36px;height:36px;border:2px solid ${tokens['--c-border-strong']}}
</style></head><body>
<span class="corner" style="left:30px;top:30px;border-right:0;border-bottom:0"></span>
<span class="corner" style="right:30px;top:30px;border-left:0;border-bottom:0"></span>
<span class="corner" style="left:30px;bottom:30px;border-right:0;border-top:0"></span>
<span class="corner" style="right:30px;bottom:30px;border-left:0;border-top:0"></span>
<div class="lockup">${mark(118)}<span>Kinu</span></div>
<div class="tagline">THE SELF-EVOLVING AGENT PLATFORM</div>
</body></html>`;
}

await withTestChrome(async (browser) => {
  for (const mode of ['light', 'dark'] as const) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
    await tab.setContent(page(mode), { waitUntil: 'load' });
    await tab.evaluate(async () => document.fonts.ready);
    await tab.screenshot({ path: OUT[mode] });
    await tab.close();
  }
});

process.stdout.write(`wrote ${OUT.light} and ${OUT.dark}\n`);
