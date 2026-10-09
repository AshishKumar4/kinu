import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchDir } from '../packages/test-utils/src/scratch';
import {
  adoptDownloads, adoptTarball, artifactDigest, downloadsServed, evalVerdictRefusal, imagesStagingNeverRan, planRollback, readDownloads,
  readEvalsVerdict, verifyServing, type EvalVerdict, type Promotion, type Verified,
} from './promote';
import type { Reset } from './reset';

/** A build's dist, as Vite and the release scripts leave it. */
function dist(files: Readonly<Record<string, string>>): string {
  const root = scratchDir('promote-dist');

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  return root;
}

const BUILD = {
  'kinu/index.js': 'export default {}',
  'kinu/wrangler.json': '{"name":"kinu"}',
  'client/index.html': '<html></html>',
  'client/downloads/kinu-version.json': '{"sha":"abc"}',
};

// A container's code is its image, and each environment names its images in its own section of wrangler.jsonc.
test('production may run only the container images staging ran', () => {
  const staging = new Map([['KinuDevbox', 'sandbox@sha256:aaa'], ['CodexEgress', 'egress@sha256:bbb']]);

  expect(imagesStagingNeverRan(new Map(staging), staging)).toEqual([]);
  expect(imagesStagingNeverRan(new Map([...staging, ['CodexEgress', 'egress@sha256:ccc']]), staging)).toEqual(['CodexEgress (egress@sha256:ccc)']);
  expect(imagesStagingNeverRan(new Map([...staging, ['NewBox', 'box@sha256:ddd']]), staging)).toEqual(['NewBox (box@sha256:ddd)']);
});

describe('the artifact digest', () => {
  test('is the Worker and client, not the environment\'s config nor the downloads promotion copies', () => {
    const production = artifactDigest(dist(BUILD));

    expect(artifactDigest(dist({ ...BUILD, 'kinu/wrangler.json': '{"name":"kinu-staging"}' }))).toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'client/downloads/kinu-version.json': '{"sha":"def"}' }))).toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'kinu/index.js': 'export default { fetch() {} }' }))).not.toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'client/landing.html': '' }))).not.toBe(production);
  });
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const TARBALL = 'kinu-worker-1+abc.tar.gz';

/**
 * One deploy's downloads as it publishes them: each CLI artifact and its checksum, the release manifest, the worker
 * tarball's checksum, and the stamp signing them all. `run` stands for what differs between two deploys of one
 * commit, such as the stamp's signing time and the re-packed archives.
 */
function published(sha: string, run: string, tarball = `worker ${run}`): Map<string, string> {
  const artifacts = { 'kinu-cli-linux-x64.tar.gz': `cli ${run}` };
  const checksums = Object.fromEntries(Object.entries({ ...artifacts, [TARBALL]: tarball }).map(([name, text]) => [`/downloads/${name}`, sha256(text)]));

  return new Map([
    ['kinu-version.json', JSON.stringify({ sha, builtAt: run, checksums })],
    ['release.json', JSON.stringify({ sha, builtAt: run })],
    [`${TARBALL}.sha256`, `${sha256(tarball)}  ${TARBALL}\n`],
    ...Object.entries(artifacts).flatMap(([name, text]) => [[name, text], [`${name}.sha256`, `${sha256(text)}  ${name}\n`]] as const),
  ]);
}

/** Every download of `files`, by name, with its hash: what a green run's record lists. */
const listed = (files: ReadonlyMap<string, string>): Record<string, string> =>
  Object.fromEntries([...files].map(([name, text]) => [name, sha256(text)]));

const record = (files: ReadonlyMap<string, string>, sha = 'abc'): Verified =>
  ({ sha, digest: 'd'.repeat(64), stagingVersion: 'v-1', recordedAt: '2026-09-26T00:00:00.000Z', downloads: listed(files) });

describe('a deployment\'s downloads', () => {
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => { await Promise.all(stops.splice(0).map(async (stop) => stop())); });

  /**
   * A deployment serving `files` under /downloads, the worker tarball through its R2 route, and `health` as the build
   * its health names, answer by answer: the last one stays.
   */
  function deployment(files: ReadonlyMap<string, string>, served: { tarball?: string; health?: readonly string[] } = {}): string {
    const health = [...served.health ?? []];

    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;

        if (path === '/api/health') {
          const sha = health.length > 1 ? health.shift() : health[0];

          return sha === undefined ? new Response('<html></html>') : Response.json({ ok: true, build: { sha } });
        }

        const name = path.replace('/downloads/', '');
        const text = name === TARBALL ? served.tarball : files.get(name);

        return text === undefined ? new Response('missing', { status: 404 }) : new Response(text);
      },
    });

    stops.push(async () => server.stop(true));

    return `http://127.0.0.1:${String(server.port)}`;
  }

  describe('staging\'s, adopted', () => {
    test('every download the green run published is kept, and the signed worker tarball is named for R2', async () => {
      const green = published('abc', 'green', 'worker bytes');
      const dir = join(scratchDir('promote-downloads'), 'downloads');

      expect(await adoptDownloads(deployment(green), record(green), dir)).toEqual({ name: TARBALL, sha256: sha256('worker bytes') });

      for (const [name, text] of green) expect(readFileSync(join(dir, name), 'utf8')).toBe(text);
    });

    // P1, review job 150: a staging re-deploy of the same commit re-signs and re-packs everything, consistently, and
    // its tiers may still be red. Staging then serves downloads no green run verified.
    test('a later deploy\'s downloads of the same commit are refused, however consistent, and nothing is kept', async () => {
      const dir = join(scratchDir('promote-downloads'), 'downloads');
      const origin = deployment(published('abc', 'red re-deploy'));

      await expect(adoptDownloads(origin, record(published('abc', 'green')), dir)).rejects.toThrow(/is not the file its green run published/);
      expect(existsSync(dir)).toBe(false);
    });

    test('a download the signed stamp does not sign as served is refused', async () => {
      const inconsistent = new Map([...published('abc', 'green'), ['kinu-cli-linux-x64.tar.gz', 'other bytes']]);

      await expect(adoptDownloads(deployment(inconsistent), record(inconsistent), join(scratchDir('promote-downloads'), 'downloads')))
        .rejects.toThrow(/kinu-cli-linux-x64\.tar\.gz does not hash as the signed stamp says/);
    });

    test('downloads of another commit are refused', async () => {
      const other = published('def', 'green');

      await expect(adoptDownloads(deployment(other), record(other), join(scratchDir('promote-downloads'), 'downloads')))
        .rejects.toThrow(/the signed stamp is def's, not abc's/);
    });
  });

  // The build production serves before its first promotion is its history's first entry: a rollback of that promotion
  // proves itself against these hashes, so a download missing here would fail the rollback it exists for.
  test('the downloads a deployment serves are every file its deploy published', async () => {
    const files = published('abc', 'green');
    const origin = deployment(files);

    expect(await downloadsServed(origin)).toEqual({ sha: 'abc', downloads: listed(files) });
    expect([...(await readDownloads(origin, listed(files))).keys()].sort()).toEqual([...files.keys()].sort());
  });

  describe('production\'s, after a rollback', () => {
    const target = (files: ReadonlyMap<string, string>): Promotion =>
      ({ sha: 'abc', version: 'v-1', at: '2026-09-26T00:00:00.000Z', downloads: listed(files) });

    const pauses: number[] = [];

    const pause = async (ms: number): Promise<void> => { pauses.push(ms); };

    afterEach(() => { pauses.splice(0); });

    test('is proven once the edge serves the build, every download and the worker tarball byte for byte', async () => {
      const files = published('abc', 'green', 'worker bytes');
      const origin = deployment(files, { tarball: 'worker bytes', health: ['bad', 'bad', 'abc'] });

      expect(await verifyServing(origin, target(files), fetch, pause)).toBeUndefined();
      expect(pauses).toHaveLength(2);
    });

    test('is refused while the edge keeps serving another build, or serves another worker tarball', async () => {
      const files = published('abc', 'green', 'worker bytes');

      await expect(verifyServing(deployment(files, { tarball: 'worker bytes', health: ['bad'] }), target(files), fetch, pause))
        .rejects.toThrow(/serves bad, not abc/);
      await expect(verifyServing(deployment(files, { tarball: 'other worker', health: ['abc'] }), target(files), fetch, pause))
        .rejects.toThrow(/kinu-worker-1\+abc\.tar\.gz is not the tarball the signed stamp names/);
    });
  });
});

// P2, review job 150: staging's bucket holds the tarball of the LAST upload of a commit, which may be a run that went
// red after it; production's release manifest signs the green run's.
describe('the worker release tarball, adopted', () => {
  const signed = { name: TARBALL, sha256: sha256('worker bytes') };

  test('only the bytes the signed stamp names reach production\'s bucket, with their checksum', async () => {
    const put: [string, string, string][] = [];

    const to = async (name: string, bytes: Uint8Array, type: string): Promise<void> => {
      put.push([name, new TextDecoder().decode(bytes), type]);
    };

    const checksum = new TextEncoder().encode(`${signed.sha256}  ${TARBALL}\n`);

    await adoptTarball(signed, checksum, async () => new TextEncoder().encode('worker bytes'), to);
    expect(put).toEqual([[TARBALL, 'worker bytes', 'application/gzip'], [`${TARBALL}.sha256`, `${signed.sha256}  ${TARBALL}\n`, 'text/plain']]);

    put.splice(0);

    await expect(adoptTarball(signed, checksum, async () => new TextEncoder().encode('a red run\'s worker'), to))
      .rejects.toThrow(/is not the tarball the signed stamp names/);
    expect(put).toEqual([]);
  });
});

describe('a rollback', () => {
  const promotion = (version: string): Promotion => ({ sha: `sha-${version}`, version, at: '2026-09-26T00:00:00.000Z', downloads: {} });

  const withdrawn = (version: string, withdrawnAt: string): Promotion => ({ ...promotion(version), withdrawnAt });

  const HISTORY = [promotion('v1'), promotion('v2'), promotion('v3')];

  test('returns to the build before the one serving, and withdraws the one it leaves', () => {
    expect(planRollback(HISTORY, 'v3', 'now', undefined)).toEqual({ target: promotion('v2'), history: [promotion('v1'), promotion('v2'), withdrawn('v3', 'now')] });
  });

  // A promotion red after its upload serves a version the history never took.
  test('from a version the history never took returns to the newest build', () => {
    expect(planRollback(HISTORY, 'v4-red', 'now', undefined)).toEqual({ target: promotion('v3'), history: HISTORY });
  });

  test('never returns to a build a rollback left, and walks back one build at a time', () => {
    const left = [promotion('v1'), withdrawn('v2', 'then'), promotion('v3')];

    expect(planRollback(left, 'v3', 'now', undefined)).toMatchObject({ target: promotion('v1') });
    expect(planRollback([...left, promotion('v4')], 'v4', 'now', undefined)).toMatchObject({ target: promotion('v3') });
    expect(planRollback(HISTORY, 'v1', 'now', undefined)).toEqual({ refused: expect.stringContaining('holds no build older than version v1') });
  });

  const reset = (at: string): Reset => ({
    environment: 'production', worker: 'kinu', tag: `reset-${at}`, at, placeholderVersion: 'p', classes: [], applications: [],
  });

  // Load-bearing: the platform serves a rollback across a reset, and every Durable Object call then throws.
  test('refuses by name to cross a reset a later promotion carries, or one a red promotion left unrecorded', () => {
    const wiped = { ...promotion('v3'), reset: reset('2026-09-27T00:00:00.000Z') };

    expect(planRollback([promotion('v1'), promotion('v2'), wiped], 'v3', 'now', undefined))
      .toEqual({ refused: expect.stringContaining('reset-2026-09-27T00:00:00.000Z') });
    expect(planRollback(HISTORY, 'v4-red', 'now', reset('2026-09-27T00:00:00.000Z')))
      .toEqual({ refused: expect.stringContaining('reset-2026-09-27T00:00:00.000Z') });
    expect(planRollback(HISTORY, 'v4-red', 'now', reset('2026-09-25T00:00:00.000Z'))).toMatchObject({ target: promotion('v3') });
  });
});

// THE STATISTICS GATE PRODUCTION: a staging build is promoted on its evals verdict file, never on a run's own
// conclusion, which is green whenever the run finished, however its trials went.
describe('the eval verdict a promotion waits for', () => {
  const verdict = (pass: boolean, reason: string): EvalVerdict => ({ pass, reason });

  test('only a passing verdict file lets a build through', () => {
    expect(evalVerdictRefusal(verdict(true, '5/5 held on every task'), 'verified/abc.json')).toBeUndefined();
    expect(evalVerdictRefusal(undefined, 'verified/abc.json')).toBe('no eval verdict yet: verified/abc.json names none');
    expect(evalVerdictRefusal(verdict(false, 'coding fell 5/5 to 1/5'), 'verified/abc.json'))
      .toBe('the eval verdict refuses: coding fell 5/5 to 1/5 (verified/abc.json)');
  });

  test('a completed pilot cannot authorize a promotion even if its comparison says pass', () => {
    const dir = scratchDir('promote-evals-verdict');

    mkdirSync(join(dir, 'comparison'), { recursive: true });
    writeFileSync(join(dir, 'comparison', 'verdict.json'), JSON.stringify({ pass: true, reason: 'held' }));
    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      definitions: 'abcdef1', candidateBuild: 'abcdef1', baselineBuild: 'abcdef2',
      taskFiles: ['evals/tasks/chess.eval.ts', 'evals/tasks/swarm.eval.ts'], models: ['opencode-go/muse-spark-1.3-contributor'],
      arms: ['product'], trials: 2, startedAt: 1, job: 'armada-job', postJob: 'armada-post', pool: 3, pass: false,
    }));

    expect(() => readEvalsVerdict(dir, 'abcdef1')).toThrow('full statistical matrix');
  });
});
