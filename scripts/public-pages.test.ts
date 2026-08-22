import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';

import { withGallery } from './gallery-harness';
import { THEMES, type Theme } from './computed-style';

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;
const LANDING_WIDTHS = [
  ['390', PHONE],
  ['640', { width: 640, height: 900 }],
  ['900', { width: 900, height: 900 }],
  ['1280', DESKTOP],
  ['1568', { width: 1568, height: 940 }],
  ['1920', { width: 1920, height: 1000 }],
] as const;
const PUBLIC_FRAMES = ['login', 'install', 'approve'] as const;

interface Contrast {
  readonly what: string;
  readonly ratio: number;
  readonly size: number;
}

interface SurfaceFact {
  readonly present: boolean;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

interface Facts {
  typed?: { early: string; later: string };
  reduced?: { before: string; after: string; pixels: number; animations: number };
  canvasPixels?: number;
  treeFlows?: boolean;
  prunedNodes?: number;
  workspace?: SurfaceFact;
  tui?: SurfaceFact;
  cli?: SurfaceFact;
  command?: string;
  copied?: boolean;
  homeLink?: { visible: boolean; hasGraphic: boolean };
  deploy?: { button: string | null; guide: string | null };
  providers?: string[];
  loginLayout?: { dialog: boolean; cardOffset: number; barOffset: number; footer: boolean };
  landingOverflow: Record<string, number>;
  publicOverflow: Record<string, number>;
  landingTargets?: number[];
  publicTargets?: number[];
  wideColumns: Record<string, number>;
  contrast: Contrast[];
}

let browser: Browser;
let origin: string;
const facts: Facts = {
  landingOverflow: {},
  publicOverflow: {},
  wideColumns: {},
  contrast: [],
};

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not measured`);
  return value;
}

function luminance(rgb: readonly [number, number, number]): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/-?[\d.]+/g);
  if (channels === null || channels.length < 3) throw new Error(`not a colour: ${value}`);
  return [Number(channels[0]), Number(channels[1]), Number(channels[2])];
}

async function openLanding(
  size: { width: number; height: number },
  reducedMotion = false,
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' },
  ]);
  await page.bringToFront();
  await page.goto(`${origin}/landing.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => document.querySelector('h1') !== null,
    { timeout: 15_000 },
  );
  return page;
}

async function openPublic(
  frame: string,
  theme: Theme,
  size: { width: number; height: number },
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme.mode }]);
  await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
  const mode = await page.evaluate(() => document.documentElement.dataset.mode);
  if (mode !== theme.mode) {
    await page.close();
    throw new Error(`${frame}: expected ${theme.mode}, got ${String(mode)}`);
  }
  return page;
}

async function opaqueCanvasPixels(page: Page): Promise<number> {
  const handle = await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    const context = canvas?.getContext('2d');
    if (canvas === null || context === null || context === undefined || canvas.width === 0 || canvas.height === 0) return null;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) opaque += 1;
    }
    return opaque > 0 ? opaque : null;
  }, { polling: 100, timeout: 5_000 });
  return Number(await handle.jsonValue());
}

beforeAll(async () => {
  await withGallery(async (gallery) => {
    browser = gallery.browser;
    origin = gallery.origin;

    {
      const page = await openLanding(DESKTOP);
      const early = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      const later = await page.waitForFunction(
        (previous: string) => {
          const current = document.querySelector('h1')?.textContent ?? '';
          return current !== previous ? current : null;
        },
        { polling: 'raf', timeout: 15_000 },
        early,
      ).then((handle) => handle.jsonValue());
      facts.typed = { early, later: String(later) };
      await new Promise((resolve) => setTimeout(resolve, 1200));
      facts.canvasPixels = await opaqueCanvasPixels(page);
      await page.waitForSelector('canvas[data-settled="true"]', { timeout: 10_000 });
      facts.prunedNodes = await page.$eval('canvas', (canvas) => Number(canvas.dataset.pruned ?? 0));
      const settledTree = await page.$eval('canvas', (canvas) => canvas.toDataURL());
      const settledPhrase = await page.$eval('h1', (heading) => heading.textContent ?? '');
      await page.waitForFunction(
        (previous: string) => document.querySelector('h1')?.textContent !== previous,
        { polling: 100, timeout: 8_000 },
        settledPhrase,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      facts.treeFlows = await page.$eval('canvas', (canvas, first) => (
        canvas.dataset.settled === 'true' && canvas.toDataURL() !== first
      ), settledTree);

      const surfaces = await page.evaluate(() => {
        const measure = (element: Element | null): SurfaceFact => {
          const box = element?.getBoundingClientRect();
          return {
            present: element !== null,
            width: Math.round(box?.width ?? 0),
            height: Math.round(box?.height ?? 0),
            text: element?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          };
        };
        return {
          workspace: measure(document.querySelector('[aria-label="Kinu workspace interface preview"]')),
          tui: measure(document.querySelector('[aria-label="Kinu terminal interface preview"]')),
          cli: measure(document.querySelector('[aria-label="Kinu command line preview"]')),
        };
      });
      facts.workspace = surfaces.workspace;
      facts.tui = surfaces.tui;
      facts.cli = surfaces.cli;
      facts.command = await page.$eval(
        '[data-install-command]',
        (element) => element.textContent?.trim() ?? '',
      );
      facts.homeLink = await page.$eval('a[aria-label="Kinu home"]', (element) => ({
        visible: element.getClientRects().length > 0,
        hasGraphic: element.querySelector('svg') !== null,
      }));
      await page.click('button[aria-label="Copy install command"]');
      facts.copied = await page.waitForFunction(
        () => document.querySelector('button[aria-label="Copy install command"]')?.textContent?.trim() === 'Copied',
      ).then(() => true);
      facts.deploy = await page.evaluate(() => ({
        button: document.querySelector<HTMLAnchorElement>(
          '#deploy a[href^="https://deploy.workers.cloudflare.com"]',
        )?.href ?? null,
        guide: document.querySelector<HTMLAnchorElement>(
          '#deploy a[href*="SELF-HOSTING.md"]',
        )?.href ?? null,
      }));

      facts.contrast = await page.evaluate(() => {
        const samples = [
          ['hero title', 'h1'],
          ['hero body', '#top p'],
          ['feature title', '[data-feature-strip] > div > h3'],
          ['feature body', '[data-feature-strip] > div > p'],
          ['workspace heading', '[data-showcase="workspace"] h2'],
          ['workspace body', '[data-showcase="workspace"] p'],
          ['terminal body', '[data-showcase="tui"] p'],
          ['section title', '#platform h2'],
          ['section body', '#platform p'],
          ['primary action', '#top a[href="/login"]'],
        ] as const;
        const background = (node: Element): string => {
          for (let element: Element | null = node; element !== null; element = element.parentElement) {
            const colour = getComputedStyle(element).backgroundColor;
            if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        return samples.flatMap(([what, selector]) => {
          const element = document.querySelector(selector);
          if (element === null) return [];
          const style = getComputedStyle(element);
          return [{ what, ink: style.color, paper: background(element), size: parseFloat(style.fontSize) }];
        });
      }).then((rows) => rows.map((row) => ({
        what: row.what,
        size: row.size,
        ratio: contrastRatio(parseRgb(row.ink), parseRgb(row.paper)),
      })));
      await page.close();
    }

    {
      const page = await openLanding(DESKTOP, true);
      const before = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const after = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      facts.reduced = {
        before,
        after,
        pixels: await opaqueCanvasPixels(page),
        animations: await page.evaluate(
          () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
        ),
      };
      await page.close();
    }

    for (const [label, size] of LANDING_WIDTHS) {
      const page = await openLanding(size);
      facts.landingOverflow[label] = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const surfacesFit = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return [
          document.querySelector('[aria-label="Kinu workspace interface preview"]'),
          document.querySelector('[aria-label="Kinu terminal interface preview"]'),
          document.querySelector('[aria-label="Kinu command line preview"]'),
        ].every((element) => {
          const box = element?.getBoundingClientRect();
          return box !== undefined && box.left >= -1 && box.right <= viewport + 1;
        });
      });
      expect(surfacesFit, `landing@${label}: a preview left the viewport`).toBeTrue();
      if (label === '390') {
        facts.landingTargets = await page.evaluate(() => [
          ...document.querySelectorAll('#top a[href="/login"], #top a[href="#deploy"]'),
        ].map((element) => Math.round(element.getBoundingClientRect().height)));
      }
      if (label === '1568' || label === '1920') {
        facts.wideColumns[label] = await page.$eval(
          '[data-feature-strip]',
          (element) => Math.round(element.getBoundingClientRect().width),
        );
      }
      await page.close();
    }

    for (const frame of PUBLIC_FRAMES) {
      for (const theme of THEMES) {
        for (const [label, size] of [['390', PHONE], ['1280', DESKTOP]] as const) {
          const page = await openPublic(frame, theme, size);
          facts.publicOverflow[`${frame}@${theme.mode}@${label}`] = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (frame === 'login' && theme.mode === 'dark' && label === '390') {
            facts.publicTargets = await page.evaluate(() => [
              ...document.querySelectorAll('a.provider, a.btn, button'),
            ].filter((element) => element.getClientRects().length > 0)
              .map((element) => Math.round(element.getBoundingClientRect().height)));
          }
          if (frame === 'login' && theme.mode === 'dark' && label === '1280') {
            facts.providers = await page.evaluate(() => [
              ...document.querySelectorAll<HTMLAnchorElement>('a.provider'),
            ].map((element) => element.getAttribute('href') ?? ''));
            facts.loginLayout = await page.evaluate(() => {
              const viewportCenter = document.documentElement.clientWidth / 2;
              const card = document.querySelector('.card')?.getBoundingClientRect();
              const bar = document.querySelector('.bar-inner')?.getBoundingClientRect();
              return {
                dialog: document.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true',
                cardOffset: Math.abs((card?.left ?? 0) + (card?.width ?? 0) / 2 - viewportCenter),
                barOffset: Math.abs((bar?.left ?? 0) + (bar?.width ?? 0) / 2 - viewportCenter),
                footer: document.querySelector('footer') !== null,
              };
            });
          }
          await page.close();
        }
      }
    }
  });
}, 180_000);

describe('the standalone landing runs', () => {
  test('the claim changes in place and the canvas draws', () => {
    const typed = required(facts.typed, 'typed claim');
    expect(typed.early).not.toBe(typed.later);
    expect(required(facts.canvasPixels, 'canvas pixels')).toBeGreaterThan(20);
  });

  test('the settled graph keeps flowing without restarting its reveal', () => {
    expect(required(facts.treeFlows, 'settled tree motion')).toBeTrue();
  });

  test('the abstract tree keeps visibly pruned branches', () => {
    expect(required(facts.prunedNodes, 'pruned branch count')).toBeGreaterThan(20);
  });

  test('reduced motion serves one settled result', () => {
    const reduced = required(facts.reduced, 'reduced-motion page');
    expect(reduced.before).toBe(reduced.after);
    expect(reduced.before.length).toBeGreaterThan(12);
    expect(reduced.pixels).toBeGreaterThan(20);
    expect(reduced.animations).toBe(0);
  });

  test('the workspace, terminal, and CLI are visible and distinct', () => {
    const workspace = required(facts.workspace, 'workspace preview');
    const tui = required(facts.tui, 'terminal preview');
    const cli = required(facts.cli, 'CLI preview');
    for (const surface of [workspace, tui, cli]) {
      expect(surface.present).toBeTrue();
      expect(surface.width).toBeGreaterThan(500);
    }
    expect(workspace.height).toBeGreaterThan(600);
    expect(tui.height).toBeGreaterThan(600);
    expect(cli.height).toBeGreaterThan(150);
    expect(new Set([workspace.text, tui.text, cli.text]).size).toBe(3);
  });
});

describe('public actions work', () => {
  test('the install command uses this origin and copies', () => {
    expect(required(facts.command, 'install command')).toBe(
      `curl -fsSL '${origin}/install.sh' | bash`,
    );
    expect(facts.copied).toBeTrue();
  });

  test('the wordmark links home and has a visible graphic', () => {
    expect(required(facts.homeLink, 'home link')).toEqual({ visible: true, hasGraphic: true });
  });

  test('self-host actions reach the deploy flow and guide', () => {
    const deploy = required(facts.deploy, 'self-host links');
    expect(deploy.button).toBe(
      'https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu',
    );
    expect(deploy.guide).toContain('/docs/SELF-HOSTING.md');
  });

  test('each configured sign-in provider starts OAuth', () => {
    const providers = required(facts.providers, 'sign-in providers');
    expect(providers.length).toBeGreaterThan(0);
    for (const href of providers) expect(href).toMatch(/^\/auth\/[^/]+\/start/);
  });

  test('sign in is a centered modal under one centered header', () => {
    const layout = required(facts.loginLayout, 'sign-in layout');
    expect(layout.dialog).toBeTrue();
    expect(layout.cardOffset).toBeLessThanOrEqual(1);
    expect(layout.barOffset).toBeLessThanOrEqual(1);
    expect(layout.footer).toBeFalse();
  });
});

describe('public pages are responsive', () => {
  test('the landing fits every required viewport', () => {
    for (const [where, overflow] of Object.entries(facts.landingOverflow)) {
      expect(overflow, `landing@${where}`).toBeLessThanOrEqual(0);
    }
  });

  test('utility pages fit both colour modes', () => {
    for (const [where, overflow] of Object.entries(facts.publicOverflow)) {
      expect(overflow, where).toBeLessThanOrEqual(0);
    }
  });

  test('primary phone actions remain usable', () => {
    for (const height of required(facts.landingTargets, 'landing phone targets')) {
      expect(height).toBeGreaterThanOrEqual(36);
    }
    for (const height of required(facts.publicTargets, 'public phone targets')) {
      expect(height).toBeGreaterThanOrEqual(34);
    }
  });

  test('the wide landing keeps its intended measure', () => {
    for (const [where, width] of Object.entries(facts.wideColumns)) {
      expect(width, where).toBeGreaterThanOrEqual(1238);
      expect(width, where).toBeLessThanOrEqual(1242);
    }
  });
});

describe('rendered landing text is readable', () => {
  test('sampled roles meet WCAG AA on their actual surfaces', () => {
    expect(facts.contrast.length).toBeGreaterThanOrEqual(8);
    for (const { what, ratio, size } of facts.contrast) {
      expect(ratio, `${what} at ${String(size)}px`).toBeGreaterThanOrEqual(size >= 24 ? 3 : 4.5);
    }
  });
});
