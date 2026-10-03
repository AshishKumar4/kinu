// A read of a box's state starts nothing and arms nothing: `devboxState()` armed the startup, so reading a
// box at rest restarted its container within a second, and every bench poll after a rest woke the box it asked about.
import { expect, test } from 'bun:test';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, harness } from './support/devbox-harness';

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

const armed = (container: { readonly scheduleRows: readonly { readonly callback: string }[] }) =>
  container.scheduleRows.map(row => row.callback);

test('reading the state of a box at rest, and of one whose object reset since, starts nothing', async () => {
  const used = harness(TestBox);
  await used.box.devboxStartup();
  await used.box.stop();
  const startsBefore = used.container.startOptions.length;
  const resting = { state: (await used.box.devboxState()).running, starts: used.container.startOptions.length - startsBefore, armed: armed(used.container) };

  // The platform resets the object while its container is down; the successor's first event is the read.
  const successor = new TestBox(used.state, {});
  used.container.owner = successor;
  const reset = { state: (await successor.devboxState()).running, starts: used.container.startOptions.length - startsBefore, armed: armed(used.container) };

  expect({ resting, reset }).toEqual({
    resting: { state: false, starts: 0, armed: [] },
    reset: { state: false, starts: 0, armed: [] },
  });
  await successor.destroy();
});
