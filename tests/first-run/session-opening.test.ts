import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';

test('session opening failures remain attempted cases with explicitly unavailable evidence', () => {
  // This fixture exercises the real durable-root policy, so it cannot live in /tmp.
  const parent = join(import.meta.dirname, '../../bench-artifacts');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'kinu-first-open-'));
  const firstRunModule = new URL('./first-run.ts', import.meta.url).href;
  const testUtilsModule = new URL('../../packages/test-utils/src/index.ts', import.meta.url).href;
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
