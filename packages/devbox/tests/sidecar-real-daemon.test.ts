/**
 * The shipped `SidecarCore` over the real journal daemon: the FUSE mount, the
 * control socket and the staged delta the C daemon writes, inside the same
 * privileged image `journal-daemon-runtime.test.ts` uses. The stores stay in
 * memory; the daemon boundary is what this suite measures.
 *
 * The runner is `sidecar-real-daemon-run.ts`. It imports the package's own
 * sources, so the repository is mounted read-only at its own path, together
 * with the directory its `node_modules` entries resolve to.
 */

import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = resolve(packageRoot, '../..');
const daemonContext = join(packageRoot, 'bench', 'journal-daemon');
const image = 'kinu-journal-daemon:matrix';
const runner = join(packageRoot, 'tests', 'sidecar-real-daemon-run.ts');

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Report {
  readonly ok: boolean;
  readonly error?: string;
  readonly checks: readonly Check[];
  readonly facts: Readonly<Record<string, number | string>>;
}

/** Every check the runner makes, in order. A runner that stops early or
 *  loses a check fails here by name rather than by a shorter green list. */
const CHECKS = [
  'wal-progress-counts-the-bytes-written',
  'first-seal-publishes-generation-1',
  'generation-1-serves-the-mounted-tree',
  'wide-directory-is-paged',
  'open-descriptor-follows-inode-across-rename',
  'open-descriptor-keeps-unlinked-inode-after-replacement',
  'open-descriptor-answers-fstat-after-unlink',
  'unlinked-name-is-gone-while-the-descriptor-is-open',
  'nameless-descriptor-accepts-write-fsync-truncate',
  'second-seal-publishes-generation-3',
  'open-descriptor-survives-a-publish',
  'head-sealed-with-an-open-unlinked-inode-carries-no-hidden-name',
  'release-removes-the-hidden-name-from-the-backing-tree',
  'generation-3-serves-the-mutated-tree',
  'untouched-hardlink-twin-carries-bytes-written-through-the-unlinked-name',
  'published-hardlink-twin-follows-a-write-through-one-name',
  'fresh-boot-attaches',
  'fresh-boot-serves-the-compacted-tree',
  'seal-after-daemon-kill-serves-the-recovered-tree',
  'unsealed-write-before-the-kill-is-published',
  'published-chain-is-unbroken',
  'daemon-stops-cleanly',
] as const;

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
}

/** The directory the repository's dependencies really live in: a worktree
 *  links each `node_modules` entry into a shared install elsewhere. */
function dependencyRoot(): string {
  return dirname(realpathSync(join(repoRoot, 'node_modules', 'valibot')));
}

async function runSidecar(): Promise<Report> {
  const built = await run(['docker', 'build', '-t', image, daemonContext]);
  if (built.code !== 0) throw new Error(`daemon image build failed:\n${built.stderr.slice(-4000)}`);
  const dependencies = dependencyRoot();
  const mounts = [
    '-v', `${repoRoot}:${repoRoot}:ro`,
    ...(dependencies.startsWith(`${repoRoot}/`) ? [] : ['-v', `${dependencies}:${dependencies}:ro`]),
  ];
  const executed = await run([
    'docker', 'run', '--rm', '--privileged', '--device', '/dev/fuse',
    '--entrypoint', '/bin/sh',
    '-e', 'HOME=/tmp',
    ...mounts,
    '-w', repoRoot,
    image, '-lc', `mkdir -p /work && exec bun ${runner}`,
  ]);
  const line = executed.stdout.split('\n').find((candidate) => candidate.startsWith('REPORT '));
  if (line === undefined) {
    throw new Error(`the runner produced no report (code ${executed.code}):\n${executed.stdout.slice(-4000)}\n${executed.stderr.slice(-4000)}`);
  }
  return JSON.parse(line.slice('REPORT '.length));
}

describe('the v2 sidecar over the real journal daemon', () => {
  test('seals, publishes, compacts, collects and recovers a real mount, and keeps POSIX descriptor semantics', async () => {
    const report = await runSidecar();
    const failed = report.checks.filter((check) => !check.ok).map((check) => `${check.check}: ${check.detail}`);
    expect(report.error, failed.join('; ')).toBeUndefined();
    expect(report.checks.map((check) => check.check)).toEqual([...CHECKS]);
    expect(failed).toEqual([]);
    expect(report.facts.compacted).toBe(1);
    expect(Number(report.facts.gcDeletes)).toBeGreaterThan(0);
    // A fresh boot opens the head with one range read: the root record.
    expect(report.facts.freshAttachReads).toBe(1);
    expect(Number(report.facts.secondSealPuts)).toBeLessThan(Number(report.facts.firstSealPuts));
  }, 600_000);
});
