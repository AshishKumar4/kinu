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

// The platform's `signal()` is the same task: a stop ends the container by an exec through the seam instead.
test('a box that stops ends its container by an exec, and asks the platform for no signal', async () => {
  const { box, container } = harness(TestDevbox);

  await box.devboxStartup();
  await box.stop();

  expect({ running: container.running.running, signals: container.platformSignals, unowned: container.unownedStdin })
    .toEqual({ running: false, signals: [], unowned: [] });
});
