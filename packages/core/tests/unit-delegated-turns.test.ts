import { expect, test } from 'bun:test';
import { DelegatedTurnRunners } from '../src/subordinates/delegated-turns';

const SLOTS = 2;

function runners(slots = SLOTS): DelegatedTurnRunners {
  return new DelegatedTurnRunners({
    slots,
    pass: () => Promise.resolve(false),
    holdLane: (body) => body(),
    failed: (_record, error) => { throw error; },
  });
}

test('no more delegated turns run at once than there are slots', async () => {
  const pool = runners();
  let running = 0;
  let peak = 0;
  const gates = Array.from({ length: SLOTS + 2 }, () => Promise.withResolvers<void>());

  const turns = gates.map((gate, index) => pool.turn(`actor-${String(index)}`, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gate.promise;
    running -= 1;
  }));

  for (const gate of gates) {
    await Promise.resolve();
    gate.resolve();
  }

  await Promise.all(turns);
  expect(peak).toBe(SLOTS);
});

test('a turn waiting on the delegate it hired frees its slot, so the delegate runs and answers it', async () => {
  // One slot, held by the hirer: the delegate can run only in the slot the wait frees.
  const pool = runners(1);
  const order: string[] = [];

  const answer = Promise.withResolvers<string>();

  const parent = pool.turn('parent', async () => {
    order.push('parent hires');

    const child = pool.turn('child', async () => {
      order.push('child runs');
      answer.resolve('found');
    });

    const got = await pool.whileWaiting('parent', answer.promise);
    order.push(`parent resumes with ${got}`);
    await child;
  });

  await parent;
  expect(order).toEqual(['parent hires', 'child runs', 'parent resumes with found']);
});
