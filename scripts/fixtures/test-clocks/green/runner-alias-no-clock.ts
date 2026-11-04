// The repair: the alias registers the case with no duration, and the waits carry none or disable a spread one.
import type { Page } from 'puppeteer';
import { test } from 'vitest';

const liveTest = test.skipIf(process.env.KINU_EVAL_ORIGIN === undefined);

const OPTIONS = { visible: true } as const;

const BOUNDED = { visible: true, timeout: 15_000 } as const;

liveTest('MEASURED: a case', async () => { await Promise.resolve(); });

export async function ready(page: Page): Promise<void> {
  await page.waitForSelector('[data-ready]', OPTIONS);
  await page.waitForSelector('[data-ready]', { ...BOUNDED, timeout: 0 });
  await page.locator('[data-ready]').setTimeout(0).click();
}
