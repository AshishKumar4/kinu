/**
 * The gadget sandbox, measured in a real browser.
 *
 * `gallery.tsx`'s `?frame=gadget` mounts the production GadgetFrame over a
 * fixture client that probes its own containment: a network fetch, the host
 * document, and the one allowed call back out over the bridge. What the gate
 * asserts is the whole posture, and none of it is visible to a
 * source-reading instrument: the iframe's exact sandbox token, the
 * document's exact content policy, the three probe outcomes the fixture
 * wrote into its own document, and the one console line the fixture wrote,
 * read where the owner reads it: in the host document under the frame.
 *
 * The probe renders inside the sandboxed document at the opaque origin, so
 * the page's own context cannot read it; the gate reads it through the
 * frame's own context. The console line is read from the page, because
 * that is the hop under test.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { TimeoutError, type Browser, type Page } from 'puppeteer';

import { withGallery } from './gallery-harness';

// Both spelled out here rather than imported from gadget-document.ts: a gate
// that compares the mounted attribute to the constant it was mounted from
// passes whatever either says. These two strings are the posture §1.1 of
// docs/LIVE-UI.md quotes from the reference, and a change to either is a
// change to the trust boundary that has to be made here as well.
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
const CSP = "default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; "
  + "img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';";

async function openFrame(browser: Browser, origin: string): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.setViewport({ width: 720, height: 800 });
  await page.goto(`${origin}/gallery.html?frame=gadget`, { waitUntil: 'networkidle0' });
  return page;
}

interface Observed {
  readonly sandbox: string | null;
  readonly csp: string | null;
  readonly fetch: string | null;
  readonly parent: string | null;
  readonly rpc: string | null;
  /** The console rows the host document shows for the frame, in order. */
  readonly console: readonly string[];
}

/** The frame's console rows in the host document. The line crosses a
 *  postMessage and a React render after the probe element lands, so the page
 *  is watched for the row; none within five seconds is a finding, and any
 *  other failure of the watch propagates. */
async function consoleRows(page: Page): Promise<string[]> {
  try {
    await page.waitForSelector('[data-gadget-console] li', { timeout: 5_000 });
  } catch (error) {
    if (error instanceof TimeoutError) return [];
    throw error;
  }
  return page.$$eval('[data-gadget-console] li', (rows) => rows.map((row) => row.textContent ?? ''));
}

async function observe(browser: Browser, origin: string): Promise<Observed> {
  const page = await openFrame(browser, origin);
  try {
    const sandbox = await page.$eval('iframe', (el) => el.getAttribute('sandbox'));
    const handle = await page.$('iframe');
    if (!handle) throw new Error('the gadget frame rendered no iframe element');
    const frame = await handle.contentFrame();
    if (!frame) throw new Error('the gadget iframe has no content frame');
    await frame.waitForSelector('[data-gadget-probe]', { timeout: 30_000 });
    const probe = await frame.$eval('[data-gadget-probe]', (el) => ({
      fetch: el.getAttribute('data-fetch'),
      parent: el.getAttribute('data-parent'),
      rpc: el.getAttribute('data-rpc'),
    }));
    const csp = await frame.$eval(
      'meta[http-equiv="Content-Security-Policy"]',
      (el) => el.getAttribute('content'),
    );
    return { sandbox, csp, ...probe, console: await consoleRows(page) };
  } finally {
    await page.close();
  }
}

let observed: Observed;
beforeAll(async () => {
  observed = await withGallery(async ({ browser, origin }) => observe(browser, origin));
}, 600_000);

describe('the gadget sandbox', () => {
  test('the iframe carries exactly the sandbox token', () => {
    expect(observed.sandbox).toBe(SANDBOX);
  });

  test('the document carries exactly the content policy', () => {
    expect(observed.csp).toBe(CSP);
  });

  test('a fetch cannot leave the client', () => {
    expect(observed.fetch).toBe('blocked');
  });

  test('the host document is unreachable', () => {
    expect(observed.parent).toBe('blocked');
  });

  test('the one allowed call answers through the bridge', () => {
    expect(observed.rpc).toBe('echo:ping');
  });

  test('a console line the client writes reaches the host document', () => {
    expect(observed.console).toEqual(['error probe: console reaches the host']);
  });
});
