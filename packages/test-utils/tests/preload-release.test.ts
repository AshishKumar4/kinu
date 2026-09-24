// Under `--parallel` every test file runs in a fresh global, and a file's
// global is released only if nothing process-wide still points into it. The
// preload's plugins and a suite's `mock.module` both did, so every file of the
// cf-backend suite stayed resident until its worker exited: 1.4 GB of heap per
// worker and a 12 GB cgroup peak (measured 2026-09-24; scripts/test-preload.ts
// has the figures). This runs four throwaway files through the real preload, each
// holding a module mock and the plugin-served `cloudflare:workers`, and counts
// the live globals after a full GC as each file starts.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '../src/scratch';

const FILES = 4;

const ProbeLineSchema = v.object({ file: v.string(), globals: v.number() });

/** A preload that records how many globals survive a full GC as a file starts. */
const PROBE = `import { heapStats } from 'bun:jsc';
import { appendFileSync } from 'node:fs';
Bun.gc(true);
appendFileSync(process.env.KINU_PRELOAD_PROBE_LOG, JSON.stringify({ file: Bun.main, globals: heapStats().globalObjectCount }) + '\\n');
`;

/** A file that pins its global both ways: a module mock and a plugin-served module. */
const HELD_FILE = `import { expect, mock, test } from 'bun:test';
import { DurableObject } from 'cloudflare:workers';
const held = new Array(1_000_000).fill(1);
mock.module('node:os', () => ({ hostname: () => String(held.length) }));
test('holds its global', async () => {
  // Dynamic: a static import would load node:os before the mock above exists.
  const os = await import('node:os');
  expect([os.hostname(), typeof DurableObject]).toEqual(['1000000', 'function']);
});
`;

describe('the bun test preload', () => {
  test('a file\'s global is released when the file ends, plugins and module mocks included', async () => {
    const dir = scratchDir('preload-release');
    const log = join(dir, 'globals.jsonl');
    const probe = join(dir, 'probe.ts');
    const files = Array.from({ length: FILES }, (_, index) => join(dir, `held-${String(index)}.test.ts`));

    writeFileSync(probe, PROBE);
    writeFileSync(log, '');

    for (const file of files) writeFileSync(file, HELD_FILE);

    // From the repository root, so bunfig.toml's preload (the one under test) runs first.
    const run = Bun.spawn(['bun', 'test', '--timeout=0', '--parallel=1', '--preload', probe, ...files], {
      cwd: join(import.meta.dir, '..', '..', '..'),
      env: { ...process.env, KINU_PRELOAD_PROBE_LOG: log },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => v.parse(v.pipe(v.string(), v.parseJson(), ProbeLineSchema), line));

    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(lines.map((line) => line.file).sort()).toEqual([...files].sort());
    // One worker, files in turn: pinned globals read 1, 2, 3, 4; released ones never pass 2.
    expect(lines.map((line) => line.globals).filter((globals) => globals > 2)).toEqual([]);
  });
});
