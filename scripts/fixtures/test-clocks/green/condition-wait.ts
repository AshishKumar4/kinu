// Every wait ends on its condition; the disabled value is the one option.
import type { Page } from 'puppeteer';

export async function ready(page: Page, origin: string): Promise<void> {
  page.setDefaultTimeout(0);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-ready]', { timeout: 0 });
  await page.waitForFunction(() => document.title !== '', { polling: 50 });
}
