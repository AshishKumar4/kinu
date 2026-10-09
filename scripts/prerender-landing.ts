/**
 * Writes the landing's markup into a built `landing.html`, so the page paints from its HTML and CSS before its script
 * arrives, and `landing.tsx` hydrates what it finds. Measured 2026-10-08 on the mobile profile: the client-rendered
 * page painted at 3.3 s, after 203 KB of script. The build runs it on its output (`vite-landing-prerender.ts`):
 *
 *   bun scripts/prerender-landing.ts <client dist dir>
 */
import { join } from 'node:path';
import { plugin } from 'bun';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import * as v from 'valibot';

// What the page imports and a server render never draws: shaders, styles, and the build's virtual modules.
plugin({
  name: 'landing-prerender',
  setup(build) {
    build.onLoad({ filter: /\.wgsl$/ }, async ({ path }) => ({ contents: `export default ${JSON.stringify(await Bun.file(path).text())};`, loader: 'js' }));
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    build.onResolve({ filter: /^virtual:/ }, ({ path }) => ({ path, namespace: 'landing-virtual' }));
    build.onLoad({ filter: /.*/, namespace: 'landing-virtual' }, () => ({ contents: '', loader: 'js' }));
  },
});

const EMPTY_ROOT = '<div id="landing-root"></div>';

/** Named at run time: the page is cf-backend's TSX, checked by its own project, not by the scripts' one. */
const PAGE_MODULE = new URL('../packages/cf-backend/src/components/landing/LandingPage.tsx', import.meta.url).href;

const PageModuleSchema = v.object({ LandingPage: v.custom<ComponentType>((value) => typeof value === 'function') });

const [dist] = process.argv.slice(2);

if (dist === undefined) throw new Error('usage: bun scripts/prerender-landing.ts <client dist dir>');

const page = join(dist, 'landing.html');

const html = await Bun.file(page).text();

if (!html.includes(EMPTY_ROOT)) throw new Error(`${page} has no empty landing root to fill`);

const { LandingPage } = v.parse(PageModuleSchema, await import(PAGE_MODULE));

const markup = renderToString(createElement(LandingPage));

await Bun.write(page, html.replace(EMPTY_ROOT, `<div id="landing-root">${markup}</div>`));

console.log(`prerender-landing: ${String(markup.length)} characters of markup in ${page}`);
