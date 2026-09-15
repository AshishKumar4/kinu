// A wait written outside the corpus, handed a duration.
import type { Page } from 'puppeteer';

export async function ready(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: 'networkidle0', timeout: 90_000 });
  await page.waitForSelector('[data-ready]', { timeout: 10_000 });
  await page.waitForFunction(() => document.title !== '', { polling: 50, timeout: 10_000 });
}
