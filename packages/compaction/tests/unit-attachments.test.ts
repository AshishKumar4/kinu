/**
 * The attachment rung (better-compact 0.3.0): a run of screenshots compacts by moving the older images out to the
 * agent's home, each left as a link to the stored bytes. The file tool reading one back on each backend is pinned
 * where each backend's planes are real (cf-backend unit-attachment-links, cli-backend cwd-plane).
 */
import { expect, test } from 'bun:test';
import { resolvePath } from '@kinu.run/core';
import { createTestRuntime } from '@kinu.run/test-utils';
import { compactedScreenshots, screenshot } from './helpers';

test('20 screenshots compact by the rung alone, each moved-out image a link to its stored bytes', async () => {
  const { rt } = createTestRuntime();
  const { screens, links } = await compactedScreenshots(rt);

  expect({ kept: screens.filter((entries) => entries.includes('image')).length, links: links.length })
    .toEqual({ kept: 2, links: 18 });

  expect(Buffer.from(await rt.storage.vfs.readFile(resolvePath(links[0] ?? '', rt.planes).absolute)).toString('base64')).toBe(screenshot(0));
});
