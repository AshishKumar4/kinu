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

/**
 * `KINU_RUNTIME_SCENARIO`, read ONCE and in one place.
 *
 * IT MUST NOT NARROW THIS SUITE AMBIENTLY, and it used to do exactly that. The
 * single test asserted `report.scenarios` equalled `[env.KINU_RUNTIME_SCENARIO]`
 * when the variable was set — so an eight-scenario matrix collapsed to one and
 * the equality still passed — and then `return`ed before every fact assertion:
 * group-commit batching, both mmap rounds, the first fence's extents, torn
 * intents, durable results, compaction shrinkage, the three raced shutdowns, and
 * the re-audit of a real exported fence through the production client. All of it
 * gone, one passing test reported, and nothing in the output saying so. A
 * variable exported in a shell, or left in a CI env block, silently turned this
 * suite into an eighth of itself.
 *
 * The narrowing is STRUCTURAL now: the two tests at the bottom are mutually
 * exclusive, and whichever one a run is not doing appears in the report as a
 * SKIP. A narrowed run can no longer look like a full one, because the
 * full-matrix test is visibly absent from it — and the narrowed test carries the
 * scenario name in its own title, so the report says which eighth it measured.
 */
const NARROWED = process.env.KINU_RUNTIME_SCENARIO;

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
    ...(NARROWED === undefined ? [] : ['-e', `KINU_RUNTIME_SCENARIO=${NARROWED}`]),
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

/** The matrix's own verdict, raised with every failing cell and check named. */
function assertMatrixOk(report: MatrixReport): void {
  if (report.ok) return;
  const failed = report.scenarios.flatMap((scenario) => [
    ...(scenario.error === undefined ? [] : [`${scenario.name}: ${scenario.error}`]),
    ...scenario.checks.filter((check) => !check.ok).map((check) => `${scenario.name}/${check.check}: ${check.detail}`),
  ]);
  throw new Error(`journal matrix failed: ${failed.join('; ')}`);
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

/** The matrix's scenarios, in the order it runs them. */
const SCENARIOS = [
  'posix-fence-continuity', 'kill-intent-recovery', 'kill-after-fence', 'journal-compaction',
  'seeded-base', 'unstageable-node', 'bounded-shutdown', 'shutdown-races',
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

function isScenarioName(name: string): name is ScenarioName {
  // SAFETY: `includes` checked tuple membership, the invariant ScenarioName declares; widening only relaxes the parameter.
  return (SCENARIOS as readonly string[]).includes(name);
}

/**
 * Every scenario the matrix runs, and the FACTS each one's report must carry.
 *
 * Enumerated as a total map rather than as a sequence of statements after the
 * matrix returns, because the narrowing knob below used to skip all of them at
 * once. A scenario whose report this suite makes no further claim about is an
 * EXPLICIT empty entry: `[]` is a decision someone wrote down, an absent key is
 * an omission, and the two used to look identical.
 */
const SCENARIO_FACTS = {
  'posix-fence-continuity': async (report) => {
    const fenced = scenarioNamed(report, 'posix-fence-continuity');
    expect(fenced.facts.groupCommit?.records ?? 0).toBeGreaterThan(fenced.facts.groupCommit?.batches ?? 0);
    expect(fenced.facts.mmapRounds?.before ?? 0).toBeGreaterThan(0);
    expect(fenced.facts.mmapRounds?.after ?? 0).toBeGreaterThan(0);
    expect(fenced.facts.firstFence?.extents ?? 0).toBeGreaterThan(0);
    /* The exported fence is re-verified by the production client, so the daemon's
     * manifest is proven acceptable to the capture surface that consumes it. */
    const fence = fenced.facts.exportedFence;
    if (fence === undefined) throw new Error('the fence scenario exported no fence');
    expect(await auditExportedFence(fence)).toBe('sealed');
  },
  'kill-intent-recovery': async (report) => {
    const recovery = scenarioNamed(report, 'kill-intent-recovery');
    expect(recovery.facts.tornIntents ?? 0).toBeGreaterThan(0);
    expect(recovery.facts.durableResults ?? 0).toBeGreaterThan(0);
  },
  /* Its checks live in the matrix cell; the report carries no fact this suite
   * re-derives. Declared so a reader knows that is deliberate. */
  'kill-after-fence': async () => {},
  'journal-compaction': async (report) => {
    const compacted = scenarioNamed(report, 'journal-compaction');
    expect(compacted.facts.journalBytesAfter ?? 0).toBeLessThan(compacted.facts.journalBytesBefore ?? 0);
  },
  'seeded-base': async () => {},
  'unstageable-node': async () => {},
  'bounded-shutdown': async () => {},
  'shutdown-races': async (report) => {
    /* A cell that stopped after its first entry would report no failure at all. */
    const raced = scenarioNamed(report, 'shutdown-races');
    expect(Object.keys(raced.facts.racedShutdowns ?? {})).toEqual(['stop', 'fence-stop', 'sigterm']);
  },
} satisfies Readonly<Record<ScenarioName, (report: MatrixReport) => Promise<void>>>;

describe('journal daemon runtime', () => {
  test.skipIf(NARROWED !== undefined)(
    'serves POSIX, seals fences and recovers from kills in a privileged FUSE container',
    async () => {
      const exportDir = await mkdtemp(join(exportBase, 'journal-runtime-'));
      exported.push(exportDir);
      const report = await runMatrix(exportDir);
      expect(report.scenarios.map((scenario) => scenario.name)).toEqual([...SCENARIOS]);
      assertMatrixOk(report);
      // Every scenario's facts, from the total map. No early return can drop one:
      // the loop's denominator is the enumeration this suite asserted the report
      // against on the line above.
      for (const name of SCENARIOS) await SCENARIO_FACTS[name](report);
    },
    1_800_000,
  );

  test.skipIf(NARROWED === undefined)(
    `KINU_RUNTIME_SCENARIO=${NARROWED ?? '<unset>'} — ONE scenario, not the matrix`,
    async () => {
      // The knob's own validity, checked before docker spends thirty minutes on a
      // typo. `journal-daemon-runtime-matrix.ts` also refuses an unknown name, but
      // it refuses inside the container after the image build. The re-read is what
      // narrows the type; `test.skipIf` cannot tell the compiler this body only
      // runs when the knob is set.
      const scenario = NARROWED;
      if (scenario === undefined) throw new Error('KINU_RUNTIME_SCENARIO is unset');
      if (!isScenarioName(scenario)) throw new Error(`unknown KINU_RUNTIME_SCENARIO: ${scenario}`);
      const exportDir = await mkdtemp(join(exportBase, 'journal-runtime-'));
      exported.push(exportDir);
      const report = await runMatrix(exportDir);
      expect(report.scenarios.map((candidate) => candidate.name)).toEqual([scenario]);
      assertMatrixOk(report);
      // The named scenario's OWN facts still hold. The narrowed path used to
      // assert `report.ok` and nothing else, so the one scenario a developer was
      // debugging was also the one whose facts stopped being checked.
      await SCENARIO_FACTS[scenario](report);
    },
    1_800_000,
  );
});
