import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '../packages/test-utils/src/scratch';
import {
  adoptDownloads, adoptTarball, adoptedRecord, artifactDigest, builtKey, downloadsServed, evalGateRefusal, evalsKey, imagesStagingNeverRan, overrideKey,
  planRollback, readDailyVerdict, readDownloads, readEvalsVerdict, stagingReds, verifiedKey, verifyServing, withdraw, writeOverride, DailyOutcomeSchema, DailyVerdictSchema, dailyReplacementRefusal, resultsOfTasks, type DailyVerdict, type Promotion, type Records,
  type Verified,
} from './promote';
import { ResetSchema, type Reset } from './reset';
import { isEvalTask, trackedFiles } from './sources';
import { suiteTasks } from './evals-suites';

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
  'front/index.js': 'export default {}',
  'front/wrangler.json': '{"name":"kinu-front"}',
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
  test('is the Workers and client, not the environment\'s configs nor the downloads promotion copies', () => {
    const production = artifactDigest(dist(BUILD));

    expect(artifactDigest(dist({ ...BUILD, 'kinu/wrangler.json': '{"name":"kinu-staging"}' }))).toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'front/wrangler.json': '{"name":"kinu-staging-front"}' }))).toBe(production);
    expect(artifactDigest(dist({ ...BUILD, 'front/index.js': 'export default { fetch() {} }' }))).not.toBe(production);
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

          return sha === undefined ? new Response('<html></html>')
            : Response.json({ ok: true, build: { version: `0.2.0+${sha}`, sha, builtAt: '2026-10-14T00:00:00.000Z' } });
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
  const promotion = (version: string): Promotion & { readonly front: string } => ({
    sha: `sha-${version}`, version, front: `front-${version}`, at: '2026-09-26T00:00:00.000Z', downloads: {},
  });

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

  // Its host's custom domain is the front's, and a rollback returns both Workers: a build from before the front has none.
  test('refuses to return to a build from before the front Worker', () => {
    const { front: _, ...before } = promotion('v1');

    expect(planRollback([before, promotion('v2')], 'v2', 'now', undefined)).toEqual({ refused: expect.stringContaining('before its front Worker') });
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

  test('reads production\'s 2026-10-08 record and permits rollback only within its reset', () => {
    // Production's stored record, captured before reset-deploy recovery changed the pre-upload gate.
    const stored = v.parse(ResetSchema, JSON.parse(`{
      "environment":"production","worker":"kinu","tag":"reset-20261008T141400Z",
      "at":"2026-10-08T14:14:00.632Z","placeholderVersion":"07413ddd-7ce9-4373-8b7e-51f18bd6c497",
      "classes":[
        {"className":"CodexEgress","namespace":"9c57bda830d84e19b393dfa06be3b3db"},
        {"className":"ControlPlaneDO","namespace":"1296283c2f3e410dac12e49a7b48020f"},
        {"className":"DeployRunDO","namespace":"77289c3daf6042a598a436e5aa27732c"},
        {"className":"KinuDevbox","namespace":"f98a35af684342a6863a34290d97457d"},
        {"className":"MonitorDO","namespace":"8a630ca6558d48b9bdde91ccd6dc7929"},
        {"className":"MossaicShardDO","namespace":"6975e6a6704f4cbeaf60dffb07630983"},
        {"className":"MossaicUserDO","namespace":"803e03c29b82422b872034bb4658a5ca"},
        {"className":"OrchestratorAgent","namespace":"5f50173b974d4ecab0896135de51bf09"},
        {"className":"UserDO","namespace":"17ad06da85b64943ae393669afe6ac8c"}
      ],
      "applications":[
        {"name":"kinu-kinudevbox","id":"f98a35af684342a6863a34290d97457d"},
        {"name":"kinu-codexegress","id":"a03536bf-dcab-4248-ac9f-2f30dd0a9fee"}
      ],
      "state":"done","chains":{"bucket":"kinu-backups","prefix":"boxes/","objects":0}
    }`));

    const before = { ...promotion('before'), at: '2026-10-08T13:00:00.000Z' };
    const after = { ...promotion('after'), at: '2026-10-08T15:00:00.000Z', reset: stored };
    const current = { ...promotion('current'), at: '2026-10-09T12:00:00.000Z' };
    const history = [before, after, current];

    const rollback = planRollback(history, current.version, '2026-10-09T13:00:00.000Z', stored);

    expect(rollback).toMatchObject({ target: after });
    expect('refused' in planRollback(history, after.version, '2026-10-09T13:00:00.000Z', stored)).toBe(true);
  });
});

// THE STATISTICS GATE PRODUCTION (owner, 2026-10-21, "Daily gated release"): production promotes whenever staging is
// green, on the latest daily verdict, fresh and no regression; a regression is a P1, held until a fix's own run passes.
describe('the eval gate a promotion waits for', () => {
  const sha = 'c'.repeat(40);
  const now = Date.parse('2026-10-22T12:00:00.000Z');

  const daily = (outcome: DailyVerdict['outcome'], measuredAt: string): DailyVerdict => ({
    measured: 'p'.repeat(40), definitions: 'd'.repeat(40), baseline: null, jobs: ['armada-daily'], outcome, measuredAt, recordedAt: measuredAt,
    verdict: { pass: outcome !== 'regressed' && outcome !== 'inconclusive', reason: `${outcome}.` },
  });

  const own = (pass: boolean) => ({ candidateBuild: sha, verdict: { pass, reason: pass ? 'Unchanged.' : 'Regressed.' } });

  /** The two suites' verdicts as the gate reads them: the daily one, and no computer verdict yet unless given. */
  const gate = (fast: DailyVerdict | undefined, computer?: DailyVerdict, computerChanged: readonly string[] = []) => ({ daily: fast, computer, computerChanged });

  test('a fresh daily verdict that is no regression lets any build through, with no run of its own', () => {
    expect(['unchanged', 'improved', 'baseline', 'rebaselined'].map((outcome) => evalGateRefusal(sha, gate(daily(v.parse(DailyOutcomeSchema, outcome), '2026-10-21T13:00:00.000Z')), undefined, now)))
      .toEqual([undefined, undefined, undefined, undefined]);
  });

  test('none at all holds every build, and says the daily run records the first', () => {
    expect(evalGateRefusal(sha, gate(undefined), undefined, now)).toContain('no eval verdict yet: no daily run has recorded one');
  });

  // Review finding (2026-10-21): freshness is the trials' end, not when the run was recorded, and a time ahead of the
  // clock is no evidence of it.
  test('one whose trials ended more than 26 hours ago holds, saying how old, as does one dated ahead of the clock', () => {
    expect({
      old: evalGateRefusal(sha, gate({ ...daily('unchanged', '2026-10-21T09:00:00.000Z'), recordedAt: '2026-10-22T11:00:00.000Z' }), undefined, now),
      ahead: evalGateRefusal(sha, gate(daily('unchanged', '2026-10-23T12:00:00.000Z')), undefined, now),
    }).toEqual({ old: expect.stringContaining('the latest daily eval verdict is 27.0 h old'), ahead: expect.stringContaining('h old') });
  });

  test('a regression holds as a P1, until a fix\'s own run passes on its very build', () => {
    const regressed = gate(daily('regressed', '2026-10-22T06:00:00.000Z'));

    expect({
      held: evalGateRefusal(sha, regressed, undefined, now), ownRed: evalGateRefusal(sha, regressed, own(false), now) !== undefined,
      otherBuild: evalGateRefusal(sha, regressed, { ...own(true), candidateBuild: 'e'.repeat(40) }, now) !== undefined,
      fixed: evalGateRefusal(sha, regressed, own(true), now),
    }).toEqual({ held: expect.stringContaining('a regression, a P1'), ownRed: true, otherBuild: true, fixed: undefined });
  });

  test('the first daily run\'s record, written before outcomes and trial ends were, reads as the baseline it was', () => {
    const first = { measured: 'p'.repeat(40), definitions: 'd'.repeat(40), baseline: null, jobs: ['armada-daily'], verdict: { pass: true, reason: 'The first.' }, recordedAt: '2026-10-22T03:00:00.000Z' };

    expect(v.parse(DailyVerdictSchema, first)).toMatchObject({ outcome: 'baseline', measuredAt: '2026-10-22T03:00:00.000Z' });
  });

  // Review findings (2026-10-21): a replayed run is never newer evidence, and a moved suite never clears a regression
  // unless production serves a build whose own run passed.
  test('a daily run replaces the standing verdict only with newer evidence, and a re-baseline clears no regression', () => {
    const regressed = daily('regressed', '2026-10-22T06:00:00.000Z');
    const later = '2026-10-23T06:00:00.000Z';

    expect({
      first: dailyReplacementRefusal(undefined, { outcome: 'baseline', measuredAt: later }, false),
      replayed: dailyReplacementRefusal(daily('unchanged', later), { outcome: 'unchanged', measuredAt: '2026-10-22T06:00:00.000Z' }, false),
      // Second review: each day that does not compare keeps the regression, however many follow.
      overRegression: (['baseline', 'rebaselined', 'inconclusive'] as const).map((outcome) => dailyReplacementRefusal(regressed, { outcome, measuredAt: later }, false) !== undefined),
      rebaselinedOnFix: dailyReplacementRefusal(regressed, { outcome: 'rebaselined', measuredAt: later }, true),
      comparedAndHeld: dailyReplacementRefusal(regressed, { outcome: 'unchanged', measuredAt: later }, false),
      newerRegression: dailyReplacementRefusal(regressed, { outcome: 'regressed', measuredAt: later }, false),
    }).toEqual({
      first: undefined, replayed: expect.stringContaining('stands, no older'), overRegression: [true, true, true],
      rebaselinedOnFix: undefined, comparedAndHeld: undefined, newerRegression: undefined,
    });
  });

  test('an inconclusive day holds as no evidence that nothing regressed, not as a P1', () => {
    expect(evalGateRefusal(sha, gate(daily('inconclusive', '2026-10-22T06:00:00.000Z')), undefined, now)).toContain('inconclusive, no evidence');
  });

  // The owner, 2026-10-21, "Fast daily, Minecraft weekly": the gate reads both suites' verdicts, the computer one at most
  // 8 days old and measuring every computer or desktop change the build has; a computer regression is a P1 as well.
  test("the computer suite's verdict holds on a regression, on 8 days' age, and on a computer change it never measured", () => {
    const fresh = daily('unchanged', '2026-10-22T06:00:00.000Z');

    expect({
      noneYet: evalGateRefusal(sha, gate(fresh), undefined, now),
      green: evalGateRefusal(sha, gate(fresh, daily('unchanged', '2026-10-16T12:00:00.000Z')), undefined, now),
      regressed: evalGateRefusal(sha, gate(fresh, daily('regressed', '2026-10-20T12:00:00.000Z')), undefined, now),
      old: evalGateRefusal(sha, gate(fresh, daily('unchanged', '2026-10-14T06:00:00.000Z')), undefined, now),
      changed: evalGateRefusal(sha, gate(fresh, daily('unchanged', '2026-10-20T12:00:00.000Z'), ['packages/devbox/src/desktop.ts']), undefined, now),
      fixed: evalGateRefusal(sha, gate(fresh, daily('regressed', '2026-10-20T12:00:00.000Z')), own(true), now),
    }).toEqual({
      noneYet: undefined, green: undefined,
      regressed: expect.stringContaining('the latest computer eval verdict is a regression, a P1'),
      old: expect.stringContaining('the latest computer eval verdict is 198.0 h old'),
      changed: expect.stringContaining('packages/devbox/src/desktop.ts changed the computer or the desktop since the computer suite measured'),
      fixed: undefined,
    });
  });

  test('the fast suite is every tracked task but the computer suite, Minecraft, and the two cover all of them once', () => {
    const all = trackedFiles().filter(isEvalTask).sort();
    const [fast, computer] = [suiteTasks('fast', all), suiteTasks('computer', all)];

    expect({ computer, fast: fast.length, covered: [...fast, ...computer].sort() })
      .toEqual({ computer: ['evals/tasks/minecraft.eval.ts'], fast: all.length - 1, covered: all });
  });

  test("a daily run's baseline is kept to the run's own tasks, as the whole matrix before the split ran more", () => {
    const report = JSON.stringify({ numTotalTests: 2, testResults: [{ name: '/w/evals/tasks/chess.eval.ts', assertionResults: [] }, { name: '/w/evals/tasks/minecraft.eval.ts', assertionResults: [] }] });

    expect(JSON.parse(resultsOfTasks(report, ['evals/tasks/chess.eval.ts'])))
      .toEqual({ numTotalTests: 2, testResults: [{ name: '/w/evals/tasks/chess.eval.ts', assertionResults: [] }] });
  });

  test('a completed pilot cannot authorize a promotion even if its comparison says pass', () => {
    const dir = scratchDir('promote-evals-verdict');

    mkdirSync(join(dir, 'comparison'), { recursive: true });
    writeFileSync(join(dir, 'comparison', 'verdict.json'), JSON.stringify({ pass: true, reason: 'held' }));
    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      definitions: 'abcdef1', candidateBuild: 'abcdef1', baselineBuild: 'abcdef2',
      taskFiles: ['evals/tasks/chess.eval.ts', 'evals/tasks/swarm.eval.ts'], models: ['opencode-go/muse-spark-1.3-contributor'],
      arms: ['product'], trials: 2, startedAt: 1, jobs: ['armada-job'], budget: 20, pass: false,
    }));

    expect(() => readEvalsVerdict(dir, 'abcdef1')).toThrow('full statistical matrix');
    expect(() => readDailyVerdict(dir, undefined, 'abcdef1')).toThrow('full statistical matrix');
  });
});

// 2026-10-14 and 2026-10-16: the owner's emergency promotions went through only on a hand-written verified record and a
// local skip of `promote.ts check`, a false green record each time. The override says what it is.
describe('an owner override', () => {
  const sha = 'a'.repeat(40);
  const built: Verified = { sha, digest: 'd'.repeat(64), stagingVersion: '7c1a', recordedAt: '2026-10-16T14:00:00.000Z', downloads: { 'kinu-version.json': 'e'.repeat(64) } };
  const owner = { words: 'the owner: production is down, ship the fix', reds: ['source: Devbox contracts on real golden containers'], at: '2026-10-16T15:00:00.000Z' };

  /** A staging bucket's records in memory, with every key written. */
  const bucket = (held: Readonly<Record<string, string>>): Records & { readonly written: string[] } => {
    const keys = new Map(Object.entries(held));
    const written: string[] = [];

    return {
      written, read: (key) => keys.get(key), write: (key, text) => { written.push(key); keys.set(key, text); }, delete: (key) => { keys.delete(key); },
    };
  };

  // rc22, 2026-10-19: a red staging deploy's end withdrew the built record with the verified one, so the owner's "ship
  // now" override was refused as "staging never served 2620e7c05" while staging served it.
  test('a red deploy\'s end leaves the build staging serves for an override to name; a new deploy forgets it first', async () => {
    const records = { [builtKey(sha)]: JSON.stringify(built), [verifiedKey(sha)]: JSON.stringify(built), [evalsKey(sha)]: '{}' };
    const red = bucket(records);
    const replaced = bucket(records);

    withdraw(red, sha, 'red');
    withdraw(replaced, sha, 'publishing');
    expect([red.read(verifiedKey(sha)), red.read(evalsKey(sha))]).toEqual([undefined, undefined]);
    await expect(writeOverride(red, sha, owner, async () => undefined)).resolves.toMatchObject({ verdict: 'UNVERIFIED' });
    await expect(writeOverride(replaced, sha, owner, async () => undefined)).rejects.toThrow(`staging never served ${sha}`);
  });

  test('is written under its own key, never verified/, as staging served the build, UNVERIFIED with the words and the reds', async () => {
    const staging = bucket({ [builtKey(sha)]: JSON.stringify(built) });
    const proven: unknown[] = [];
    const overridden = await writeOverride(staging, sha, owner, async (downloads) => { proven.push(downloads); });

    expect({ written: staging.written, proven, overridden }).toEqual({
      written: [overrideKey(sha)], proven: [built.downloads],
      overridden: { ...built, verdict: 'UNVERIFIED', words: owner.words, reds: owner.reds, overriddenAt: owner.at },
    });
  });

  test('names nothing for a build staging never served, nor without the owner\'s words, and writes nothing', async () => {
    const never = bucket({});
    const wordless = bucket({ [builtKey(sha)]: JSON.stringify(built) });

    await expect(writeOverride(never, sha, owner, async () => undefined)).rejects.toThrow(`staging never served ${sha}`);
    await expect(writeOverride(wordless, sha, { ...owner, words: '  ' }, async () => undefined)).rejects.toThrow();
    expect([never.written, wordless.written]).toEqual([[], []]);
  });

  test('a promotion without one still refuses a build staging did not verify, and one with one adopts only it', async () => {
    const staging = bucket({ [builtKey(sha)]: JSON.stringify(built) });

    await writeOverride(staging, sha, owner, async () => undefined);
    expect(() => adoptedRecord(staging, sha, false)).toThrow(`staging has not verified ${sha}: ${verifiedKey(sha)} holds no record`);
    expect(adoptedRecord(staging, sha, true)).toEqual({ ...built, verdict: 'UNVERIFIED', words: owner.words, reds: owner.reds, overriddenAt: owner.at });
    expect(() => adoptedRecord(bucket({ [verifiedKey(sha)]: JSON.stringify(built) }), sha, true)).toThrow(`no owner override of ${sha} was recorded`);
  });

  test('names the reds of the last staging deploy of its build, and refuses where none reported here', () => {
    const index = join(scratchDir('promote-override-index'), 'index.jsonl');
    const line = (of: string, reds: readonly string[]) => JSON.stringify({ sha: of, reds });

    writeFileSync(index, [line(sha, ['an earlier red']), line('b'.repeat(40), []), line(sha, owner.reds)].join('\n') + '\n');
    expect(stagingReds(index, sha)).toEqual(owner.reds);
    expect(() => stagingReds(index, 'c'.repeat(40))).toThrow('its open reds are unknown');
  });
});
