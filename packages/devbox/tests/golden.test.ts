// D65's golden builder at its ports: what a box is answered, what a build runs, and who is told.
import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { settle } from '../src/errors';
import { GOLDEN_BASE, buildGolden, goldenFor, type GoldenAnswer, type GoldenPorts, type GoldenState } from '../src/golden';

const DAY = 24 * 60 * 60 * 1000;

class Platform {
  state: GoldenState = { waiting: [], retiring: [] };
  readonly calls: string[] = [];
  /** What the registry was asked to delete; `refuse` answers the next ask, and no registry answers undefined. */
  readonly deleted: string[] = [];
  refuse: { readonly reason: string; readonly left?: string } | undefined;
  registry = true;
  stopRefused: string | undefined;
  readonly told: [string, GoldenAnswer][] = [];
  builds = 0;
  failInstall: string | undefined;
  /** Runs while the tools install, as a box's ask lands mid-build. */
  duringInstall: (() => Promise<void>) | undefined;
  clock = 1_000 * DAY;
  #taken = 0;

  ports(tools = 'tools-2'): GoldenPorts {
    return {
      tools,
      read: () => this.state,
      write: (state) => { this.state = state; },
      start: async (from) => { this.calls.push('image' in from ? `start ${from.image}` : `start ${from.snapshot}`); },
      exec: async (command) => {
        if (command.includes('debian_version')) return { stdout: '13.6 v24.20.0 aaaa', stderr: '', exitCode: 0 };

        if (command.includes('apt-get')) {
          this.calls.push('install');
          await this.duringInstall?.();

          return this.failInstall === undefined ? { stdout: 'installMs=1', stderr: '', exitCode: 0 } : { stdout: '', stderr: this.failInstall, exitCode: 1 };
        }

        this.calls.push('verify');

        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
      pipe: (key) => Effect.sync(() => { this.calls.push(`pipe ${key}`); }),
      snapshot: async () => {
        this.#taken += 1;
        this.calls.push('snapshot');

        return `golden-${String(this.#taken)}`;
      },
      destroy: async () => {
        this.calls.push('destroy');

        if (this.stopRefused !== undefined) throw new Error(this.stopRefused);
      },
      build: async () => { this.builds += 1; },
      tell: async (box, answer) => { this.told.push([box, answer]); },
      delete: (ref) => {
        if (!this.registry) return undefined;
        const refused = this.refuse;
        this.refuse = undefined;

        if (refused !== undefined) return Promise.resolve({ kind: 'refused', ...refused });
        this.deleted.push(ref);

        return Promise.resolve({ kind: 'deleted' });
      },
      now: () => this.clock,
    };
  }
}

test('a box finding no golden waits, is told why, and each ask requests the build', async () => {
  const platform = new Platform();
  const answer = await settle(goldenFor(platform.ports(), 'box-a'));
  await settle(goldenFor(platform.ports(), 'box-a'));

  expect({ answer, waiting: platform.state.waiting, builds: platform.builds })
    .toEqual({ answer: { kind: 'pending', reason: expect.any(String), building: { step: null } }, waiting: ['box-a'], builds: 2 });
});

test('a box asking while the build runs is told the step it is at, and a finished build leaves none', async () => {
  const platform = new Platform();
  const midBuild: GoldenAnswer[] = [];
  platform.duringInstall = async () => { midBuild.push(await settle(goldenFor(platform.ports(), 'box-b'))); };

  await settle(goldenFor(platform.ports(), 'box-a'));
  await settle(buildGolden(platform.ports(), false));

  expect({ midBuild, after: platform.state.building }).toEqual({
    midBuild: [{ kind: 'pending', reason: expect.any(String), building: { step: 'installing the tools' } }], after: undefined,
  });
});

test('a build installs the pinned tools on the base, checks them, snapshots, and tells every waiting box once', async () => {
  const platform = new Platform();
  await settle(goldenFor(platform.ports(), 'box-a'));
  await settle(goldenFor(platform.ports(), 'box-b'));
  await settle(buildGolden(platform.ports(), false));

  expect({ calls: platform.calls, current: platform.state.current?.id, waiting: platform.state.waiting, told: platform.told }).toEqual({
    calls: [`start ${GOLDEN_BASE}`, 'pipe devbox-tools/tools-2.tgz', 'install', 'verify', 'snapshot', 'destroy'],
    current: 'golden-1', waiting: [],
    told: [['box-a', { kind: 'ready', id: 'golden-1', tools: 'tools-2' }], ['box-b', { kind: 'ready', id: 'golden-1', tools: 'tools-2' }]],
  });
  expect(await settle(goldenFor(platform.ports(), 'box-c'))).toEqual({ kind: 'ready', id: 'golden-1', tools: 'tools-2' });
});

test('a failed build tells each waiting box its words once; the next ask waits on them and asks again', async () => {
  const platform = new Platform();
  platform.failInstall = 'E: Unable to locate package s3fs';
  await settle(goldenFor(platform.ports(), 'box-a'));
  const failed = await Promise.allSettled([settle(buildGolden(platform.ports(), false))]);
  const again = await settle(goldenFor(platform.ports(), 'box-a'));

  expect({ failed: failed[0]?.status, told: platform.told.length, words: platform.told[0]?.[1], again, builds: platform.builds }).toEqual({
    failed: 'rejected', told: 1,
    words: { kind: 'pending', reason: 'the base snapshot could not be built: installing the tools exited 1: E: Unable to locate package s3fs' },
    again: { kind: 'pending', reason: 'the base snapshot could not be built: installing the tools exited 1: E: Unable to locate package s3fs' }, builds: 2,
  });
});

test('a golden of other tools still serves while one of the pinned tools is built', async () => {
  const platform = new Platform();
  await settle(buildGolden(platform.ports('tools-1'), false));
  const served = await settle(goldenFor(platform.ports('tools-2'), 'box-a'));

  expect({ served, builds: platform.builds, waiting: platform.state.waiting }).toEqual({ served: { kind: 'ready', id: 'golden-1', tools: 'tools-1' }, builds: 1, waiting: [] });
});

// The 15-minute cron asks for a build; one that has nothing to do must cost no container (D66).
test('a build that finds the pinned tools current and young starts no container, and a new pin rebuilds', async () => {
  const platform = new Platform();
  await settle(buildGolden(platform.ports(), false));
  platform.calls.length = 0;
  await settle(buildGolden(platform.ports(), false));
  const held = [...platform.calls];
  await settle(buildGolden(platform.ports('tools-3'), false));

  expect({ held, current: platform.state.current?.id, previous: platform.state.previous?.id }).toEqual({
    held: [], current: 'golden-2', previous: 'golden-1',
  });
});

test('the refresh builds a new golden at 25 days and restores the previous, which then serves 29 days from that restore', async () => {
  const platform = new Platform();
  await settle(buildGolden(platform.ports(), false));
  platform.clock += 26 * DAY;
  platform.calls.length = 0;
  await settle(buildGolden(platform.ports(), true));
  const refreshed = platform.calls.slice(-3);
  platform.state = { ...platform.state, current: undefined };
  platform.clock += 14 * DAY;
  const renewed = await settle(goldenFor(platform.ports(), 'box-a'));
  platform.clock += 16 * DAY;
  const expired = await settle(goldenFor(platform.ports(), 'box-a'));

  expect({ refreshed, renewed, expired: expired.kind }).toEqual({
    refreshed: ['destroy', 'start golden-1', 'destroy'], renewed: { kind: 'ready', id: 'golden-1', tools: 'tools-2' }, expired: 'pending',
  });
});

// A box's own lineage is a delta on the golden it started from and wakes for 29 days from its root, so a golden no slot
// holds is deleted 30 days after it left, never when it leaves.
test('a golden pushed out of both slots is deleted once every lineage rooted on it is past waking, and not before', async () => {
  const platform = new Platform();
  await settle(buildGolden(platform.ports('tools-1'), false));
  await settle(buildGolden(platform.ports('tools-2'), false));
  await settle(buildGolden(platform.ports('tools-3'), false));
  const retiring = platform.state.retiring.map((retired) => retired.ref);
  platform.clock += 29 * DAY;
  await settle(buildGolden(platform.ports('tools-3'), false));
  const early = [...platform.deleted];
  platform.clock += DAY;
  await settle(buildGolden(platform.ports('tools-3'), false));

  // The refresh at 29 days pushed golden-2 out in turn; it waits its own 30 days.
  expect({ retiring, early, deleted: platform.deleted, left: platform.state.retiring.map((retired) => retired.ref) })
    .toEqual({ retiring: ['golden-1'], early: [], deleted: ['golden-1'], left: ['golden-2'] });
});

test('a golden the platform refused a box is retired as one pushed out is', async () => {
  const platform = new Platform();
  await settle(buildGolden(platform.ports(), false));
  await settle(goldenFor(platform.ports(), 'box-a', 'golden-1'));

  expect(platform.state.retiring).toEqual([{ ref: 'golden-1', at: platform.clock + 30 * DAY }]);
});

test('a refused or unauthorised delete stays owed, as the digest the registry left once its tags went', async () => {
  const platform = new Platform();
  platform.state = { ...platform.state, retiring: [{ ref: 'golden-0', at: 0 }, { ref: 'golden-9', at: 0 }] };
  platform.registry = false;
  await settle(buildGolden(platform.ports(), false));
  const unauthorised = platform.state.retiring.map((retired) => retired.ref);
  platform.registry = true;
  platform.refuse = { reason: 'deleting sha256:aa answered 500: busy', left: 'sha256:aa' };
  await settle(buildGolden(platform.ports(), false));
  const refused = platform.state.retiring.map((retired) => retired.ref);
  await settle(buildGolden(platform.ports(), false));

  expect({ unauthorised, refused, deleted: platform.deleted, left: platform.state.retiring })
    .toEqual({ unauthorised: ['golden-0', 'golden-9'], refused: ['sha256:aa'], deleted: ['golden-9', 'sha256:aa'], left: [] });
});

test('a golden whose container will not stop is built and recorded, not lost', async () => {
  const platform = new Platform();
  platform.stopRefused = 'the container did not stop';
  const state = await settle(buildGolden(platform.ports(), false));

  expect({ current: state.current?.id, failure: state.failure }).toEqual({ current: 'golden-1', failure: undefined });
});
