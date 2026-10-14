/**
 * Images within one turn (D89): each step moves the screenshots past the latest few out to the agent's home, in
 * batches of four, each left as a link to its stored bytes, so a turn that looks step after step stays small and each
 * request between batches extends the last.
 */
import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { resolvePath } from '@kinu.run/core';
import { createTestRuntime } from '@kinu.run/test-utils';
import { createCompactionExtension } from '../src/extension';
import { KEEP_RECENT_IMAGES } from '../src/attachments';
import { memoryArchive, memoryPorts, screenshot, screenshotSteps, sentScreens, type compactedScreenshots } from './helpers';

/** The compaction extension over `rt`'s files, and its step pass over a turn that made `calls` screenshot calls. */
function stepsOver(rt: Parameters<typeof compactedScreenshots>[0], calls = 20) {
  const extension = createCompactionExtension({
    ports: memoryPorts(), archive: memoryArchive(), ephemeral: { dropSuperseded: () => 0 },
    summarize: () => { throw new Error('a step summarizes nothing'); },
    attachments: { files: () => rt },
  });

  const turn = async (): Promise<void> => {
    await extension.onTurnStart?.({ system: 'system prompt', history: [] });

    for (let n = 0; n < calls; n += 1) await extension.onToolCall?.({ toolName: 'browser', toolCallId: `shot_${String(n)}`, args: {} });
  };

  const step = async (messages: ModelMessage[]): Promise<ModelMessage[]> => (await extension.prepareStep?.({ stepNumber: 1, messages })) ?? messages;

  return { extension, turn, step };
}

test('a step keeps the latest few screenshots and moves the older ones out in fours, each a link to its stored bytes', async () => {
  const { rt } = createTestRuntime();
  const { turn, step } = stepsOver(rt);

  await turn();

  // However many the turn took: the oldest leave in whole fours, and the latest few, and fewer than four more, stay.
  for (let taken = 1; taken <= 16; taken += 1) {
    const kept = sentScreens(await step(screenshotSteps(taken))).map((entries) => entries.includes('image'));
    const moved = kept.indexOf(true) === -1 ? kept.length : kept.indexOf(true);

    expect({ taken, oldestFirst: kept.slice(moved).every(Boolean), wholeFours: moved % 4, enough: kept.length - moved >= Math.min(taken, KEEP_RECENT_IMAGES), fewerThanAFour: kept.length - moved < KEEP_RECENT_IMAGES + 4 })
      .toEqual({ taken, oldestFirst: true, wholeFours: 0, enough: true, fewerThanAFour: true });
  }

  const screens = sentScreens(await step(screenshotSteps(KEEP_RECENT_IMAGES + 4)));
  const links = screens.flatMap((entries) => entries.flatMap((entry) => /^\[image\/png 1280x800 -> (vfs:\/\/\S+)\]$/u.exec(entry)?.[1] ?? []));

  expect(links).toHaveLength(4);
  expect(Buffer.from(await rt.storage.vfs.readFile(resolvePath(links[0] ?? '', rt.planes).absolute)).toString('base64')).toBe(screenshot(0));
});

test('between batches a step\'s request extends the last: what moved is the same bytes, and nothing is stored again', async () => {
  const { rt } = createTestRuntime();
  const { extension, turn, step } = stepsOver(rt);

  await turn();
  // The first batch moves at this step; the next step adds one screenshot and moves nothing new.
  const first = await step(screenshotSteps(KEEP_RECENT_IMAGES + 4));
  const again = extension.prepareStep?.({ stepNumber: 2, messages: screenshotSteps(KEEP_RECENT_IMAGES + 5) });

  // Stored already: the pass answers at once, with the moved prefix exactly as the last request sent it.
  if (again === undefined || again instanceof Promise) throw new Error('a stored batch answered later, or not at all');
  expect(JSON.stringify(again.slice(0, first.length))).toBe(JSON.stringify(first));
});

test('only what this turn\'s calls returned moves: an earlier turn\'s screenshots stay the ladder\'s to move', async () => {
  const { rt } = createTestRuntime();
  const earlier = stepsOver(rt, 0);
  const later = stepsOver(rt, 13);

  await earlier.turn();
  await later.turn();

  // The same 13 screenshots: none from this turn's calls, then all of them.
  const inline = async (steps: typeof earlier): Promise<number> => (await steps.step(screenshotSteps(13)).then(sentScreens)).filter((entries) => entries.includes('image')).length;

  expect(await inline(earlier)).toBe(13);
  expect(await inline(later)).toBeLessThan(KEEP_RECENT_IMAGES + 4);
});
