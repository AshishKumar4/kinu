// D67: a final boot stamp that fails leaves the box in `repair`, and changes nothing a user or agent
// can see. The early stamp wrote this container's id to the file and the row; the final one only
// re-reads it, so its failure leaves the identity whole: `ready` says so, and nothing else does. No
// incident (the agent has nothing to act on); operations, saves and the heartbeat run as usual. A pid
// from an earlier boot is fenced by the kernel's boot id, not by this stamp (processes-image.test.ts).
import { expect, test } from 'bun:test';
import { chainBox } from './support/chain-box';

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
    restoration: settled.restoration, unready: settled.unready, incidents: [...rows.keys()].filter(key => key.startsWith('devbox:incident:')).length,
    ran: ran.exitCode, saved: saved.kind, startsAfterBeat: container.startOptions.length - starts, after: (await box.devboxState()).restoration,
    p1: (await box.getProcess('p1'))?.status,
  }).toEqual({
    restoration: 'repair', unready: 'the boot id stamp failed', incidents: 0, ran: 0, saved: 'committed', startsAfterBeat: 0, after: 'repair', p1: 'running',
  });
});
