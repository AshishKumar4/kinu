import { scratchDir } from '../../packages/test-utils/src/scratch';
import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';

test('session opening failures remain attempted cases with explicitly unavailable evidence', () => {
  // This fixture exercises the real durable-root policy, so it cannot live in /tmp.
  const parent = join(import.meta.dirname, '../../bench-artifacts');
  mkdirSync(parent, { recursive: true });
  const root = scratchDir('first-open', parent);
  const firstRunModule = new URL('./first-run.ts', import.meta.url).href;
  const testUtilsModule = new URL('../../packages/test-utils/src/index.ts', import.meta.url).href;

  const script = `
    import { runFirstRunCase } from ${JSON.stringify(firstRunModule)};
    import { liveModelSpend, resetLiveModelSpend } from ${JSON.stringify(testUtilsModule)};
    resetLiveModelSpend();
    const observations = [];
    const failure = new Error('created workspace but connection failed');
    let ran = false, sameError = false;
    try {
      await runFirstRunCase({ open: async () => { throw failure; } }, {
        id: 'slate', purpose: 'opening failure probe', modelCalls: 'expected',
        run: async () => { ran = true; return []; },
      }, observations);
    } catch (error) { sameError = error === failure; }
    const files = [...new Bun.Glob('first-run-*/slate/failure.json').scanSync({ cwd: process.env.BENCH_ARTIFACTS, absolute: true })];
    if (files.length !== 1) throw new Error('missing failed-open receipt');
    const stored = await Bun.file(files[0]).json();
    const collection = await Bun.file(files[0].replace('failure.json', 'collection.json')).json();
    const spend = liveModelSpend();
    console.log(JSON.stringify({ observations, ran, sameError, phase: stored.phase,
      unavailable: collection.map(row => row.status), unmeasured: spend.episodesUnmeasured, noModel: spend.episodesWithoutModel }));
  `;

  const run = spawnSync('bun', ['-e', script], {
    cwd: join(import.meta.dirname, '../..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, BENCH_ARTIFACTS: root },
  });

  expect(run.status, run.stderr).toBe(0);

  const result = v.parse(v.object({
    observations: v.array(v.looseObject({ taskId: v.string(), repetition: v.number(), outcome: v.string(), reason: v.string() })),
    ran: v.boolean(), sameError: v.boolean(), phase: v.string(), unavailable: v.array(v.string()), unmeasured: v.number(), noModel: v.number(),
  }), JSON.parse(run.stdout));

  expect(result.observations).toEqual([{ taskId: 'slate', repetition: 0, outcome: 'errored', reason: 'created workspace but connection failed' }]);
  expect(result.ran).toBe(false);
  expect(result.sameError).toBe(true);
  expect(result.phase).toBe('open');
  expect(result.unavailable).toEqual(['unavailable', 'unavailable', 'unavailable']);
  expect(result.unmeasured).toBe(1);
  expect(result.noModel).toBe(0);
});

test('a teardown that fails is reported beside the case\'s own failure, never in its place', () => {
  // 2026-09-23, codemode-craft on the deployed build: the host's network
  // dropped, the turn failed on the closed socket, and then the teardown's
  // DELETE never reached the product. The run printed only the teardown.
  const parent = join(import.meta.dirname, '../../bench-artifacts');
  mkdirSync(parent, { recursive: true });
  const root = scratchDir('first-teardown', parent);
  const firstRunModule = new URL('./first-run.ts', import.meta.url).href;

  const script = `
    import { runFirstRunCase } from ${JSON.stringify(firstRunModule)};
    const session = {
      describe: 'a fake session',
      async runEvents() { return []; },
      async history() { return []; },
      async spend() {
        return { total: { calls: 0, callsWithoutUsage: 0, unpricedCalls: 0, usage: { input: 0, output: 0 } },
          producers: [], missions: [], offTurnShare: null, coverage: { calls: 0, measured: 0, reported: 0, silent: [], partial: [] } };
      },
      async teardown() { throw new Error('DELETE did not answer'); },
    };
    let thrown = null;
    try {
      await runFirstRunCase({ open: async () => session }, {
        id: 'slate', purpose: 'teardown probe', modelCalls: 'none',
        run: async () => { throw new Error('the turn failed on its closed socket'); },
      }, []);
    } catch (error) { thrown = error; }
    console.log(JSON.stringify({ message: thrown?.message ?? null, all: (thrown?.errors ?? [thrown]).map((error) => error.message) }));
  `;

  const run = spawnSync('bun', ['-e', script], {
    cwd: join(import.meta.dirname, '../..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, BENCH_ARTIFACTS: root },
  });

  expect(run.status, run.stderr).toBe(0);

  const result = v.parse(v.object({ message: v.nullable(v.string()), all: v.array(v.string()) }), JSON.parse(run.stdout));

  expect(result.message).toBe('the turn failed on its closed socket');
  expect(result.all).toEqual(['the turn failed on its closed socket', 'DELETE did not answer']);
});
