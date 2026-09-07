import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { buildJournalDaemonImage } from './support/journal-daemon-image';

const SnapshotReportSchema = v.object({
  firstRows: v.number(),
  secondRows: v.number(),
  fullPages: v.number(),
  deltaPages: v.number(),
  wrongRevisionRefused: v.literal(true),
  corruptJournalRefused: v.literal(true),
});

const AttachReportSchema = v.object({
  files: v.number(),
  imageBytes: v.number(),
  genesisIngested: v.number(),
  attachFetches: v.number(),
  lookupFetches: v.number(),
  lookupSteps: v.number(),
  lookupFullscanSteps: v.number(),
});

const COMPILE = 'cc -std=c17 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror -Wpedantic -I/usr/local/src';
const NAMESPACE_SOURCES = '/usr/local/src/journal-namespace.c /usr/local/src/namespace-pages.c /usr/local/src/journal-delta.c';

/** Compile one probe inside the daemon image and run it once per argument list. */
async function runProbe(name: string, sources: string, runs: readonly string[]): Promise<string[]> {
  const image = await buildJournalDaemonImage(fileURLToPath(new URL('../bench/journal-daemon', import.meta.url)));
  const source = fileURLToPath(new URL(`./support/${name}.c`, import.meta.url));
  const script = [
    'set -eu',
    'scratch=$(mktemp -d)',
    'trap \'rm -rf "$scratch"\' EXIT',
    `${COMPILE} /probe.c ${sources} -lsqlite3 -lcrypto -pthread -o "$scratch/probe"`,
    ...runs.map((run) => `state=$(mktemp -d -p "$scratch"); "$scratch/probe" "$state" ${run}`),
  ];
  const child = Bun.spawn([
    'docker', 'run', '--rm', '-v', `${source}:/probe.c:ro`, '--entrypoint', '/bin/sh', image, '-c', script.join('; '),
  ], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout.split('\n').filter((line) => line !== '');
}

test('SQLite snapshots exclude later writes and retain their delta across acknowledgement and restart', async () => {
  const [line] = await runProbe('namespace-pages-probe', '/usr/local/src/namespace-pages.c', ['']);
  const report = v.parse(SnapshotReportSchema, JSON.parse(line ?? ''));
  expect([report.firstRows, report.secondRows]).toEqual([1000, 1001]);
  expect(report.deltaPages).toBeLessThan(report.fullPages);
}, 120_000);

test('a lazy attach and one lookup fetch a bounded page set while the image grows fiftyfold', async () => {
  const lines = await runProbe('namespace-attach-probe', NAMESPACE_SOURCES, ['1000 /tmp/probe-1000.sock', '50000 /tmp/probe-50000.sock']);
  const [small, large] = lines.map((line) => v.parse(AttachReportSchema, JSON.parse(line)));
  if (small === undefined || large === undefined) throw new Error(`two reports expected, got ${lines.length}`);
  expect(large.imageBytes).toBeGreaterThan(30 * small.imageBytes);
  for (const report of [small, large]) {
    expect(report.genesisIngested).toBe(report.files + 2);
    expect(report.attachFetches).toBeLessThanOrEqual(4);
    expect(report.lookupFetches).toBeLessThanOrEqual(4);
    expect(report.lookupFullscanSteps).toBe(0);
  }
  expect(large.lookupSteps).toBe(small.lookupSteps);
}, 180_000);
