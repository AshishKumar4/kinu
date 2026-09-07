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
import { Miniflare } from 'miniflare';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = resolve(packageRoot, '../..');
const daemonContext = join(packageRoot, 'bench', 'journal-daemon');
const image = 'kinu-journal-daemon:matrix';
const runner = join(packageRoot, 'tests', 'sidecar-real-daemon-run.ts');

const ReportSchema = v.object({
  ok: v.boolean(),
  error: v.optional(v.string()),
  checks: v.array(v.object({ check: v.string(), ok: v.boolean(), detail: v.string() })),
  facts: v.record(v.string(), v.union([v.number(), v.string()])),
});
type Report = v.InferOutput<typeof ReportSchema>;

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

/**
 * The direct R2 transport's wire, served by workerd's R2 over HTTP: one PUT
 * per pack answered with an ETag, range GETs answered 206, DELETE. This is
 * the shape `DirectR2Store` speaks to the intercepted endpoint in production,
 * persisted to a directory so the bytes outlive the process.
 */
const R2_ENDPOINT_WORKER = `
export default {
  async fetch(request, env) {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (request.method === 'PUT') {
      const object = await env.BUCKET.put(key, await request.arrayBuffer());
      return new Response(null, { status: 200, headers: { etag: object.httpEtag } });
    }
    if (request.method === 'DELETE') {
      await env.BUCKET.delete(key);
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const range = request.headers.get('range');
    const span = range === null ? null : /^bytes=(\\d+)-(\\d+)$/u.exec(range);
    if (range !== null && span === null) return new Response(null, { status: 416 });
    const object = await env.BUCKET.get(key, span === null
      ? undefined
      : { range: { offset: Number(span[1]), length: Number(span[2]) - Number(span[1]) + 1 } });
    if (object === null) return new Response(null, { status: 404 });
    return new Response(object.body, { status: span === null ? 200 : 206, headers: { etag: object.httpEtag } });
  },
};
`;

async function withR2Endpoint<T>(body: (endpoint: string) => Promise<T>): Promise<T> {
  const persist = await mkdtemp(join(tmpdir(), 'sidecar-r2-'));
  const runtime = new Miniflare({
    host: '127.0.0.1',
    port: 0,
    resourcePersistencePath: persist,
    workers: [{
      config: {
        name: 'r2-endpoint', type: 'worker', compatibilityDate: '2026-04-14',
        manifest: {
          mainModule: 'index.mjs', modulesRoot: '/',
          modules: { 'index.mjs': { type: 'esm', contents: R2_ENDPOINT_WORKER } },
        },
        env: { BUCKET: { type: 'r2', name: 'BUCKET' } },
      },
    }],
  });
  try {
    const url = await runtime.ready;
    return await body(url.origin);
  } finally {
    await runtime.dispose();
    await rm(persist, { recursive: true, force: true });
  }
}

async function runSidecar(endpoint?: string): Promise<Report> {
  const built = await run(['docker', 'build', '-t', image, daemonContext]);
  if (built.code !== 0) throw new Error(`daemon image build failed:\n${built.stderr.slice(-4000)}`);
  const dependencies = dependencyRoot();
  const mounts = [
    '-v', `${repoRoot}:${repoRoot}:ro`,
    ...(dependencies.startsWith(`${repoRoot}/`) ? [] : ['-v', `${dependencies}:${dependencies}:ro`]),
  ];
  // The R2 endpoint listens on the host loopback, so the container shares the
  // host network for that run and nothing else changes.
  const network = endpoint === undefined ? [] : ['--network', 'host', '-e', `KINU_STORE_ENDPOINT=${endpoint}`];
  const executed = await run([
    'docker', 'run', '--rm', '--privileged', '--device', '/dev/fuse',
    '--entrypoint', '/bin/sh',
    '-e', 'HOME=/tmp',
    ...network,
    ...mounts,
    '-w', repoRoot,
    image, '-lc', `mkdir -p /work && exec bun ${runner}`,
  ]);
  const line = executed.stdout.split('\n').find((candidate) => candidate.startsWith('REPORT '));
  if (line === undefined) {
    throw new Error(`the runner produced no report (code ${executed.code}):\n${executed.stdout.slice(-4000)}\n${executed.stderr.slice(-4000)}`);
  }
  const report = v.parse(ReportSchema, JSON.parse(line.slice('REPORT '.length)));
  if (executed.code !== 0) throw new Error(`sidecar exited ${executed.code}: ${report.error ?? executed.stderr}`);
  return report;
}

function expectGreen(report: Report, store: string): void {
  const failed = report.checks.filter((check) => !check.ok).map((check) => `${check.check}: ${check.detail}`);
  expect(report.error, failed.join('; ')).toBeUndefined();
  expect(report.ok).toBe(true);
  expect(failed).toEqual([]);
  expect(report.facts.payloadStore).toBe(store);
  expect(report.facts.compacted).toBe(1);
  expect(Number(report.facts.gcDeletes)).toBeGreaterThan(0);
  // A fresh boot opens the head with one range read: the root record.
  expect(report.facts.freshAttachReads).toBe(1);
  expect(Number(report.facts.secondSealPuts)).toBeLessThan(Number(report.facts.firstSealPuts));
}

describe('the v2 sidecar over the real journal daemon', () => {
  test('seals, publishes, compacts, collects and recovers a real mount, and keeps POSIX descriptor semantics', async () => {
    expectGreen(await runSidecar(), 'memory');
  }, 600_000);

  test('does the same over the direct R2 transport against a persisted workerd bucket', async () => {
    const memory = await runSidecar();
    const r2 = await withR2Endpoint(async (endpoint) => await runSidecar(endpoint));
    expectGreen(r2, 'direct-r2');
    // The transport changes nothing the deciding metric counts: the same
    // number of store writes and the same bytes, seal for seal.
    for (const fact of ['firstSealPuts', 'firstSealBytes', 'secondSealPuts', 'secondSealBytes', 'gcDeletes', 'freshAttachReads'] as const) {
      expect(r2.facts[fact], fact).toBe(memory.facts[fact]);
    }
  }, 900_000);
});
