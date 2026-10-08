// D65 at the box: a box with a golden builder never starts the bare base. It wakes its own snapshot,
// else the golden, and with no golden it waits until the golden object tells it, with no clock.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { GoldenAnswer } from '../src/golden';
import { TOOLS_STAMP } from '../src/tools';
import type { BoxPeers } from '../src/devbox';
import { ChainTestBox, asked, chainBox } from './support/chain-box';

const PARTS = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];

const PIN = createHash('sha256').update(Buffer.concat(PARTS)).digest('hex');

class Golden {
  answers: GoldenAnswer[] = [];
  readonly asked: string[] = [];

  goldenFor(_box: string, lost?: string): Promise<GoldenAnswer> {
    this.asked.push(lost === undefined ? 'golden?' : `lost ${lost}`);

    return Promise.resolve(this.answers.shift() ?? { kind: 'pending', reason: 'the base snapshot is being rebuilt' });
  }
}

const golden = new Golden();

class GoldenBox extends ChainTestBox {
  protected override get peers(): BoxPeers {
    return { golden: () => golden, box: (id) => ({ goldenReady: async () => { golden.asked.push(`told ${id}`); } }) };
  }

  protected override get toolsPin(): string {
    return PIN;
  }

  protected override get snapshotWakeCutoverMs(): number {
    return 50;
  }
}

const startedFrom = (options: { readonly image?: string; readonly containerSnapshot?: { readonly id: string } } | undefined) =>
  options?.containerSnapshot === undefined ? 'image' : options.containerSnapshot.id;

function fresh(answers: GoldenAnswer[]) {
  asked.length = 0;
  golden.answers = answers;
  golden.asked.length = 0;
  const made = chainBox(GoldenBox);
  made.container.addSnapshot('golden-1', new Map([[TOOLS_STAMP, PIN]]));
  made.container.addSnapshot('golden-0', new Map([[TOOLS_STAMP, 'b'.repeat(64)]]));

  for (const [index, part] of PARTS.entries()) made.objects.set(`devbox-tools/${PIN}.tgz.${String(index)}`, part);

  return made;
}

test('a fresh box starts from the golden, never the bare base, and recovers nothing', async () => {
  const { box, container } = fresh([{ kind: 'ready', id: 'golden-1', tools: PIN }]);
  await box.devboxStartup();

  expect({ starts: container.startOptions.map(startedFrom), asked: golden.asked, attach: asked, installed: container.sequence.includes('exec:tools-install') })
    .toEqual({ starts: ['golden-1'], asked: ['golden?'], attach: ['attach from image'], installed: false });
});

test('a box with no golden to start from waits with the reason, arms no clock, and starts when the golden object tells it', async () => {
  const { box, container, rows } = fresh([]);
  const waiting = await box.resolveReadiness();
  const clocks = [...rows.keys()].filter(key => key.startsWith('devbox:schedule:'));
  golden.answers = [{ kind: 'ready', id: 'golden-1', tools: PIN }];
  await box.goldenReady({ kind: 'ready', id: 'golden-1', tools: PIN });

  expect({ waiting, clocks, starts: container.startOptions.map(startedFrom) }).toEqual({
    waiting: { kind: 'pending', reason: 'the base snapshot is being rebuilt' }, clocks: [], starts: ['golden-1'],
  });
});

test('a box evicted while it waits still starts when the golden object tells it; a destroyed one does not', async () => {
  // Release review: the wait lived in memory, so the golden object's one notice reached a successor that knew nothing.
  const ready: GoldenAnswer = { kind: 'ready', id: 'golden-1', tools: PIN };
  const waiting = fresh([]);
  await waiting.box.resolveReadiness();
  golden.answers = [ready];
  await waiting.evict().goldenReady(ready);
  const destroyed = fresh([]);
  await destroyed.box.resolveReadiness();
  await destroyed.box.destroy();
  golden.answers = [ready];
  await destroyed.evict().goldenReady(ready);

  expect({ evicted: waiting.container.startOptions.map(startedFrom), destroyed: destroyed.container.startOptions.length })
    .toEqual({ evicted: ['golden-1'], destroyed: 0 });
});

test('a failed build becomes the waiting box\'s reason, said once', async () => {
  const { box, container } = fresh([]);
  await box.resolveReadiness();
  await box.goldenReady({ kind: 'pending', reason: 'the base snapshot could not be built: installing the tools exited 100' });
  golden.answers = [{ kind: 'pending', reason: 'the base snapshot could not be built: installing the tools exited 100' }];
  const after = await box.resolveReadiness();

  expect({ after, starts: container.startOptions.length }).toEqual({
    after: { kind: 'pending', reason: 'the base snapshot could not be built: installing the tools exited 100' }, starts: 0,
  });
});

test('a golden of other tools serves, and the box installs the pinned tools in its gate before it attaches', async () => {
  const { box, container } = fresh([{ kind: 'ready', id: 'golden-0', tools: 'b'.repeat(64) }]);
  await box.devboxStartup();
  const order = container.sequence.filter(step => step === 'exec:tools-install' || step.startsWith('exec:stdin'));

  expect({
    starts: container.startOptions.map(startedFrom), order, archive: [...container.binaryFiles.get('/tmp/devbox-tools.tgz') ?? []],
    stamp: container.files.get(TOOLS_STAMP), state: (await box.devboxState()).restoration,
  }).toEqual({
    starts: ['golden-0'], order: ['exec:stdin /tmp/devbox-tools.tgz', 'exec:stdin /tmp/devbox-tools.tgz', 'exec:tools-install'],
    archive: [1, 2, 3, 4, 5], stamp: PIN, state: 'attached',
  });
});

test('a store missing a part installs nothing: the archive is not the pinned one', async () => {
  const { box, container, objects } = fresh([{ kind: 'ready', id: 'golden-0', tools: 'b'.repeat(64) }]);
  objects.delete(`devbox-tools/${PIN}.tgz.1`);

  await expect(box.devboxStartup()).rejects.toThrow(`is not the pinned tools ${PIN}`);
  expect(container.files.get(TOOLS_STAMP)).toBe('b'.repeat(64));
});

test('a golden the platform refuses is reported lost, and the box starts from the one it is given next', async () => {
  const { box, container } = fresh([{ kind: 'ready', id: 'golden-gone', tools: PIN }, { kind: 'ready', id: 'golden-1', tools: PIN }]);
  await box.devboxStartup();

  expect({ starts: container.startOptions.map(startedFrom), asked: golden.asked }).toEqual({
    starts: ['golden-gone', 'golden-1'], asked: ['golden?', 'lost golden-gone'],
  });
});

test('a box with its own snapshot wakes it, asks no golden, and keeps the pinned tools it holds', async () => {
  const { box, container } = fresh([{ kind: 'ready', id: 'golden-1', tools: PIN }]);
  await box.devboxStartup();
  await box.quiesce();
  golden.asked.length = 0;
  await box.devboxStartup();

  expect({ starts: container.startOptions.map(startedFrom), asked: golden.asked, installs: container.sequence.filter(step => step === 'exec:tools-install').length })
    .toEqual({ starts: ['golden-1', 'snapshot-1'], asked: [], installs: 0 });
});

// Staging 2026-10-08: the account's containers were all in use, and the golden said only "The container has not been started".
test('a golden whose base start the platform refuses says why in the platform\'s own words', async () => {
  const { box, container } = chainBox();
  container.containerUnavailable = new Error('Account resource limit exceeded');

  await expect(box.ensureGolden()).rejects.toThrow('Account resource limit exceeded');
  expect(await box.goldenFor('box-a')).toEqual({ kind: 'pending', reason: 'the base snapshot could not be built: starting the base image: Account resource limit exceeded' });
});
