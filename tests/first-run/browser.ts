/**
 * Chrome for the rows that read what a DEPLOYED page draws.
 *
 * THE HEADER IS THE SIGN-IN. The deployment accepts the synthetic identity in
 * core's `DEV_IDENTITY_HEADER` and nowhere else — never as a cookie, deliberately — so
 * `setExtraHTTPHeaders` is what makes a page the same user the socket half of a
 * row acts as. Everything else is the product: its own bundle, its own socket,
 * its own render.
 */
import type { Browser, Page } from 'puppeteer';

import { declaredSettings } from '../../scripts/browser-declarations';
import { launchTestChrome, type TestChrome } from '../../scripts/test-chrome';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/session';

/** Chrome, with the pointer and colour scheme declared (`declaredSettings`), as
 *  the gallery and live-app harnesses launch it: it ends with the row's runner. */
export async function openBrowser(): Promise<TestChrome> {
  return launchTestChrome({ args: [declaredSettings({ mouse: true })] });
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
