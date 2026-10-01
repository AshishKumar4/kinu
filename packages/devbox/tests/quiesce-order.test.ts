import { expect, setSystemTime, test } from 'bun:test';
import { INCIDENT_PREFIX } from '../src/incidents';
import { normalizeChainState } from '../src/snapshot-chain';
import { chainBox, chainHead } from './support/chain-box';
import { gate } from './support/devbox-harness';
import { DEFAULT_DEVBOX_POLICY, LAST_INTERACTION_KEY } from '../src/lifecycle';

test('quiesce drains admitted work and fences a later command before stopping', async () => {
  const { box, container } = chainBox();
  await box.start();
  const held = gate();
  container.execGate = held;
  const admitted = box.exec('printf finished');
  await held.reached;
  const stopping = box.quiesce();

  try {
    expect((await box.resolveReadiness()).kind).toBe('pending');
    await expect(box.exec('printf too-late')).rejects.toThrow();
    expect(container.running.running).toBe(true);
  } finally {
    held.release();
    const finished = await admitted;
    expect(finished.exitCode).toBe(0);
    const stopped = await stopping;
    expect(stopped.kind === 'committed' || stopped.kind === 'skipped').toBe(true);
  }

  expect(container.running.running).toBe(false);
  expect(container.execs.some(command => command === 'printf too-late')).toBe(false);
});

test('a resident cwd holder survives as a launch record; stop commits, wake resumes, and the next commit is a delta', async () => {
  setSystemTime(new Date('2026-09-28T12:00:00Z'));
  const { box, container, rows } = chainBox();

  try {
    await box.start();
    await box.writeFile('/workspace/kept', 'before');
    const resident = await box.startSupervised('serve-workspace', '/workspace');
    expect((await box.quiesce()).kind).toBe('committed');
    expect(container.running.running).toBe(false);
    const base = chainHead(rows);

    if (base === null) throw new Error('stop did not publish a base');

    await box.start();
    expect(await box.listSupervised()).toMatchObject([{ processId: resident.processId, restartable: true, status: 'running' }]);
    expect(await box.readFile('/workspace/kept')).toMatchObject({ content: 'before' });
    await box.writeFile('/workspace/kept', 'after');
    setSystemTime(new Date('2026-09-28T12:01:00Z'));
    const next = await box.checkpointNow('tick');
    expect(next.kind).toBe('committed');
    const state = normalizeChainState(rows.get('devbox:storage-state'));
    expect(state?.base.id).toBe(base);
    expect(state?.delta).toMatchObject({ bytes: expect.any(Number), digest: expect.any(String) });
    await box.quiesce();
    await box.start();
    expect(await box.readFile('/workspace/kept')).toMatchObject({ content: 'after' });
    expect(await box.listSupervised()).toMatchObject([{ processId: resident.processId, restartable: true, status: 'running' }]);
  } finally {
    setSystemTime();
    await box.destroy();
  }
});

test('a readable unmanaged command refuses stop and remains running', async () => {
  const { box, container } = chainBox();

  try {
    await box.start();
    const process = await box.startProcess('detached-work');
    expect((await box.quiesce()).kind).toBe('failed');
    expect(container.running.running).toBe(true);
    expect(await box.getProcess(process.id)).toMatchObject({ status: 'running' });
    await box.writeFile('/workspace/after-refusal', 'admission reopened');
    expect(await box.readFile('/workspace/after-refusal')).toMatchObject({ content: 'admission reopened' });
  } finally { await box.destroy(); }
});

test('an unreadable process list holds every stop until the agent answers, and the answered stop names the risk', async () => {
  const { box, container, rows } = chainBox();
  await box.start();
  container.fileFaults.set('/var/tmp/devbox/processes', { errno: 13, message: 'process directory unavailable' });
  const start = Date.now();

  try {
    expect((await box.quiesce()).kind).toBe('failed');
    rows.set(LAST_INTERACTION_KEY, start - DEFAULT_DEVBOX_POLICY.idleMs - 60_000);

    for (let beat = 1; beat <= 2 * DEFAULT_DEVBOX_POLICY.quietConfirmMs / (DEFAULT_DEVBOX_POLICY.heartbeatSeconds * 1000); beat++) {
      setSystemTime(start + beat * DEFAULT_DEVBOX_POLICY.heartbeatSeconds * 1000);
      await box.devboxHeartbeat();
    }

    const unanswered = { stop: (await box.quiesce()).kind, running: container.running.running };
    const answered = await box.answerRest('now');
    const reasons = [...rows.entries()].filter(([key]) => key.startsWith(INCIDENT_PREFIX)).map(([, row]) => JSON.stringify(row));

    expect({ unanswered, answered: answered.kind, running: container.running.running })
      .toEqual({ unanswered: { stop: 'failed', running: true }, answered: 'resting', running: false });
    expect(reasons.some((row) => row.includes('process directory unavailable') && row.includes('quiesce'))).toBe(true);
  } finally { container.fileFaults.clear(); setSystemTime(); await box.destroy(); }
});
