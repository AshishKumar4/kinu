/**
 * The CI tier's one row through the real dev stack: `vite dev` boots the product, a workspace is made, and its root
 * agent answers a turn, which loads the root's own isolate from the agent bundle over the dev server's ASSETS. The
 * deploy's live-app rows drive the same path at length; this row is the answered one alone, so a push learns that the
 * root's isolate does not load under the dev stack before a deploy does (the 2026-10-10 staging deploy of 26244c765,
 * every live-app row red on a 403 for the bundle).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-root-turn', ['answered']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

test("a workspace's root agent answers a turn under the dev stack, and the answer stands after a reload", () => {
  const { ended, reloaded } = verdictOf(observed.answered, 'answered');

  expect(ended.at(-1)).toBe('P:Done.');
  expect(reloaded).toEqual(ended);
});
