// Quiesce decides on the lease as it stood; a caller admitted during the final checkpoint
// runs on the container the stop would kill, so the stop must re-check callers (D18).
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
    // The command is parked inside the container so it is still executing through the final
    // checkpoint; an immediate answer would make this the idle case below.
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
    // The box's own storage work is not a caller: its final checkpoint must not stamp the lease.
    expect((await box.devboxState()).lastInteractionAt).toBe(stampedBefore);
  });
});
