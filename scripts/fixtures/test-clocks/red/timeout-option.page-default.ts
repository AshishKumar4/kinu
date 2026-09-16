// The page's own default, raised rather than disabled.
import type { Page } from 'puppeteer';

export function open(page: Page): void {
  page.setDefaultTimeout(60_000);
}
