/**
 * Setup's assistant step in a real browser (production walkthrough rc30 F1): it asks one thing, Set it up or Not now,
 * with its name as a quiet edit. No row of connections and no brief-time picker: what the assistant reaches and when it
 * briefs are its own defaults, changed later in its settings. Its face is drawn from the person's name, so a renamed
 * assistant keeps it, and two people's differ.
 */
import { describe, expect, test } from 'bun:test';

import type { Page } from 'puppeteer';

import { withGallery } from '../../scripts/gallery-harness';

const STEP = '[data-welcome-step="assistant"] [data-assistant-step]';

/** The step's presses and fields, by role (a field's tag where it has none), its lists, and its mascot's seed. */
function readStep(page: Page): Promise<{ controls: string[]; lists: number; mascot: string | null }> {
  return page.$eval(STEP, (root) => ({
    controls: [...root.querySelectorAll('input, button, select, textarea, [role="combobox"], [role="radio"], a[href]')]
      .filter((node) => !(node instanceof HTMLInputElement && node.type === 'hidden') && node.closest('[aria-hidden="true"]') === null)
      .map((node) => node.getAttribute('role') ?? node.tagName.toLowerCase()).sort(),
    lists: root.querySelectorAll('ul, ol').length,
    mascot: root.querySelector('[data-mascot]')?.getAttribute('data-mascot') ?? null,
  }));
}

async function openStep(page: Page, origin: string, query = ''): Promise<void> {
  await page.goto(`${origin}/gallery.html?frame=welcome&route=${encodeURIComponent('/welcome?step=assistant')}${query}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(STEP);
}

describe("setup's assistant step", () => {
  test('asks one question with its name beside it, and lists nothing to connect or schedule', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await openStep(page, origin);
      const step = await readStep(page);

      expect(step.lists).toBe(0);
      expect(step.controls).toEqual(['input', 'radio', 'radio']);
    });
  });

  test("wears a face from the person's name, kept when the assistant is renamed", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await openStep(page, origin);
      const before = (await readStep(page)).mascot;

      await page.click(`${STEP} input`, { count: 3 });
      await page.keyboard.type('Nova');
      const renamed = (await readStep(page)).mascot;

      const other = await newPage();

      await openStep(other, origin, '&noname=1');
      const someoneElse = (await readStep(other)).mascot;

      expect(before).not.toBeNull();
      expect(renamed).toBe(before);
      expect(someoneElse).not.toBe(before);
    });
  });
});
