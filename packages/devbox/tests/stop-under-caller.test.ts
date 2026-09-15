// The heartbeat decides to quiesce on the lease as it stood; the final
// checkpoint then runs for as long as the tree needs, and a caller admitted
// meanwhile is running on the container the stop is about to kill. Run
// `20260914234711` lost sqlite/1/1 and git/2/4 that way: `ensureReady` admitted
// each command three seconds before `OperationInterruptedError`.
import { describe, expect, test } from 'bun:test';

import { chainBox } from './support/chain-box';
import { gate } from './support/devbox-harness';

async function attachedWithWork() {
  const arm = chainBox();
  expect((await arm.box.attachNow()).kind).toBe('empty');
  await arm.box.writeFile('/workspace/before.txt', 'committed by the final checkpoint');

  return arm;
}

describe('a caller arriving during the final checkpoint holds the stop', () => {
  test('the checkpoint stays committed, the stop is refused and the container keeps running', async () => {
    const { box, container } = await attachedWithWork();
    // The caller's command is admitted and then PARKED inside the container,
    // so it is still executing through the whole final checkpoint; a fake
    // that answered in the same tick would have the caller done before the
    // decision, which is the idle case below.
    const parked = gate();
    container.execGate = parked;
    const command = box.exec('true');
    await parked.reached;

    const outcome = await box.quiesce();
    parked.release();

    expect((await command).exitCode).toBe(0);
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/^the stop is refused: /) });
    expect(outcome.bytes).toEqual(expect.any(Number));
    expect(container.running.running).toBe(true);
  });

  test('the same stop with nobody arriving stops the container, so the hold above is not vacuous', async () => {
    const { box, container } = await attachedWithWork();
    const stampedBefore = (await box.devboxState()).lastInteractionAt;

    const outcome = await box.quiesce();

    expect(outcome.kind).toBe('committed');
    expect(container.running.running).toBe(false);
    // THE BOX'S OWN STORAGE WORK IS NOT A CALLER. The final checkpoint once
    // counted its upper through the public `listFiles`, whose readiness gate
    // stamps the lease, and refused its own stop as a caller's arrival.
    expect((await box.devboxState()).lastInteractionAt).toBe(stampedBefore);
  });
});
