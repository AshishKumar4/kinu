// Explicit quiesce fences new work and drains commands that already own an admission.
import { describe, expect, test } from 'bun:test';

import { chainBox } from './support/chain-box';
import { gate } from './support/devbox-harness';

async function attachedWithWork() {
  const arm = chainBox();
  expect((await arm.box.attachNow()).kind).toBe('empty');
  await arm.box.writeFile('/workspace/before.txt', 'committed by the final checkpoint');

  return arm;
}

describe('quiesce joins concurrent stop requests behind admitted work', () => {
  test('both stops wait for the command and share its final commit', async () => {
    const { box, container } = await attachedWithWork();
    // The command is parked inside the container so it is still executing through the final
    // checkpoint; an immediate answer would make this the idle case below.
    const parked = gate();
    container.execGate = parked;
    const command = box.exec('true');
    await parked.reached;

    const first = box.quiesce();
    const second = box.quiesce();
    expect((await box.resolveReadiness()).kind).toBe('pending');
    parked.release();
    expect((await command).exitCode).toBe(0);
    const [one, two] = await Promise.all([first, second]);
    expect(one.kind).toBe('committed');
    expect(two).toEqual(one);
    expect(container.running.running).toBe(false);
  });

  test('an idle stop commits without renewing its own interaction lease', async () => {
    const { box, container } = await attachedWithWork();
    const stampedBefore = (await box.devboxState()).lastInteractionAt;

    const outcome = await box.quiesce();

    expect(outcome.kind).toBe('committed');
    expect(container.running.running).toBe(false);
    // The box's own storage work is not a caller: its final checkpoint must not stamp the lease.
    expect((await box.devboxState()).lastInteractionAt).toBe(stampedBefore);
  });
});
