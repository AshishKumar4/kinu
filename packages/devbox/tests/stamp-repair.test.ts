// D67: a final boot stamp that fails leaves the box in `repair`, and changes nothing a user or agent
// can see. The early stamp wrote this container's id to the file and the row; the final one only
// re-reads it, so its failure leaves the identity whole: `ready` says so, and nothing else does. No
// incident (the agent has nothing to act on); operations, saves and the heartbeat run as usual. A pid
// from an earlier boot is fenced by the kernel's boot id, not by this stamp (processes-image.test.ts).
import { expect, test } from 'bun:test';
import { ChainTestBox, chainBox } from './support/chain-box';
import { settledRestoration } from '../src/restoration';

test('same-container repair writes an outstanding stamp and becomes ready independently of its explanation', async () => {
  const { box, container, rows } = chainBox();

  await box.devboxStartup();
  const before = await box.devboxState();

  expect(before.ready).toBe(true);
  expect(before.bootId).toBeString();
  // A fresh isolate adopts the durable, still-owed stamp on the same native container, not a replacement.
  rows.set('devbox:restoration', settledRestoration([], 'pending'));
  const repaired = new ChainTestBox(container.ctx, {});

  container.owner = repaired;
  expect((await repaired.devboxState()).ready).toBe(false);

  // Losing the durable witness while its obligation is outstanding forces the actual repair decision.
  rows.delete('devbox:boot-id');
  const starts = container.startOptions.length;

  await repaired.attachNow();
  const after = await repaired.devboxState();

  expect(after.ready).toBe(true);
  expect(after.restoration).toBe('attached');
  expect(after.bootId).toBeString();
  expect(after.bootId).not.toBe(before.bootId);
  expect(container.bootId).toBe(after.bootId);
  expect(rows.get('devbox:boot-id')).toBe(after.bootId);
  expect(container.startOptions.length).toBe(starts);
});

test('a final boot stamp that fails changes nothing a user or agent can see', async () => {
  const { box, container, rows } = chainBox();
  rows.set('devbox:proc:p1', { processId: 'p1', command: 'bun run server.ts', cwd: '/workspace', createdAt: 1 });
  container.bootReadFaults.push(new Error('the read of the boot id was dropped'));
  await box.devboxStartup();
  const settled = await box.devboxState();
  const ran = await box.exec('echo still here');
  const saved = await box.checkpointNow('tick');
  const starts = container.startOptions.length;
  await box.devboxHeartbeat();

  expect({
    restoration: settled.restoration, ready: settled.ready, incidents: [...rows.keys()].filter(key => key.startsWith('devbox:incident:')).length,
    ran: ran.exitCode, saved: saved.kind, startsAfterBeat: container.startOptions.length - starts, after: (await box.devboxState()).restoration,
    p1: (await box.getProcess('p1'))?.status,
  }).toEqual({
    restoration: 'repair', ready: false, incidents: 0, ran: 0, saved: 'committed', startsAfterBeat: 0, after: 'repair', p1: 'running',
  });
});
