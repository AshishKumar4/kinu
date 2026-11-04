// Durations handed to browser waits through a bound options name, spread or not, and as a locator's own bound.
import type { Page } from 'puppeteer';

const SOON = { timeout: 15_000 } as const;

export async function ready(page: Page): Promise<void> {
  await page.waitForSelector('[data-ready]', SOON);
  await page.locator('[data-ready]').setTimeout(15_000).click();
  await page.waitForFunction(() => document.title !== '', { ...SOON });
}
