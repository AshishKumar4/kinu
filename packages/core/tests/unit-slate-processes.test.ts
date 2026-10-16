/**
 * The workspace's running slates, over a backend that compiles and launches nothing real: which build serves a call once
 * what it read changes, across activations and authorities. The rebuilds a workspace's own files cause are its preview's
 * (workerd wide/slate-durability.test.ts).
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

/** A launched slate, and the image it serves: which build a call reaches. */
interface Launched { readonly id: string; readonly port: number | null; readonly serves: string; isRunning(): Promise<boolean>; stop(): Promise<void> }

/**
 * What a slate's compile does as one authority: its tree's digest, whether it compiles, what it looked at, and what it
 * read there (`word`, a file outside the tree: it changes what is built, never the tree's digest).
 */
interface Compile { tree: string; compiles: boolean; inputs: SlateBuildRead[]; word?: string; entered?: () => void; paused?: Promise<void> }

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
  const builds = new SlateBuilds(exec);
  const as = (id: string, cred: VfsCred): Compile => compiles.get(`${id}#${cred.uid}`) ?? compiles.get(id) ?? { tree: 'v1', compiles: true, inputs: [] };

  const activation = () => new SlateProcesses<Source, Launched>({
    workspace: 'w', builds, pages: new EphemeralSlates(exec),
    apps: { ensure: async () => ({ port: 20000, capability: 'cap' }), remove: async () => ({ removed: true, port: 20000 }) },
    resolve: async (_cred, id) => ({ kind: 'files', project: parseSlateProject({ main: 'server.ts' }), root: `/slates/${id}` }),
    digest: async (cred, id) => as(id, cred).tree,
    build: async (caller, id): Promise<SlateImage | SlateBuildFailure> => {
      const { tree, compiles: ok, inputs, word, entered, paused } = as(id, caller.cred);

      entered?.();
      await paused;

      return ok ? { modules: { 'index.js': `image-${id}-${tree}${word === undefined ? '' : `-${word}`}` }, inputs }
        : { failed: `${id}/server.ts:1:1: Could not resolve`, inputs };
    },
    launch: async ({ id, image }) => {
      let running = true;

      return { id, port: 20000, serves: image.modules['index.js'] ?? '', isRunning: async () => running, stop: async () => { running = false; } };
    },
  });

  return { processes: activation(), activation, compiles };
}

test('a first build refused for a missing import is built again once the import is written, in a later activation too', async () => {
  const { activation, compiles } = backend();
  const first = activation();

  compiles.set('board', { tree: 'v1', compiles: false, inputs: [missing('/home/main/lib')] });
  await expect(first.booted(ROOT_SLATE_CALLER, 'board')).rejects.toMatchObject({ code: 'bad_input' });

  // Evicted: the next activation is told the import was written, under the directory the compile found missing.
  const next = activation();

  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/lib/index.ts')] });
  next.filesChanged(['/home/main/lib/index.ts']);

  expect((await next.booted(ROOT_SLATE_CALLER, 'board')).process.serves).toBe('image-board-v1');
});

test('a restricted caller\'s build does not drop what the owner\'s build read', async () => {
  const { processes, compiles } = backend();

  compiles.set('board#1000', { tree: 'v1', compiles: true, inputs: [read('/home/main/word.ts')], word: 'one' });
  compiles.set('board#2000', { tree: 'v1', compiles: true, inputs: [] });
  const owner = { ...ROOT_SLATE_CALLER, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } };

  expect((await processes.booted(owner, 'board')).process.serves).toBe('image-board-v1-one');
  expect((await processes.booted(RESTRICTED, 'board')).process.serves).toBe('image-board-v1');

  // The owner's word.ts changes: the owner is served the new build, though the restricted build read nothing.
  compiles.set('board#1000', { tree: 'v1', compiles: true, inputs: [read('/home/main/word.ts')], word: 'two' });
  processes.filesChanged(['/home/main/word.ts']);

  expect((await processes.booted(owner, 'board')).process.serves).toBe('image-board-v1-two');
});

test('a file first read by a build still in flight, changed before it returns, is built again before anything launches', async () => {
  const { processes, compiles } = backend();
  const { promise: paused, resolve: resume } = Promise.withResolvers<void>();
  const { promise: compiling, resolve: entered } = Promise.withResolvers<void>();

  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/dep.ts')], word: 'one', entered, paused });
  const booting = processes.booted(ROOT_SLATE_CALLER, 'board');

  // The compile has read dep.ts at v1; v2 is written while it is still bundling.
  await compiling;
  compiles.set('board', { tree: 'v1', compiles: true, inputs: [read('/home/main/dep.ts')], word: 'two' });
  processes.filesChanged(['/home/main/dep.ts']);
  resume();

  // What first serves is the build that read the new dep.ts: the one that read the old never launches.
  expect((await booting).process.serves).toBe('image-board-v1-two');
});
