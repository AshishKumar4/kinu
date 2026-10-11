/**
 * The workspace's running slates, over a backend that compiles and launches nothing real: which process serves a call,
 * when a build is stale, and what a source that does not compile serves.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { sqlStorageOver } from '../src/identity';
import { initSlateBuildTable, SlateBuilds, type SlateBuildFailure, type SlateBuildRead, type SlateImage } from '../src/slates/builds';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/caller';
import { EphemeralSlates, initEphemeralSlateTable } from '../src/slates/ephemeral';
import { SlateProcesses } from '../src/slates/processes';
import { parseSlateProject, type SlateProject } from '../src/slates/project';

type Source = { readonly kind: 'files'; readonly project: SlateProject; readonly root: string };

interface Launched { readonly id: string; readonly port: number | null; readonly n: number; isRunning(): Promise<boolean>; stop(): Promise<void> }

/** What a slate's compile does as one authority: its tree's digest, whether it compiles, and what it looked at. */
interface Compile { tree: string; compiles: boolean; inputs: SlateBuildRead[]; entered?: () => void; paused?: Promise<void> }

const read = (path: string): SlateBuildRead => ({ path, missing: false });

const missing = (path: string): SlateBuildRead => ({ path, missing: true });

/** A private caller of another authority, as a share's restricted viewer is. */
const RESTRICTED: SlateCaller = { path: [], cred: { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 }, workMode: 'build', share: 'share-1' };

/** Slates over one build store; `activation()` is a fresh controller over it, as the next activation's is. */
function backend() {
  const db = new Database(':memory:');
  const exec = sqlStorageOver(db);

  initSlateBuildTable((sql) => { db.exec(sql); });
  initEphemeralSlateTable((sql) => { db.exec(sql); });
  const compiles = new Map<string, Compile>();
  const world = { builds: 0, launches: 0 };
  const stopped: number[] = [];
  const builds = new SlateBuilds(exec);
  const as = (id: string, cred: VfsCred): Compile => compiles.get(`${id}#${cred.uid}`) ?? compiles.get(id) ?? { tree: 'v1', compiles: true, inputs: [] };

  const activation = () => new SlateProcesses<Source, Launched>({
    workspace: 'w', builds, pages: new EphemeralSlates(exec),
    apps: { ensure: async () => ({ port: 20000, capability: 'cap' }), remove: async () => ({ removed: true, port: 20000 }) },
    resolve: async (_cred, id) => ({ kind: 'files', project: parseSlateProject({ main: 'server.ts' }), root: `/slates/${id}` }),
    digest: async (cred, id) => as(id, cred).tree,
    build: async (caller, id): Promise<SlateImage | SlateBuildFailure> => {
      world.builds += 1;
      const { tree, compiles: ok, inputs, entered, paused } = as(id, caller.cred);

      entered?.();
      await paused;

      return ok ? { modules: { 'index.js': `image-${id}-${tree}` }, inputs }
        : { failed: `${id}/server.ts:1:1: Could not resolve`, inputs };
    },
    launch: async ({ id }) => {
      const n = ++world.launches;
      let running = true;

      return { id, port: 20000, n, isRunning: async () => running, stop: async () => { running = false; stopped.push(n); } };
    },
  });

  return { processes: activation(), activation, compiles, world, stopped };
}

test('a running build serves until a file it read moves, and then the slate is built and launched again', async () => {
  const { processes, compiles, world, stopped } = backend();

  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/word.ts')] });
  expect((await processes.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(1);
  expect((await processes.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(1);
  expect(processes.filesChanged(['/home/main/notes.md'])).toEqual([]);
  expect(processes.filesChanged(['home/main/word.ts'])).toEqual(['board']);
  expect((await processes.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(2);
  expect({ builds: world.builds, stopped }).toEqual({ builds: 2, stopped: [1] });
});

test('a source that does not compile keeps its last working process and says why, until what it looked at changes', async () => {
  const { processes, compiles } = backend();

  compiles.set('board', { tree: 'v1', compiles: true, inputs: [] });
  await processes.booted(ROOT_SLATE_CALLER, 'board');
  compiles.set('board', { tree: 'v2', compiles: false, inputs: [missing('/home/main/lib.ts')] });

  expect(await processes.served(ROOT_SLATE_CALLER, 'board')).toMatchObject({ process: { n: 1 }, broken: 'board/server.ts:1:1: Could not resolve' });
  expect(processes.filesChanged(['/home/main/notes.md'])).toEqual([]);

  compiles.set('board', { tree: 'v2', compiles: true, inputs: [read('/home/main/lib.ts')] });

  expect(processes.filesChanged(['/home/main/lib.ts'])).toEqual(['board']);
  expect(await processes.served(ROOT_SLATE_CALLER, 'board')).toMatchObject({ process: { n: 2 }, broken: null });
});

test('a file of one slate another imports rebuilds both', async () => {
  const { processes, compiles } = backend();

  compiles.set('a', { tree: 'a1', compiles: true, inputs: [read('/slates/b/shared.ts')] });
  await processes.booted(ROOT_SLATE_CALLER, 'a');

  expect(processes.filesChanged(['/slates/b/shared.ts']).sort()).toEqual(['a', 'b']);
  expect((await processes.booted(ROOT_SLATE_CALLER, 'a')).process.n).toBe(2);
});

test('a first build refused for a missing import is built again once the import is written, in a later activation too', async () => {
  const { activation, compiles } = backend();
  const first = activation();

  compiles.set('board', { tree: 'v1', compiles: false, inputs: [missing('/home/main/lib')] });
  await expect(first.booted(ROOT_SLATE_CALLER, 'board')).rejects.toMatchObject({ code: 'bad_input' });

  // Evicted: the next activation is told the import was written, under the directory the compile found missing.
  const next = activation();

  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/lib/index.ts')] });

  expect(next.filesChanged(['/home/main/lib/index.ts'])).toEqual(['board']);
  expect((await next.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(1);
});

test('a restricted caller\'s build does not drop what the owner\'s build read', async () => {
  const { processes, compiles } = backend();

  compiles.set('board#1000', { tree: 'v1', compiles: true, inputs: [read('/home/main/word.ts')] });
  compiles.set('board#2000', { tree: 'v1', compiles: true, inputs: [] });
  const owner = { ...ROOT_SLATE_CALLER, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } };

  expect((await processes.booted(owner, 'board')).process.n).toBe(1);
  expect((await processes.booted(RESTRICTED, 'board')).process.n).toBe(2);

  expect(processes.filesChanged(['/home/main/word.ts'])).toEqual(['board']);
  expect((await processes.booted(owner, 'board')).process.n).toBe(3);
});

test('a file first read by a build still in flight, changed before it returns, is built again before anything launches', async () => {
  const { processes, compiles, world } = backend();
  const { promise: paused, resolve: resume } = Promise.withResolvers<void>();
  const { promise: compiling, resolve: entered } = Promise.withResolvers<void>();

  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/dep.ts')], entered, paused });
  const booting = processes.booted(ROOT_SLATE_CALLER, 'board');

  // The compile has read dep.ts at v1; v2 is written while it is still bundling.
  await compiling;
  expect(processes.filesChanged(['/home/main/dep.ts'])).toEqual([]);
  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/dep.ts')] });
  resume();

  expect((await booting).process.n).toBe(1);
  expect(world).toEqual({ builds: 2, launches: 1 });
});
