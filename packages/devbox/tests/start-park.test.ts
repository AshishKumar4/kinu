// A start that fails the same way every time parks until something it read changes; only a refusal waiting can change
// re-arms (D94). Waste, staging 7e411119d (2026-10-14): a box whose start named it into a read-only /etc/hostname, an
// unclassified failure, re-armed its startup every second and took 1,873 alarms in 30 minutes with no caller.
import { TestDevbox } from './support/test-devbox';
import { expect, test, vi } from 'bun:test';

import { Effect } from 'effect';

import type { DiskChain, DiskChainPorts } from '../src/disk-chain';
import { DevboxError, devboxFailure, type DevboxFailure } from '../src/errors';
import { harness, wakeWhileArmed, type FakeSandbox } from './support/devbox-harness';

/** The deploy the next box constructed runs: a module value, since the base constructor reads it before a field is set. */
let deployed = 'v1';

/** What `configureContainer` throws on every start; undefined starts clean. */
let failure: Error | undefined;

class ParkingBox extends TestDevbox<unknown> {
  configures = 0;

  protected override get ambientCheckpoints(): boolean { return false; }

  protected override get workerVersion(): string { return deployed; }

  protected override async configureContainer(reused?: boolean): Promise<void> {
    this.configures += 1;
    await super.configureContainer(reused);

    if (failure !== undefined) throw failure;
  }
}

/** The staging failure's shape: the box's own step, uncoded, so it classifies as nothing. */
const READ_ONLY = new DevboxError('process', 'naming the box computer: name-box: 1: cannot create /etc/hostname: Read-only file system');

async function refusalOf<T>(asked: Promise<T>): Promise<T | DevboxFailure> {
  const [settled] = await Promise.allSettled([asked]);

  if (settled.status === 'fulfilled') return settled.value;
  const refused = devboxFailure({ cause: settled.reason });

  if (refused === undefined) throw settled.reason;

  return refused;
}

const startupRows = (container: FakeSandbox) => container.scheduleRows.filter((row) => row.callback === 'devboxStartup').length;

/** The platform firing whatever the box armed, a minute of it at most, on a clock the test moves. */
async function aMinuteOfAlarms(container: FakeSandbox): Promise<number> {
  let now = Date.now();
  const until = now + 60_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

  try {
    return await wakeWhileArmed(container, (to) => { now = Math.min(until, Math.max(now, to)); }, 60);
  } finally {
    clock.mockRestore();
  }
}

// Red on d343df16e: the first refusal armed a startup a second out, each alarm configured the box again and filed
// another incident, and every caller was told a startup was armed.
test('a start that fails the same unclassified way parks: one configure, one incident, no startup row, and callers are refused', async () => {
  deployed = 'v1';
  failure = READ_ONLY;
  const { box, container } = harness(ParkingBox);
  const asked = [await refusalOf(box.resolveReadiness())];
  const armed = startupRows(container);
  await aMinuteOfAlarms(container);
  asked.push(await refusalOf(box.resolveReadiness()));

  expect({
    asked, armed, configures: box.configures, startupRows: startupRows(container),
    incidents: (await box.devboxIncidentReasons()).filter((row) => row.stage === 'attach').length,
  }).toEqual({
    asked: [expect.objectContaining({ code: 'refused' }), expect.objectContaining({ code: 'refused' })],
    armed: 0, configures: 1, startupRows: 0, incidents: 1,
  });
});

test('a refusal waiting can change, the platform finding no room, still arms its startup', async () => {
  deployed = 'v1';
  failure = new Error('There is no container instance that can be provided to this Durable Object');
  const { box, container } = harness(ParkingBox);
  const asked = await refusalOf(box.resolveReadiness());

  expect({ pending: asked, armed: startupRows(container) }).toEqual({
    pending: expect.objectContaining({ kind: 'pending', reason: expect.stringContaining('A startup is armed') }),
    armed: 1,
  });
});

test('a new deploy lifts a park over a running container: its first caller configures the box again', async () => {
  deployed = 'v1';
  failure = READ_ONLY;
  const { box, container, state, env } = harness(ParkingBox);
  await refusalOf(box.resolveReadiness());
  failure = undefined;

  const redeployed = (version: string) => {
    deployed = version;
    const successor = new ParkingBox(state, env);
    container.owner = successor;

    return successor;
  };

  const same = redeployed('v1');
  const sameAnswer = await refusalOf(same.resolveReadiness());
  const next = redeployed('v2');

  expect({ running: container.running.running, same: [sameAnswer, same.configures], next: [await next.resolveReadiness(), next.configures] }).toEqual({
    running: true,
    same: [expect.objectContaining({ code: 'refused' }), 0],
    next: [{ kind: 'restored' }, 1],
  });
});

test('a new deploy lifts a refused start once the container is gone: the next caller starts it again', async () => {
  deployed = 'v1';
  failure = READ_ONLY;
  const { box, container, state, env } = harness(ParkingBox);
  await refusalOf(box.resolveReadiness());
  await container.stop();
  const starts = container.startOptions.length;
  failure = undefined;
  const same = new ParkingBox(state, env);
  container.owner = same;
  const sameAnswer = await refusalOf(same.resolveReadiness());
  const sameStarts = container.startOptions.length;
  deployed = 'v2';
  const next = new ParkingBox(state, env);
  container.owner = next;

  expect({ same: [sameAnswer, sameStarts - starts], next: [await next.resolveReadiness(), container.startOptions.length - starts] }).toEqual({
    same: [expect.objectContaining({ code: 'refused' }), 0],
    next: [{ kind: 'restored' }, 1],
  });
});

/** A box whose work directory refuses to attach for a reason no retry changes: the recovery ladder's own refusal. */
class UnattachableBox extends ParkingBox {
  protected override diskChain(_ports: DiskChainPorts): DiskChain {
    return {
      attach: () => Effect.fail(new DevboxError('configuration', 'the work directory names a store this box cannot mount')),
      commit: () => Effect.succeed({ kind: 'skipped', reason: 'nothing attached', bytes: undefined, movedBytes: 0 }),
    };
  }
}

test('the recovery ladder\'s refusal is a park too: kept under its own deploy, lifted under another', async () => {
  deployed = 'v1';
  failure = undefined;
  const { box, container, state, env, rows } = harness(UnattachableBox);
  await refusalOf(box.resolveReadiness());
  const parked = rows.get('devbox:restoration');

  const redeployed = (version: string) => {
    deployed = version;
    const successor = new UnattachableBox(state, env);
    container.owner = successor;

    return successor;
  };

  redeployed('v1');
  const kept = rows.get('devbox:restoration');
  redeployed('v2');

  expect({ parked, kept, lifted: rows.has('devbox:restoration') }).toEqual({
    parked: expect.objectContaining({ phase: 'unattached', retry: false, version: 'v1' }),
    kept: expect.objectContaining({ phase: 'unattached', retry: false, version: 'v1' }),
    lifted: false,
  });
});
