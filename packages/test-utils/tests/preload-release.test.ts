// Measured 2026-10-18 on Bun 1.4.3: isolated files release their plugins and module mocks without manual cleanup.
// Four files retain at most two globals after GC, including when each file runs twice in the same process.
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

/** A file that pins its global both ways and loads a new worker on each rerun. */
const HELD_FILE = `import { expect, mock, test } from 'bun:test';
import { inProcessWorkerLoader } from ${JSON.stringify(join(import.meta.dir, '../../cf-backend/tests/helpers/worker-loader.ts'))};
const held = new Array(1_000_000).fill(1);
mock.module('node:os', () => ({ hostname: () => String(held.length) }));
test('loads a worker with its platform module and bindings', async () => {
  // The mock must register before the module loads.
  const os = await import('node:os');
  const worker = inProcessWorkerLoader().load({
    mainModule: 'worker.js',
    modules: {
      'worker.js': "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { inspect() { return { context: this.ctx, bindings: this.env }; } }",
    },
    env: { held: os.hostname() },
  });
  expect(await worker.getEntrypoint().inspect()).toEqual({ context: { props: {} }, bindings: { held: '1000000' } });
});
`;

describe('the bun test preload', () => {
  test('reruns can load workers, and each file releases its global, plugins and module mocks', async () => {
    const dir = scratchDir('preload-release');
    const log = join(dir, 'globals.jsonl');
    const probe = join(dir, 'probe.ts');
    const files = Array.from({ length: FILES }, (_, index) => join(dir, `held-${String(index)}.test.ts`));

    writeFileSync(probe, PROBE);
    writeFileSync(log, '');

    for (const file of files) writeFileSync(file, HELD_FILE);

    const run = Bun.spawn(['bun', 'test', '--timeout=0', '--parallel=1', '--rerun-each=2', '--preload', probe, ...files], {
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
