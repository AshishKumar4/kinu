/**
 * Images within one turn (D89): each step moves the screenshots past the latest two out to the agent's home, in
 * batches of four, each left as a link to its stored bytes, so a turn that looks step after step stays small and each
 * request between batches extends the last.
 */
import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { resolvePath } from '@kinu.run/core';
import { createTestRuntime } from '@kinu.run/test-utils';
import { createCompactionExtension } from '../src/extension';
import { memoryArchive, memoryPorts, screenshot, screenshotSteps, sentScreens, type compactedScreenshots } from './helpers';

/** The compaction extension over `rt`'s files, and its step pass. */
function stepsOver(rt: Parameters<typeof compactedScreenshots>[0]) {
  const extension = createCompactionExtension({
    ports: memoryPorts(), archive: memoryArchive(), ephemeral: { dropSuperseded: () => 0 },
    summarize: () => { throw new Error('a step summarizes nothing'); },
    attachments: { files: () => rt },
  });

  const step = async (messages: ModelMessage[]): Promise<ModelMessage[]> => (await extension.prepareStep?.({ stepNumber: 1, messages })) ?? messages;

  return { extension, step };
}

test('a step keeps the latest two screenshots and moves the older ones out in fours, each a link to its stored bytes', async () => {
  const { rt } = createTestRuntime();
  const { step } = stepsOver(rt);

  const moved = async (steps: number): Promise<number> => (await step(screenshotSteps(steps)).then(sentScreens)).filter((entries) => !entries.includes('image')).length;

  expect(await Promise.all([1, 5, 6, 9, 10, 13].map(moved))).toEqual([0, 0, 4, 4, 8, 8]);

  const screens = sentScreens(await step(screenshotSteps(10)));
  const links = screens.flatMap((entries) => entries.flatMap((entry) => /^\[image\/png 1280x800 -> (vfs:\/\/\S+)\]$/u.exec(entry)?.[1] ?? []));

  expect(screens.map((entries) => entries.includes('image'))).toEqual([false, false, false, false, false, false, false, false, true, true]);
  expect(Buffer.from(await rt.storage.vfs.readFile(resolvePath(links[0] ?? '', rt.planes).absolute)).toString('base64')).toBe(screenshot(0));
});

test('between batches a step\'s request extends the last: what moved is the same bytes, and nothing is stored again', async () => {
  const { rt } = createTestRuntime();
  const { extension, step } = stepsOver(rt);

  await extension.onTurnStart?.({ system: 'system prompt', history: [] });
  const first = await step(screenshotSteps(6));
  const again = extension.prepareStep?.({ stepNumber: 2, messages: screenshotSteps(7) });

  // Stored already: the pass answers at once, with the moved prefix exactly as the last request sent it.
  if (again === undefined || again instanceof Promise) throw new Error('a stored batch answered later, or not at all');
  expect(JSON.stringify(again.slice(0, first.length))).toBe(JSON.stringify(first));
});
