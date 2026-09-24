/**
 * Chrome for the rows that read what a DEPLOYED page draws.
 *
 * THE HEADER IS THE SIGN-IN. The deployment accepts the synthetic identity in
 * core's `DEV_IDENTITY_HEADER` and nowhere else — never as a cookie, deliberately — so
 * `setExtraHTTPHeaders` is what makes a page the same user the socket half of a
 * row acts as. Everything else is the product: its own bundle, its own socket,
 * its own render.
 */
import puppeteer, { type Browser, type LaunchOptions, type Page } from 'puppeteer';

import { webHeaders, type PublicWebIdentity } from '../evals/public-session';

/** Chrome, with the pointer declared. Headless reports no pointing device, so
 *  every `hover:` utility the product emits is dead and a card can render
 *  differently than it does for a person — the gallery harness makes the same
 *  declaration for the same reason. */
export async function openBrowser(): Promise<Browser> {
  const options: LaunchOptions = {
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
    ],
  };

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH;

  if (executablePath !== undefined && executablePath.length > 0) options.executablePath = executablePath;

  return puppeteer.launch(options);
}

/** A page signed in as `identity`, the same authority the row's sockets use, so
 *  the two halves cannot be two users looking at two workspaces. No default
 *  timeout: each wait on it states its own bound, or the case budget ends it. */
export async function signedInPage(browser: Browser, identity: PublicWebIdentity): Promise<Page> {
  const page = await browser.newPage();
  const headers = webHeaders(identity);

  if (Object.keys(headers).length > 0) await page.setExtraHTTPHeaders(headers);
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(0);

  return page;
}
