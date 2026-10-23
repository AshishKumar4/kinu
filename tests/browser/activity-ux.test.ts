/**
 * A workspace's activity (1018-xao, Muse's activity log): tapping the assistant on Home opens what it did, turn by turn,
 * newest first, each with what set it off and what it changed, and what it looks at next. Read from its own chat and
 * triggers; the gallery's assistant has a person's ask, a mail it answered and its morning brief today.
 */
import { describe, expect, test } from 'bun:test';

import { withGallery } from '../../scripts/gallery-harness';

describe("the assistant's activity", () => {
  test("opens from Home's bar and lists its turns with their causes and changes, and what is next", async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await newPage();

      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${origin}/gallery.html?frame=assistant-home`, { waitUntil: 'networkidle0' });
      await page.click('[data-focus-identity]');
      await page.waitForSelector('[data-activity-entry]');

      const seen = await page.$$eval('[data-activity-entry]', (rows) => rows.map((row) => ({
        cause: row.getAttribute('data-cause'),
        did: row.querySelector('[data-activity-did]')?.textContent ?? '',
        changed: [...row.querySelectorAll('[data-activity-changed] li')].map((change) => change.textContent ?? ''),
      })));

      const upcoming = await page.$$eval('[data-activity-upcoming] li', (rows) => rows.length);

      expect(seen.slice(0, 3).map((entry) => entry.did)).toEqual(['Started API Worker v2 release', 'Drafted a reply to Priya', "Wrote this morning's brief"]);
      expect(seen.slice(0, 3).map((entry) => entry.cause)).toEqual(['you', 'event', 'event']);
      expect(seen[0]?.changed).toEqual(['agent.createWorkspace, mail.saveDraft']);
      expect(seen[2]?.changed).toEqual([]);
      expect(upcoming).toBe(3);
      // Its workspace's overview, one quiet link from the header.
      expect(await page.$eval('[data-activity-overview]', (link) => link.getAttribute('href'))).toBe('/workspace/personal-assistant/overview');
    });
  });
});
