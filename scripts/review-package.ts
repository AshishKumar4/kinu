/**
 * The review package: the port and the artifact, photographed at the same
 * widths, into /tmp/review-LandingV3/.
 *
 * One gallery boot; his artifact loads from disk with its Google Fonts link
 * rewritten to our self-hosted faces so both sides render in the same two
 * families — a fair comparison of geometry, not a font-availability test.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withGallery } from './gallery-harness';

const OUT = '/tmp/review-LandingV3';
mkdirSync(OUT, { recursive: true });

const FONTS = join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets', 'fonts');
const ARTIFACT = '/home/mrwhite0racle/kinu-landing-design/Kinu Landing Page.dc.html';

const faceCss = `
@font-face{font-family:"Schibsted Grotesk";src:url("file://${join(FONTS, 'schibsted-latin-var.woff2')}") format("woff2-variations");font-weight:400 900;font-style:normal}
@font-face{font-family:"Fragment Mono";src:url("file://${join(FONTS, 'fragmentmono-latin.woff2')}") format("woff2");font-weight:400;font-style:normal}
`;

const artifactHtml = readFileSync(ARTIFACT, 'utf8')
  .replace(/<link rel="preconnect"[^>]*>\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
  .replace('</head>', `<style>${faceCss}</style></head>`)
  // support.js is the mock runtime's hover shim; offline it is absent, so the
  // hovers simply stay inert on his side.
  ;
const artifactPath = join(OUT, 'artifact.html');
writeFileSync(artifactPath, artifactHtml);

await withGallery(async ({ browser, origin }) => {
  for (const [label, width, height] of [
    ['1280', 1280, 900], ['1920', 1920, 1000], ['390', 390, 844],
  ] as const) {
    // His artifact.
    const a = await browser.newPage();
    await a.setViewport({ width, height, deviceScaleFactor: 1 });
    await a.goto(`file://${artifactPath}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));
    if (width === 1280) await a.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 400));
    await a.screenshot({ path: `${OUT}/artifact-${label}.png`, fullPage: true });
    await a.close();

    // The port, as the worker serves it.
    const p = await browser.newPage();
    await p.setViewport({ width, height, deviceScaleFactor: 1 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await p.goto(`${origin}/gallery.html?frame=landing`, { waitUntil: 'networkidle0' });
    await p.waitForFunction(() => !document.querySelector('[data-growing]'), { timeout: 10_000 })
      // No [data-growing] guard ships on the canvas hero; a timeout here
      // means only that the wait outlived the draw, which the shot below
      // captures regardless.
      .catch((cause) => { console.warn('settle wait elapsed:', cause instanceof Error ? cause.message : String(cause)); });
    await new Promise((r) => setTimeout(r, 600));
    await p.screenshot({ path: `${OUT}/port-${label}.png`, fullPage: true });
    await p.close();
    console.log(`shot ${label}`);
  }
});
console.log(`review package in ${OUT}`);
