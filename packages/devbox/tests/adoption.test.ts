import { expect, test } from 'bun:test';
import { ChainTestBox, asked, chainBox, chainHead } from './support/chain-box';
import { KERNEL_READ, deliver, gate } from './support/devbox-harness';
import { DevboxError } from '../src/errors';
import type { RestoreClockPhase } from '../src/restoration';

// 2026-10-17 to 10-19, production (#117): an object that restarted beside its running container held its restoration in
// memory only, and learned what the container carried only where a caller opted in. Its checkpoint tick did not, and
// filed a System card every 5 minutes. The object now adopts once, on the first member that touches the container, and
// every such member awaits that one adoption (D102).

/** Members that touch the container, each as a caller or the platform reaches it. */
const members: readonly (readonly [string, (box: ChainTestBox) => Promise<void>])[] = [
  ['exec', async (box) => { await box.exec('true'); }],
  ['readFile', async (box) => { await box.readFile('/workspace/kept.txt'); }],
  ['listProcesses', async (box) => { await box.listProcesses(); }],
  ['portListeners', async (box) => { await box.portListeners('job-stamp'); }],
  ['terminalSessions', async (box) => { await box.terminalSessions(); }],
  ['checkpointNow', async (box) => { await box.checkpointNow('tick'); }],
  ['quiesce', async (box) => { await box.quiesce(); }],
  ['attachNow', async (box) => { await box.attachNow(); }],
  ['devboxState', async (box) => { await box.devboxState(); }],
  ['devboxHeartbeat', async (box) => { await box.devboxHeartbeat(); }],
];

/** A box that restored, saved and was evicted while its container ran on: the successor holds nothing in memory. */
async function evicted() {
  const chain = chainBox();
  await chain.box.start();
  await chain.box.writeFile('/workspace/kept.txt', 'kept');
  await chain.box.checkpointNow('tick');

  return { ...chain, successor: chain.evict() };
}

for (const [member, call] of members) {
  test(`${member} on an evicted box touches its container only after the adoption reads it`, async () => {
    const { container, successor } = await evicted();
    const read = gate();
    container.bootReadGate = read;
    const before = container.execs.length;

    const answer = call(successor).then(() => 'answered', () => 'refused');
    await Promise.race([read.reached, answer]);
    const whileReading = container.execs.slice(before);
    read.release();
    await answer;

    expect(whileReading).toEqual([KERNEL_READ]);
  });
}

test('members that arrive while the adoption reads share its one read', async () => {
  const { container, successor } = await evicted();
  const read = gate();
  container.bootReadGate = read;
  const before = container.execs.length;

  const answers = Promise.allSettled([successor.portListeners('job-stamp'), successor.terminalSessions(), successor.devboxState()]);
  await read.reached;
  const whileReading = container.execs.slice(before);
  read.release();
  await answers;

  expect({ whileReading, ready: (await successor.devboxState()).ready }).toEqual({ whileReading: [KERNEL_READ], ready: true });
});

// The owner's R1 (m193, 2026-10-19): resumption, too, runs in the box's own block, so nothing reaches the container
// until the box has taken it or turned it over (D104, reversing D102's "holds no block").
test('the adoption runs in a block: a stop arriving while the read waits is delivered after it, and stops the box', async () => {
  const { container, rows, successor } = await evicted();
  const committed = chainHead(rows);
  const read = gate();
  container.bootReadGate = read;

  const checkpoint = successor.checkpointNow('tick');
  await read.reached;
  const blocked = container.initGate !== undefined;
  let stoppedWhileReading = true;
  const stopped = deliver(container, async () => { await successor.stop(); });

  await Promise.resolve();
  stoppedWhileReading = container.running.running === false;
  read.release();
  const outcome = await checkpoint;
  await stopped;

  expect({ blocked, stoppedWhileReading, outcome: outcome.kind, committed: chainHead(rows), running: container.running.running })
    .toEqual({ blocked: true, stoppedWhileReading: false, outcome: 'skipped', committed, running: false });
});

test('a fresh start configures its container inside the block it restores in, and nothing before it', async () => {
  const { box, container } = chainBox();

  await box.start();
  let depth = 0;
  const configured: { readonly step: string; readonly inBlock: boolean }[] = [];

  for (const step of container.sequence) {
    if (step === 'block:enter') depth += 1;
    else if (step === 'block:exit') depth -= 1;
    else if (step === 'intercept:https' || step === 'trust') configured.push({ step, inBlock: depth > 0 });
  }

  expect(configured).toEqual([{ step: 'intercept:https', inBlock: true }, { step: 'trust', inBlock: true }]);
});

test('an unready box answers its sessions from its records and its listeners as unknown, and reads nothing more', async () => {
  const { box, evict, container } = chainBox();
  await box.start();
  await box.checkpointNow('tick');
  // The platform replaced the container while the object was gone.
  container.bootId = undefined;
  const successor = evict();
  const before = container.execs.length;

  const listeners = await successor.portListeners('job-stamp');
  const sessions = await successor.terminalSessions();

  expect({ reads: container.execs.slice(before), listeners, sessions: sessions.length, armed: container.scheduleRows.some((row) => row.callback === 'devboxStartup') })
    .toEqual({ reads: [KERNEL_READ], listeners: null, sessions: 1, armed: true });
});

// A restore over the running kernel attaches the last checkpoint over the work done since: only an answer that refutes
// the claim may restore. Each box records every restore it opens.
const opened: string[] = [];

class WitnessedBox extends ChainTestBox {
  protected override onRestorePhase(phase: RestoreClockPhase): void {
    if (phase === 'opened') opened.push(phase);
  }
}

async function evictedWitnessed() {
  const chain = chainBox(WitnessedBox);
  await chain.box.start();
  await chain.box.checkpointNow('tick');
  opened.length = 0;

  return { ...chain, successor: chain.evict() };
}

test('a configuration refused for now leaves the claim to adopt again, and its retry restores nothing', async () => {
  const { container, successor } = await evictedWitnessed();
  container.trustFaults.push(new DevboxError('not-ready', 'the intercept is not up yet'));
  const before = asked.length;

  const first = (await successor.devboxState()).ready;
  await successor.devboxStartup();

  expect({ first, ready: (await successor.devboxState()).ready, opened, asked: asked.slice(before) })
    .toEqual({ first: false, ready: true, opened: [], asked: [] });
});

test('a start whose hook gets no answer from the running container fails into recovery rather than restoring over it', async () => {
  const { container, successor } = await evictedWitnessed();
  // Every read of the boot id this start makes goes unanswered.
  container.bootReadFaults.push(...Array.from({ length: 5 }, () => new Error('the container dropped the exec')));

  const [started] = await Promise.allSettled([successor.devboxStartup()]);
  container.bootReadFaults.length = 0;

  expect({ started: started.status, opened }).toEqual({ started: 'rejected', opened: [] });
});

test('an adoption step that fails is not kept: the next start adopts again', async () => {
  const { container, storage, successor } = await evictedWitnessed();
  // The configuration is refused for good, and the refusal itself cannot be written.
  container.trustFaults.push(new DevboxError('configuration', 'the intercept is refused'));
  storage.faultOn('devbox:restoration', new Error('the refusal could not be persisted'));

  const [first] = await Promise.allSettled([successor.devboxState()]);
  await successor.devboxStartup();

  expect({ first: first.status, ready: (await successor.devboxState()).ready, opened }).toEqual({ first: 'rejected', ready: true, opened: [] });
});
