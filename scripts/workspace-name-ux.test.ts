/**
 * A workspace shows its NAME, and keeps its slug where a slug is the answer.
 *
 * The owner installed Kinu and was shown `handwrought-walnut-4166c321` as the
 * title of his workspace. His ruling: that string is a fine unique id, and it is
 * not a name. A workspace is titled by its first prompt, so every account spends
 * its first minutes in the state this gate renders — no title at all — and what
 * the sidebar did with that state was print the address.
 *
 * Only a browser can answer this one. The fallback is a rendered decision inside
 * a component tree with a router, a roster hook and a live socket around it, and
 * every non-browser instrument in this repo reads the source rather than the
 * text a person ends up looking at. Two facts, measured on the real cascade:
 *
 *   - No rendered TEXT in the sidebar spells the slug. Not the row, not a title
 *     attribute, not a screen-reader label.
 *   - The row's own href still carries it, because that is the address the
 *     click resolves and the id anyone debugging needs.
 *
 * The fixture row is `gallery.tsx`'s `/api/user/workspaces` entry with an empty
 * `displayName` — the shape the registry really returns before a first prompt.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery } from './gallery-harness';

/** The owner's own workspace slug, spelled here so a failure quotes the string
 *  he was shown rather than a placeholder. */
const SLUG = 'handwrought-walnut-4166c321';

/** What an unnamed workspace reads as, inline: this gate reads the rendered
 *  words from the page and the placeholder, so it is the one user-facing
 *  check and not a mirrored file-scope constant. `Untitled`, not `New`: a
 *  workspace nobody has named is still unnamed a month later. */
const UNTITLED = 'Untitled workspace';

/** Everything the sidebar renders about one workspace row. */
interface SidebarRow {
  /** The row's link target — the address, which SHOULD carry the slug. */
  href: string;
  /** Visible text, collapsed. */
  text: string;
  /** Every attribute a person or a screen reader can read off this row and its
   *  controls: `title` and `aria-label`, which is where a slug hides from a
   *  text-only assertion. */
  labels: string[];
}

async function readSidebar(page: Page): Promise<SidebarRow[]> {
  return page.evaluate(() => {
    const rows: SidebarRow[] = [];

    for (const item of document.querySelectorAll('aside li')) {
      const link = item.querySelector('a[href^="/workspace/"]');

      if (!link) continue;
      const labels: string[] = [];

      for (const node of [item, ...item.querySelectorAll('*')]) {
        for (const attribute of ['title', 'aria-label']) {
          const value = node.getAttribute(attribute);

          if (value) labels.push(value);
        }
      }

      rows.push({
        href: link.getAttribute('href') ?? '',
        text: (item.textContent ?? '').replace(/\s+/g, ' ').trim(),
        labels,
      });
    }

    return rows;
  });
}

describe('the workspace sidebar names a workspace and addresses it separately', () => {
  let rows: SidebarRow[];
  let untitled: SidebarRow | undefined;

  beforeAll(async () => {
    rows = await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=shell`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('aside a[href^="/workspace/"]');

      return readSidebar(page);
    });
    untitled = rows.find((row) => row.href === `/workspace/${SLUG}`);
    // A vite build and a chromium launch, the same bound its sibling gates
    // state: bun's default 5 s hook deadline is shorter than a cold build.
  }, 240_000);

  test('the fixture really renders the untitled row (guards the guard)', () => {
    // A row nobody rendered is absent from every assertion below and proves
    // nothing, so its presence is asserted before its contents.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(untitled).toBeDefined();
  });

  test('an untitled workspace reads as untitled, never as its slug', () => {
    expect(untitled?.text).toContain(UNTITLED);
    expect(untitled?.text).not.toContain(SLUG);
  });

  test('no control on the row hides the slug in a label a reader would hear', () => {
    for (const label of untitled?.labels ?? []) expect(label).not.toContain(SLUG);
    // The rename, settings and remove controls each name the workspace; with an
    // empty title they would otherwise name nothing at all.
    expect(untitled?.labels.some((label) => label.includes(UNTITLED))).toBe(true);
  });

  test('the address is still the slug, because that is what a click resolves', () => {
    expect(untitled?.href).toBe(`/workspace/${SLUG}`);
  });

  test('a titled workspace is untouched — it shows its own name', () => {
    const titled = rows.find((row) => row.href === '/workspace/checkout-fixes');
    expect(titled?.text).toContain('Checkout coupon bug');
    expect(titled?.text).not.toContain(UNTITLED);
  });
});

describe('the workspace frame names an untitled workspace the same way', () => {
  // The sidebar gate above cannot see the workspace bar: it is rendered by
  // WorkspacePage from the agent snapshot's displayName, not the roster row,
  // and a fix that only patched the list would leave the defect standing the
  // moment a person opened the workspace itself.
  let headerText: string;
  let headerLabels: string[];
  let renamePlaceholder: string | null;

  beforeAll(async () => {
    ({ headerText, headerLabels, renamePlaceholder } = await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspacepage&ws=${SLUG}`, { waitUntil: 'networkidle0' });

      // The title is a button that opens the rename field; wait for the text.
      await page.waitForFunction(
        (untitled) => document.body.innerText.includes(untitled),
        { timeout: 60_000 }, UNTITLED,
      );

      const partial = await page.evaluate(() => {
        const labels: string[] = [];

        for (const node of document.querySelectorAll('[title], [aria-label]')) {
          for (const attribute of ['title', 'aria-label']) {
            const value = node.getAttribute(attribute);

            if (value) labels.push(value);
          }
        }

        return { headerText: document.body.innerText.replace(/\s+/g, ' '), headerLabels: labels };
      });

      // The blank rename field hints the shared untitled label: click the
      // title button and read the input it opens. Static markup never
      // opens it, so only the browser can pin this half of the contract.
      await page.evaluate((untitled: string) => {
        const title = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(untitled));
        title?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, UNTITLED);
      await page.waitForSelector('input[placeholder]', { timeout: 60_000 });
      const renamePlaceholder = await page.$eval('input[placeholder]', (input) => input.getAttribute('placeholder'));

      return { ...partial, renamePlaceholder };
    }));
  }, 240_000);
  test('the workspace frame says Untitled workspace, never the slug', () => {
    expect(headerText).toContain(UNTITLED);
    expect(headerText).not.toContain(SLUG);
  });

  test('no tooltip or reader label hides the slug either', () => {
    for (const label of headerLabels) expect(label).not.toContain(SLUG);
  });

  test('the blank rename field hints the shared untitled label', () => {
    expect(renamePlaceholder).toBe(UNTITLED);
  });
});

describe('the Workspaces page roster names an untitled workspace the same way', () => {
  // The sidebar and the workspace frame each have their pin above; the
  // Workspaces page draws the row through a THIRD path — WorkspaceOverviewCard's
  // line and tile — and a fix that reached only the first two leaves the
  // defect standing on the page that lists every workspace the account owns.
  let text: string;

  beforeAll(async () => {
    text = await withGallery(async ({ browser, origin }) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=workspaces`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(`a[href="/workspace/${SLUG}"]`);

      return page.evaluate((slug) => {
        const row = document.querySelector(`a[href="/workspace/${slug}"]`);

        return (row?.textContent ?? '').replace(/\s+/g, ' ').trim();
      }, SLUG);
    });
  }, 240_000);

  test('the roster row reads Untitled workspace, never the slug', () => {
    expect(text).toContain(UNTITLED);
    expect(text).not.toContain(SLUG);
  });
});
