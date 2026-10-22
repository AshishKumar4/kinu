/**
 * Environment says what is missing and what brings it back in few words (MA-243): each absence's title and its line,
 * and the terminal's own bar, under twelve words each.
 */
import { describe, expect, test } from 'bun:test';

import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';

const UNDER = 12;

/** Every piece of copy over the limit, as `words: text`. */
function overLimit(texts: readonly string[]): string[] {
  return texts.map((text) => text.trim()).filter((text) => text.split(/\s+/u).length >= UNDER).map((text) => `${String(text.split(/\s+/u).length)}: ${text}`);
}

/** The shown absence's title and line. */
function absence(page: Page): Promise<string[]> {
  return page.$eval('[data-env-absence]', (shown) => [...shown.querySelectorAll('p')].map((line) => line.textContent ?? ''));
}

async function openMachine(page: Page, origin: string, query: string, machine: string): Promise<void> {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${origin}/gallery.html?frame=workspaceshell&env=computer&${query}`, { waitUntil: 'networkidle0' });
  await (await page.waitForSelector('button[aria-label="Environment"]'))?.click();
  await (await page.waitForSelector(`[data-env-card="${machine}"] button`))?.click();
}

describe("Environment's absences and its terminal's bar", () => {
  test('each says its part in under twelve words', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const said: string[] = [];

      const offline = await newPage();
      await openMachine(offline, origin, 'pc=offline', 'device');
      await offline.waitForSelector('[data-env-absence]');
      said.push(...await absence(offline));

      const permission = await newPage();
      await openMachine(permission, origin, 'pc=granted&pcdesktop=permission', 'device');
      await permission.waitForSelector('[role="tab"]');
      await permission.$$eval('[role="tab"]', (tabs) => {
        const desktop = tabs.find((tab) => tab.textContent?.trim() === 'Desktop');

        if (!(desktop instanceof HTMLElement)) throw new Error('no Desktop tab');
        desktop.click();
      });
      await permission.waitForSelector('[data-env-absence]');
      said.push(...await absence(permission));

      const computer = await newPage();
      await openMachine(computer, origin, '', 'computer');
      await computer.waitForSelector('[data-terminal-state]');
      said.push(await computer.$eval('[data-terminal-bar]', (bar) => (bar instanceof HTMLElement ? bar.innerText : '').replace(/\s+/gu, ' ')));

      expect(said.length).toBe(5);
      expect(overLimit(said)).toEqual([]);
    });
  });
});
