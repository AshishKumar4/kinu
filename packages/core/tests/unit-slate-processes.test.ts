/**
 * The workspace's running slates, over a backend that compiles and launches nothing real: which process serves a call,
 * when a build is stale, and what a source that does not compile serves.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { sqlStorageOver } from '../src/identity';
import { initSlateBuildTable, SlateBuilds, type SlateBuildFailure, type SlateImage } from '../src/slates/builds';
import { ROOT_SLATE_CALLER } from '../src/slates/caller';
import { EphemeralSlates, initEphemeralSlateTable } from '../src/slates/ephemeral';
import { SlateProcesses } from '../src/slates/processes';
import { parseSlateProject, type SlateProject } from '../src/slates/project';

type Source = { readonly kind: 'files'; readonly project: SlateProject; readonly root: string };

/** One slate whose tree is `tree` and whose build reads `/home/main/word.ts`; each launch is a numbered process. */
function backend() {
  const db = new Database(':memory:');
  const exec = sqlStorageOver(db);

  initSlateBuildTable((sql) => { db.exec(sql); });
  initEphemeralSlateTable((sql) => { db.exec(sql); });
  const world = { tree: 'v1', compiles: true, builds: 0, launches: 0 };
  const stopped: number[] = [];

  const processes = new SlateProcesses<Source, { readonly id: string; readonly port: number | null; readonly n: number; isRunning(): Promise<boolean>; stop(): Promise<void> }>({
    workspace: 'w', builds: new SlateBuilds(exec), pages: new EphemeralSlates(exec),
    apps: { ensure: async () => ({ port: 20000, capability: 'cap' }), remove: async () => ({ removed: true, port: 20000 }) },
    resolve: async () => ({ kind: 'files', project: parseSlateProject({ main: 'server.ts' }), root: '/slates/board' }),
    digest: async () => world.tree,
    build: async (): Promise<SlateImage | SlateBuildFailure> => {
      world.builds += 1;

      return world.compiles ? { modules: { 'index.js': `image-${world.tree}` }, reads: ['/home/main/word.ts'] } : { failed: 'server.ts:1:1: Unexpected end' };
    },
    launch: async () => {
      const n = ++world.launches;
      let running = true;

      return { id: 'board', port: 20000, n, isRunning: async () => running, stop: async () => { running = false; stopped.push(n); } };
    },
  });

  return { processes, world, stopped };
}

test('a running build serves until a file it read moves, and then the slate is built and launched again', async () => {
  const { processes, world, stopped } = backend();

  expect((await processes.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(1);
  expect((await processes.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(1);
  expect(processes.filesChanged(['/home/main/notes.md'])).toEqual([]);
  expect(processes.filesChanged(['home/main/word.ts'])).toEqual(['board']);
  expect((await processes.booted(ROOT_SLATE_CALLER, 'board')).process.n).toBe(2);
  expect({ builds: world.builds, stopped }).toEqual({ builds: 2, stopped: [1] });
});

test('a source that does not compile keeps its last working process, says why, and is retried on any change outside', async () => {
  const { processes, world } = backend();

  await processes.booted(ROOT_SLATE_CALLER, 'board');
  world.tree = 'v2';
  world.compiles = false;

  expect(await processes.served(ROOT_SLATE_CALLER, 'board')).toMatchObject({ process: { n: 1 }, broken: 'server.ts:1:1: Unexpected end' });
  expect(processes.filesChanged(['/home/main/notes.md'])).toEqual(['board']);

  world.compiles = true;

  expect(await processes.served(ROOT_SLATE_CALLER, 'board')).toMatchObject({ process: { n: 2 }, broken: null });
});
