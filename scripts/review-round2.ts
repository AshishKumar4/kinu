/**
 * Round-2 review capture: the artifact RENDERED (its mock runtime served
 * over HTTP, typewriter settled, canvas painted) against the port, at 1280
 * and 1920 — plus per-section Y positions on both sides, so the drift is a
 * table of numbers rather than an impression. One vite, one browser, both
 * closed before exit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const OUT = '/tmp/review-LandingV3';
mkdirSync(OUT, { recursive: true });
const DESIGN_DIR = '/home/mrwhite0racle/kinu-landing-design';
const FONTS = join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets', 'fonts');
const CF = join(import.meta.dir, '..', 'packages', 'cf-backend');

function freePort(from: number): Promise<number> {
  return (async () => {
    for (let port = from; port < from + 50; port++) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
      if (await promise) return port;
    }
    throw new Error('no free port');
  })();
}

interface KidRow { readonly cls: string; readonly h: number; readonly text: string }
interface SideAnatomy {
  readonly clientsGrid: readonly KidRow[] | null;
  readonly film: readonly KidRow[] | null;
  readonly deployRows: readonly KidRow[] | null;
  readonly deployValues: readonly KidRow[] | null;
}
interface SectionYs {
  readonly __pageHeight: number;
  [id: string]: number;
}

interface DriftReport {
  readonly artifactHeightPx: number;
  readonly portHeightPx: number;
  readonly artifactRatio: number;
  readonly portRatio: number;
  readonly sectionHeights: Record<string, { readonly artifact: number; readonly port: number }>;
  readonly driftPx: Record<string, number>;
}

interface KidRow { readonly cls: string; readonly h: number; readonly text: string }
interface SideAnatomy {
  readonly clientsGrid: readonly KidRow[] | null;
  readonly film: readonly KidRow[] | null;
  readonly deployRows: readonly KidRow[] | null;
  readonly deployValues: readonly KidRow[] | null;
}

/** Serve the design over HTTP from a staging dir — the mock runtime needs an
 *  origin to execute, and Chrome refuses file:// fonts on an http page, so
 *  the two self-hosted faces travel WITH the artifact and his Google Fonts
 *  link is rewritten to them. */
async function serveDesign(): Promise<{ url: string; kill: () => void }> {
  const stage = join(OUT, 'artifact-origin');
  mkdirSync(stage, { recursive: true });
  for (const f of ['support.js', 'Kinu Landing Page.dc.html']) {
    writeFileSync(join(stage, f), readFileSync(join(DESIGN_DIR, f)));
  }
  for (const f of ['schibsted-latin-var.woff2', 'fragmentmono-latin.woff2']) {
    writeFileSync(join(stage, f), readFileSync(join(FONTS, f)));
  }
  const html = readFileSync(join(stage, 'Kinu Landing Page.dc.html'), 'utf8')
    .replace(/<link rel="preconnect"[^>]*>\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
    .replace('</head>', `<style>
@font-face{font-family:"Schibsted Grotesk";src:url("schibsted-latin-var.woff2") format("woff2-variations");font-weight:400 900}
@font-face{font-family:"Fragment Mono";src:url("fragmentmono-latin.woff2") format("woff2");font-weight:400}
</style></head>`);
  writeFileSync(join(stage, 'Kinu Landing Page.dc.html'), html);
  const port = await freePort(8231);
  const server = spawn('python3',
    ['-m', 'http.server', String(port), '--directory', stage, '--bind', '127.0.0.1'],
    { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { if ((await fetch(`${url}/Kinu%20Landing%20Page.dc.html`)).ok) break; } catch (cause) {
      console.warn('design origin not answering yet:', cause instanceof Error ? cause.message : cause);
    }
    if (Date.now() > deadline) throw new Error('design server never came up');
    await Bun.sleep(200);
  }
  return { url, kill: () => server.kill() };
}

const SECTION_IDS = ['top', 'platform', 'quickstart', 'clients', 'evolution', 'swarm', 'deploy', 'cta'] as const;

async function measure(page: Page): Promise<SectionYs> {
  // The CDP boundary hands back a plain record; the missing-key defaults
  // below rebuild the typed shape without an assertion.
  const tops = await page.evaluate((ids: readonly string[]) => {
    const out: Record<string, number> = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el === null ? -1 : Math.round(el.getBoundingClientRect().top + window.scrollY);
    }
    out.__pageHeight = document.documentElement.scrollHeight;
    return out;
  }, SECTION_IDS);
  const ys: SectionYs = { __pageHeight: tops.__pageHeight ?? -1 };
  for (const id of SECTION_IDS) ys[id] = tops[id] ?? -1;
  return ys;
}

async function anatomy(page: Page): Promise<SideAnatomy> {
  // SAFETY: the selectors are this repo's own landing markup, asserted by the
  // unit gates; the row shape below is the named contract for what comes back.
  return page.evaluate((): SideAnatomy => {
    const deep = (sel: string): KidRow[] | null => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      return [...el.children].map((k) => ({
        cls: String(k.className).slice(0, 30),
        h: Math.round(k.getBoundingClientRect().height),
        text: (k.textContent ?? '').trim().slice(0, 40),
      }));
    };
    return {
      clientsGrid: deep('#clients .grid'),
      film: deep('#clients .film'),
      deployRows: deep('#deploy .rows'),
      deployValues: deep('#deploy .grid'),
    };
  });
}

async function waitArtifactSettled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    (document.querySelector('h1')?.textContent ?? '').includes('get better with use.'),
  { timeout: 20_000, polling: 'raf' });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    if (canvas === null) return false;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4 * 37) if (data[i]! > 8) painted += 1;
    return painted > 300;
  }, { timeout: 20_000, polling: 'raf' });
}

const chromePath = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
  .find((p) => existsSync(p));

let browser: Browser | null = null;
const design = await serveDesign();
const vitePort = await freePort(5199);
const vite = spawn('bunx', ['vite', 'dev', '--config', 'gallery.vite.config.ts', '--port', String(vitePort)],
  { cwd: CF, stdio: 'ignore' });
try {
  const origin = `http://127.0.0.1:${vitePort}`;
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(`${origin}/gallery.html`)).ok; } catch (cause) {
      console.warn('vite not answering yet:', cause instanceof Error ? cause.message : cause);
    }
    if (!up) await Bun.sleep(250);
  }
  if (!up) throw new Error('vite never came up');

  browser = await puppeteer.launch({ headless: true, executablePath: chromePath ?? undefined, args: ['--no-sandbox'] });
  const report: Record<string, DriftReport | Record<string, SideAnatomy>> = {};

  for (const [label, width, height] of [['1280', 1280, 900], ['1920', 1920, 1000]] as const) {
    const a = await browser.newPage();
    await a.setViewport({ width, height, deviceScaleFactor: 1 });
    await a.goto(`${design.url}/${encodeURIComponent('Kinu Landing Page.dc.html')}`, { waitUntil: 'networkidle0' });
    await waitArtifactSettled(a);
    const artifactYs = await measure(a);
    await a.screenshot({ path: `${OUT}/artifact-${label}.png`, fullPage: true });

    const p = await browser.newPage();
    await p.setViewport({ width, height, deviceScaleFactor: 1 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await p.goto(`${origin}/gallery.html?frame=landing`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 700));
    const portYs = await measure(p);
    await p.screenshot({ path: `${OUT}/port-${label}.png`, fullPage: true });

    const drift: Record<string, number> = {};
    for (const id of Object.keys(artifactYs)) {
      drift[id] = (portYs[id] ?? -1) - (artifactYs[id] ?? -1);
    }
    const driftReport: DriftReport = {
      artifactHeightPx: artifactYs.__pageHeight,
      portHeightPx: portYs.__pageHeight,
      artifactRatio: +(artifactYs.__pageHeight / width).toFixed(2),
      portRatio: +(portYs.__pageHeight / width).toFixed(2),
      sectionHeights: secsTable(artifactYs, portYs),
      driftPx: drift,
    };
    report[label] = driftReport;
    if (label === '1280') {
      writeFileSync(`${OUT}/anatomy.json`, JSON.stringify({ artifact: await anatomy(a), port: await anatomy(p) }, null, 1));
    }

    const art = `data:image/png;base64,${readFileSync(`${OUT}/artifact-${label}.png`).toString('base64')}`;
    const prt = `data:image/png;base64,${readFileSync(`${OUT}/port-${label}.png`).toString('base64')}`;
    const o = await browser.newPage();
    await o.setViewport({ width, height, deviceScaleFactor: 1 });
    await o.setContent(`<body style="margin:0;background:#000">
      <img src="${art}" style="position:absolute;top:0;left:0;width:100%;opacity:.5">
      <img src="${prt}" style="position:absolute;top:0;left:0;width:100%;opacity:.5;mix-blend-mode:screen">
    </body>`);
    await new Promise((r) => setTimeout(r, 500));
    await o.screenshot({ path: `${OUT}/overlay-${label}.png`, fullPage: false });
    await o.close();
    await a.close(); await p.close();
    console.log(`captured ${label}`);
  }
  writeFileSync(`${OUT}/drift.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser?.close();
  design.kill();
  vite.kill();
}

/** Section heights on both sides, keyed by starting marker. */
function secsTable(a: SectionYs, p: SectionYs): DriftReport['sectionHeights'] {
  const out: DriftReport['sectionHeights'] = {};
  for (let i = 0; i < SECTION_IDS.length; i++) {
    const id = SECTION_IDS[i]!;
    const nextId = i + 1 < SECTION_IDS.length ? SECTION_IDS[i + 1]! : null;
    const nextA = nextId === null ? a.__pageHeight : a[nextId];
    const nextP = nextId === null ? p.__pageHeight : p[nextId];
    out[id] = { artifact: nextA - a[id]!, port: nextP - p[id]! };
  }
  return out;
}
