/**
 * A press on the inspector's tools strip is the reader's, and the tab the strip opened on never takes it back. Staging
 * rc20 (2026-10-19, live-memory): the Agent press left Files current, its button still the strip's. The tabs' presence
 * had just landed the strip on Files, and that landing was written back after the press.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';

import { settled } from '../../scripts/browser-page';
import { withGallery } from '../../scripts/gallery-harness';

const CURRENT = `[...document.querySelectorAll('nav[aria-label="Workspace"] button[aria-current="true"]')].map((tool) => tool.getAttribute('aria-label'))`;

/**
 * The presence arrives, from a timer as a socket's answer does, and the strip lands on Files: Work holds nothing. Agent
 * is pressed the moment Files is drawn current, before anything else runs, and what was current then is returned.
 */
const PRESS_AS_PRESENCE_LANDS = `new Promise((pressed) => {
  const strip = document.querySelector('nav[aria-label="Workspace"]');
  const observer = new MutationObserver(() => {
    const before = ${CURRENT};
    if (before.length === 0) return;
    observer.disconnect();
    strip.querySelector('button[aria-label="Agent"]').click();
    pressed(before);
  });
  observer.observe(strip, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'] });
  window.__presenceArrives({ explorations: false, work: false });
})`;

test("a press that comes as the tabs' presence lands the strip stays the reader's", async () => {
  await withGallery(async ({ newPage, origin }) => {
    const page = await newPage();

    await page.setViewport({ width: 900, height: 900 });
    await page.goto(`${origin}/gallery.html?frame=work&presence=late`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('nav[aria-label="Workspace"] button[aria-label="Agent"]');

    const before = v.parse(v.array(v.nullable(v.string())), await page.evaluate(PRESS_AS_PRESENCE_LANDS));

    await settled(page, `JSON.stringify(${CURRENT})`);

    expect({ before, after: await page.evaluate(CURRENT) }).toEqual({ before: ['Files'], after: ['Agent'] });
    await page.close();
  });
});
