// staging rc29, 2026-10-21: an exec given no stdin leaves workerd a stdin to end as a task nobody can await, and on a
// lost connection that task failed the box's request as an uncaught "Network connection lost.". Every exec the box
// sends owns its stdin (`containerExec`): a start, with its golden, trust and readiness execs, sends none without one.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';

import { harness } from './support/devbox-harness';

test('a box that starts sends no exec whose stdin the platform must end', async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();

  expect(container.unownedStdin).toEqual([]);
});
