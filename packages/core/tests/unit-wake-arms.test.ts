/**
 * A rest release and an arm of the same wake row race: an arm between its reads keeps a row and returns it as
 * its keeper, so a release that cancels under it leaves the arm's wake with no row (review of the S4 rest release).
 */
import { expect, test } from 'bun:test';
import { WakeArms } from '../src/orchestrator/wake-arms';

function rows(initial: readonly string[]) {
  const held = new Set(initial);
  const rearms: number[] = [];

  return {
    held,
    rearms,
    ports: (cancel: (id: string) => Promise<void> = async () => {}) => ({
      rows: () => Promise.resolve([...held]),
      idle: () => true,
      cancel: async (id: string) => {
        await cancel(id);
        held.delete(id);
      },
      rearm: () => {
        rearms.push(1);
        held.add('rearmed');

        return Promise.resolve();
      },
    }),
  };
}

test('an idle release with no arm running cancels every row and arms nothing', async () => {
  const wake = new WakeArms();
  const store = rows(['a', 'b']);

  await wake.release(store.ports());

  expect({ rows: [...store.held], rearms: store.rearms.length }).toEqual({ rows: [], rearms: 0 });
});

test('an arm in flight before the release keeps its row', async () => {
  const wake = new WakeArms();
  const store = rows(['keeper']);
  const { promise: between, resolve: readsDone } = Promise.withResolvers<void>();

  const arm = wake.arm(async () => {
    await between;

    return 'keeper';
  });

  await wake.release(store.ports());
  readsDone();

  expect(await arm).toBe('keeper');
  expect([...store.held]).toEqual(['keeper']);
});

test('an arm that starts during a cancel gets a row back', async () => {
  const wake = new WakeArms();
  const store = rows(['keeper']);
  const { promise: cancelling, resolve: cancelDone } = Promise.withResolvers<void>();
  const { promise: cancelStarted, resolve: markStarted } = Promise.withResolvers<void>();

  const release = wake.release(store.ports(async () => {
    markStarted();
    await cancelling;
  }));

  await cancelStarted;
  // The arm reads the row the cancel has not deleted yet, and keeps it.
  const arm = wake.arm(() => Promise.resolve('keeper'));

  cancelDone();
  await release;

  expect(await arm).toBe('keeper');
  expect({ rows: [...store.held], rearms: store.rearms.length }).toEqual({ rows: ['rearmed'], rearms: 1 });
});
