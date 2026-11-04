// Durations handed to library waits on a chained receiver, through a bound options name, and as a locator's own bound.
import type { Page } from 'puppeteer';
import { vi } from 'vitest';

const SOON = { timeout: 15_000 } as const;

export async function ready(page: Page, rows: () => number): Promise<void> {
  await page.waitForSelector('[data-ready]', SOON);
  await page.locator('[data-ready]').setTimeout(15_000).click();
  await page.locator('[data-ready]').waitHandle({ ...SOON });
  await vi.waitFor(() => { if (rows() === 0) throw new Error('no rows'); }, { timeout: 30_000, interval: 250 });
}
