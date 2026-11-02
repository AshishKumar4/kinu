import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import { evidenceDir } from '@kinu.run/test-utils';
import type { Gallery } from './gallery-harness';

export type UiMode = 'light' | 'dark';

/** A gallery frame in `mode` at `width`, as a reader opens it. */
export async function openUiScene(gallery: Gallery, query: string, mode: UiMode, width: number): Promise<Page> {
  const page = await gallery.newPage();

  await page.setViewport({ width, height: width < 768 ? 844 : 900 });
  await page.evaluateOnNewDocument((chosen) => localStorage.setItem('theme', chosen), mode);
  await page.goto(`${gallery.origin}/gallery.html?frame=${query}`, { waitUntil: 'networkidle0' });

  return page;
}

/** The page photographed whole once its fonts and finite animations settle, into `evidenceDir('ui-shell-presentation')`. */
export async function captureUiScene(page: Page, name: string, phase: 'before' | 'after' | 'observed' = 'observed'): Promise<string> {
  const directory = evidenceDir('ui-shell-presentation');

  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${phase}-${name}.png`);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path, fullPage: true });

  return path;
}
