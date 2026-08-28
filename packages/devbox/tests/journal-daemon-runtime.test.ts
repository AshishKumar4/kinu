import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { captureFromJournalFence } from '../src/capture/journal/client';
import { readCaptureRange, requireAuditedCapture } from '../src/capture/model';
import type { ExportedFence, MatrixReport, ScenarioReport } from './journal-daemon-runtime-types';

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const testsRoot = join(packageRoot, 'tests');
const daemonContext = join(packageRoot, 'bench', 'journal-daemon');
const image = 'kinu-journal-daemon:matrix';
const probeSource = join(testsRoot, 'journal-daemon-runtime-probe.c');
const matrixEntry = join(testsRoot, 'journal-daemon-runtime-matrix.ts');
/* The sealed stage and the tree it copies must live on a filesystem that keeps
 * holes: /tmp is tmpfs here and reports a fully allocated file. */
const exportBase = '/var/tmp';

const exported: string[] = [];
/* The daemon writes the export as root, so the image that ran it removes what it
 * left: the host only ever owns the temporary directory itself. */
afterAll(async () => {
  for (const dir of exported.splice(0)) {
    await run(['docker', 'run', '--rm', '-v', `${dir}:${dir}`, '--entrypoint', 'find', image, dir, '-mindepth', '1', '-delete']);
    await rm(dir, { recursive: true });
  }
});

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
}

/** Runs the matrix in a privileged container and exports one sealed fence. */
async function runMatrix(exportDir: string): Promise<MatrixReport> {
  /* The image compiles the daemon with -Wall -Wextra -Werror -Wpedantic, so a
   * successful build is the proof that the C sources stay warning free. */
  const built = await run(['docker', 'build', '-t', image, daemonContext]);
  if (built.code !== 0) throw new Error(`daemon image build failed:\n${built.stderr.slice(-4000)}`);

  const script = [
    'cc -std=c17 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror -Wpedantic -O2',
    probeSource, '-o /tmp/journal-daemon-runtime-probe -pthread',
    `&& exec bun ${matrixEntry}`,
  ].join(' ');
  const env = [
    '-e', 'HOME=/tmp',
    '-e', `KINU_EXPORT_DIR=${exportDir}`,
    '-e', `KINU_EXPORT_UID=${process.getuid?.() ?? 0}`,
    ...(process.env.KINU_RUNTIME_SCENARIO === undefined
      ? []
      : ['-e', `KINU_RUNTIME_SCENARIO=${process.env.KINU_RUNTIME_SCENARIO}`]),
  ];
  const executed = await run([
    'docker', 'run', '--rm', '--privileged', '--device', '/dev/fuse',
    '--entrypoint', '/bin/sh',
    ...env,
    '-v', `${testsRoot}:${testsRoot}:ro`,
    '-v', `${exportDir}:${exportDir}`,
    '-w', '/tmp',
    image, '-lc', script,
  ]);
  const line = executed.stdout.split('\n').find((candidate) => candidate.startsWith('REPORT '));
  if (line === undefined) {
    throw new Error(`the matrix produced no report (code ${executed.code}):\n${executed.stdout.slice(-4000)}\n${executed.stderr.slice(-4000)}`);
  }
  const report: MatrixReport = JSON.parse(line.slice('REPORT '.length));
  if (report.scenarios.length === 0) throw new Error('the matrix report carries no scenario');
  return report;
}

function scenarioNamed(report: MatrixReport, name: string): ScenarioReport {
  const scenario = report.scenarios.find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`the matrix never ran ${name}`);
  return scenario;
}

/** Re-reads one real fence with the production client the daemon serves. */
async function auditExportedFence(fence: ExportedFence): Promise<string> {
  const capture = requireAuditedCapture(await captureFromJournalFence(fence, {
    captureId: `capture-${fence.cut}`,
    epoch: String(fence.generation),
    baseRevision: String(fence.generation),
    stableStageHandle: `fence-c${fence.cut}-g${fence.generation}`,
  }));
  expect(capture.capturedCut.cut).toBe(String(fence.cut));
  const entry = capture.entries.find((candidate) => candidate.path === 'posix/create.txt');
  if (entry === undefined) throw new Error('the exported capture has no posix/create.txt');
  return new TextDecoder().decode(await readCaptureRange(capture, entry, 6, 6));
}

describe('journal daemon runtime', () => {
  test('serves POSIX, seals fences and recovers from kills in a privileged FUSE container', async () => {
    const exportDir = await mkdtemp(join(exportBase, 'journal-runtime-'));
    exported.push(exportDir);
    const report = await runMatrix(exportDir);
    const expected = [
      'posix-fence-continuity',
      'kill-intent-recovery',
      'kill-after-fence',
      'journal-compaction',
      'seeded-base',
      'unstageable-node',
      'bounded-shutdown',
      'shutdown-races',
    ];
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual(
      process.env.KINU_RUNTIME_SCENARIO === undefined ? expected : [process.env.KINU_RUNTIME_SCENARIO],
    );
    if (!report.ok) {
      const failed = report.scenarios.flatMap((scenario) => [
        ...(scenario.error === undefined ? [] : [`${scenario.name}: ${scenario.error}`]),
        ...scenario.checks.filter((check) => !check.ok).map((check) => `${scenario.name}/${check.check}: ${check.detail}`),
      ]);
      throw new Error(`journal matrix failed: ${failed.join('; ')}`);
    }
    if (process.env.KINU_RUNTIME_SCENARIO !== undefined) return;

    const fenced = scenarioNamed(report, 'posix-fence-continuity');
    expect(fenced.facts.groupCommit?.records ?? 0).toBeGreaterThan(fenced.facts.groupCommit?.batches ?? 0);
    expect(fenced.facts.mmapRounds?.before ?? 0).toBeGreaterThan(0);
    expect(fenced.facts.mmapRounds?.after ?? 0).toBeGreaterThan(0);
    expect(fenced.facts.firstFence?.extents ?? 0).toBeGreaterThan(0);

    const recovery = scenarioNamed(report, 'kill-intent-recovery');
    expect(recovery.facts.tornIntents ?? 0).toBeGreaterThan(0);
    expect(recovery.facts.durableResults ?? 0).toBeGreaterThan(0);

    const compacted = scenarioNamed(report, 'journal-compaction');
    expect(compacted.facts.journalBytesAfter ?? 0).toBeLessThan(compacted.facts.journalBytesBefore ?? 0);

    /* A cell that stopped after its first entry would report no failure at all. */
    const raced = scenarioNamed(report, 'shutdown-races');
    expect(Object.keys(raced.facts.racedShutdowns ?? {})).toEqual(['stop', 'fence-stop', 'sigterm']);

    /* The exported fence is re-verified by the production client, so the daemon's
     * manifest is proven acceptable to the capture surface that consumes it. */
    const fence = fenced.facts.exportedFence;
    if (fence === undefined) throw new Error('the fence scenario exported no fence');
    expect(await auditExportedFence(fence)).toBe('sealed');
  }, 1_800_000);
});
