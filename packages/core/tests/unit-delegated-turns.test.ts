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

test('a Stop skips the turns an actor has queued for a slot, and not later ones', async () => {
  const pool = runners(1);
  const ran: string[] = [];
  const gate = Promise.withResolvers<void>();
  const holder = pool.turn('holder', async () => { await gate.promise; });
  const queued = pool.turn('stopped', async () => { ran.push('queued before the Stop'); });

  pool.cancelQueued(['stopped']);
  const later = pool.turn('stopped', async () => { ran.push('queued after the Stop'); });
  gate.resolve();
  await Promise.all([holder, queued, later]);

  expect(ran).toEqual(['queued after the Stop']);
});
