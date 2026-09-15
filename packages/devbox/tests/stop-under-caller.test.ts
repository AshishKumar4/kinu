// The heartbeat decides to quiesce on the lease as it stood; the final
// checkpoint then runs for as long as the tree needs, and a caller admitted
// meanwhile is running on the container the stop is about to kill. Run
// `20260914234711` lost sqlite/1/1 and git/2/4 that way: `ensureReady` admitted
// each command three seconds before `OperationInterruptedError`.
import { describe, expect, test } from 'bun:test';

import { chainBox } from './support/chain-box';

async function attachedWithWork() {
  const arm = chainBox();
  expect((await arm.box.attachNow()).kind).toBe('empty');
  await arm.box.writeFile('/workspace/before.txt', 'committed by the final checkpoint');

  return arm;
}

describe('a caller arriving during the final checkpoint holds the stop', () => {
  test('the checkpoint stays committed, the stop is refused and the container keeps running', async () => {
    const { box, container } = await attachedWithWork();

    const stopping = box.quiesce();
    const command = await box.exec('true');
    const outcome = await stopping;

    expect(command.exitCode).toBe(0);
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/^the stop is refused: /) });
    expect(outcome.bytes).toEqual(expect.any(Number));
    expect(container.running.running).toBe(true);
  });

  test('the same stop with nobody arriving stops the container, so the hold above is not vacuous', async () => {
    const { box, container } = await attachedWithWork();

    const outcome = await box.quiesce();

    expect(outcome.kind).toBe('committed');
    expect(container.running.running).toBe(false);
  });
});
