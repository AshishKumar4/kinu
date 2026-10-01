import { describe, expect, test, spyOn } from 'bun:test';
import * as v from 'valibot';
import { JsonValueSchema, packZip, type ZipEntry } from '@kinu.run/core';
import { combinatorsJourney, summaryOf } from '../tasks/combinators-journey';
import { EvalVerifier, type VerifierSession } from './verifier';
import type { EvalCheck, EvalTurn } from './task';

const DESK = '/home/user/combinators';

const CHECKOUT = '/workspace/true-myth';

const REPORT = `${DESK}/reports/vitest.json`;

const RELEASE = `${DESK}/release.json`;

const REVIEW = `${DESK}/review.json`;

const EXPORT = `${DESK}/handoff.zip`;

const LATEST = { version: '9.2.1', integrity: 'sha512-a-real-registry-integrity' };

const INITIAL = JSON.stringify({ testResults: [{ assertionResults: [
  { fullName: 'sequence', status: 'passed', duration: 1.25 },
  { fullName: 'sequence', status: 'pending' },
  { fullName: 'zip', status: 'failed', duration: 2.125 },
] }] });

const turns = combinatorsJourney(CHECKOUT);

const CallSchema = v.object({ id: v.string(), method: v.string(), args: v.array(JsonValueSchema) });

const OperationSchema = v.object({ op: v.string(), id: v.string() });

const PathSchema = v.object({ path: v.string() });

const TestReportSchema = v.object({ testResults: v.array(v.object({ assertionResults: v.array(v.object({ status: v.string(), duration: v.optional(v.nullable(v.number())) })) })) });

type Defect = 'helper' | 'board' | 'invented-report' | 'skipped' | 'copied-calculator' | 'stale-dashboard' | 'stale-review'
  | 'workspace-preview' | 'sandbox-preview' | 'invisible-preview' | 'swarm' | 'audit' | 'npm-version' | 'npm-integrity'
  | 'export-missing' | 'export-changed' | 'export-duplicate' | 'export-extra' | 'memory-code' | 'memory-coordinator' | 'escaped-preview';

/** Independent fixture implementation: flatten assertions, then count each status separately. */
function calculate(text: string, defect?: Defect) {
  const assertions = v.parse(TestReportSchema, JSON.parse(text)).testResults.flatMap((suite) => suite.assertionResults);
  const passed = assertions.filter((entry) => entry.status === 'passed').length;
  const failed = assertions.filter((entry) => entry.status === 'failed').length;
  const skipped = assertions.filter((entry) => !['passed', 'failed'].includes(entry.status)).length;

  return { total: assertions.length, passed, failed, skipped: defect === 'skipped' ? 0 : skipped,
    durationMs: Number(assertions.reduce((total, entry) => total + (entry.duration ?? 0), 0).toFixed(3)) };
}

/** A public-session fixture over actual ZIP bytes and a real HTTP preview, not answers copied from the grader. */
function desk(defect?: Defect) {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const put = (path: string, text: string) => files.set(path, encoder.encode(text));
  const read = (path: string) => decoder.decode(files.get(path));
  put(REPORT, defect === 'invented-report' ? JSON.stringify({ testResults: [{ assertionResults: [{ status: 'passed' }] }] }) : INITIAL);
  put(`/sandbox${CHECKOUT}/vitest-report.json`, read(REPORT));
  put('/sandbox/workspace/combinators/reports/vitest.json', read(REPORT));
  put(`${DESK}/preview/server.mjs`, 'export const server = "workspace and sandbox";\n');
  files.set(`${DESK}/preview/binary.dat`, new Uint8Array([0, 128, 255, 13, 10]));

  for (const module of ['maybe', 'result', 'task', 'toolbelt']) put(`/sandbox${CHECKOUT}/src/${module}.ts`, `export const ${module} = '${module}';\n`);

  for (const id of ['test-results', 'release-review']) put(`/slates/${id}/index.js`, `export const name = '${id}';\n`);

  const current = (path: string) => calculate(read(defect === 'stale-dashboard' ? REPORT : path), defect);

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.searchParams.get('path') ?? REPORT;
      const sandbox = url.pathname.startsWith('/sandbox/');
      const source = sandbox ? `/sandbox/workspace/combinators${path.slice(DESK.length)}` : path;
      const answer = calculate(read(source), defect);

      if (url.pathname.endsWith('/api/summary')) return Response.json(answer);

      const visible = JSON.stringify(answer);
      const encoded = defect === 'escaped-preview' ? visible.replaceAll('"', '&quot;') : visible;

      return new Response(defect === 'invisible-preview' ? '<h1>No results shown</h1>' : `<h1>Test results</h1><output id="summary">${encoded}</output>`,
        { headers: { 'content-type': 'text/html' } });
    },
  });

  const titles = ['/slates/test-results', '/slates/release-review', 'report_totals', 'previews', 'boundary-review', 'release-provenance', 'export'];

  const session: VerifierSession = {
    readFile: (path) => Promise.resolve(read(path)),
    readBytes: (path) => {
      const bytes = files.get(path);

      if (bytes === undefined) return Promise.reject(new Error(`no file ${path}`));

      return Promise.resolve(bytes);
    },
    writeFile: (path, content) => {
      files.set(path, content instanceof Uint8Array ? content : encoder.encode(content));

      return Promise.resolve();
    },
    listFiles: (dir) => {
      const names = new Map<string, 'dir' | 'file'>();

      for (const path of files.keys()) {
        if (!path.startsWith(`${dir}/`)) continue;

        const relative = path.slice(dir.length + 1), slash = relative.indexOf('/');
        names.set(slash === -1 ? relative : relative.slice(0, slash), slash === -1 ? 'file' : 'dir');
      }

      return Promise.resolve([...names].map(([name, type]) => ({ name, type })));
    },
    craftedTools: () => Promise.resolve([{ name: 'report_totals', description: 'Count assertions in a report' }]),
    workspaceWork: () => Promise.resolve({ plans: [], tasks: [{ owner: { name: 'main', path: [] },
      tasks: titles.map((title) => ({ title, status: defect === 'board' ? 'in_progress' : 'done', subtasks: [] })) }] }),
    inspect: (request) => {
      if (request.view === 'children') return Promise.resolve({ view: 'children', page: { status: 'end', items: [
        { name: 'dashboard-author', status: 'dismissed', lifetime: 'task', actorReference: { actorId: 'dashboard' } },
        { name: 'review-author', status: 'dismissed', lifetime: 'task', actorReference: { actorId: 'review' } },
      ] } });

      if (request.view === 'runs') return Promise.resolve({ view: 'runs', page: { status: 'end', items: [{ status: defect === 'helper' ? 'error' : 'completed',
        userMessage: request.actor === 'dashboard' ? 'Build test-results' : 'Build release-review' }] } });

      return Promise.reject(new Error('no other inspection in this fixture'));
    },
    swarmRuns: () => Promise.resolve([{ run: { id: 'review', status: 'completed', startedAt: 0, winnerScore: null }, params: null,
      head: { rationale: 'audit', heads: [0, 1].map(() => ({ depth: 1, status: defect === 'swarm' ? 'error' : 'completed', spawnedAt: 0, wallClockMs: 1 })) } }]),
    execute: () => {
      put(`/sandbox${CHECKOUT}/.kinu-eval-vitest.json`, INITIAL);

      return Promise.resolve({ stdout: '', exitCode: 0 });
    },
    exposedPorts: (executor) => Promise.resolve(defect === `${executor}-preview` ? [] : [{ port: server.port ?? 0, url: `${server.url}${executor}/` }]),
    slateOp: (operation) => {
      const operationKind = v.parse(OperationSchema, operation);

      if (operationKind.op === 'remove') {
        for (const path of files.keys()) if (path.startsWith(`/slates/${operationKind.id}/`)) files.delete(path);

        return Promise.resolve({ ok: true, value: null });
      }

      const call = v.parse(CallSchema, operation);
      const { path } = v.parse(PathSchema, call.args[0]);

      if (call.id === 'eval-report-reader') {
        if (defect === 'copied-calculator') return Promise.resolve({ ok: false, reason: 'missing', error: 'tools has no member report_totals' });

        return Promise.resolve({ ok: true, value: calculate(read(path), defect) });
      }

      if (call.id === 'test-results' && call.method === 'summary') return Promise.resolve({ ok: true, value: current(path) });

      if (call.id === 'release-review' && call.method === 'snapshot') return Promise.resolve({ ok: true, value: { summary: current(path),
        release: defect === 'stale-review' || read(RELEASE) === '' ? null : JSON.parse(read(RELEASE)),
        review: defect === 'stale-review' || read(REVIEW) === '' ? [] : JSON.parse(read(REVIEW)) } });

      return Promise.reject(new Error('unknown slate method'));
    },
  };

  const seed = async (turn: EvalTurn) => {
    for (const file of turn.seed ?? []) {
      await session.writeFile(file.path, file.content);

      if (file.path.startsWith(`${DESK}/reports/`)) await session.writeFile(`/sandbox/workspace/combinators${file.path.slice(DESK.length)}`, file.content);
    }

    const cases = (turn.seed ?? []).filter((file) => file.path.includes('/review/'));

    if (cases.length > 0) {
      put(REVIEW, JSON.stringify(cases.map((file) => ({ path: file.path, summary: calculate(read(file.path), defect === 'audit' ? 'skipped' : undefined) }))));
      put(RELEASE, JSON.stringify({ version: defect === 'npm-version' ? '8.0.0' : LATEST.version,
        integrity: defect === 'npm-integrity' ? 'sha512-stale' : LATEST.integrity }));
    }
  };

  const exportArchive = () => {
    const entries: ZipEntry[] = [];

    for (const [path, bytes] of files) {
      if (path.startsWith(`/sandbox${CHECKOUT}/src/`)) entries.push({ path: `true-myth${path.slice(`/sandbox${CHECKOUT}`.length)}`, bytes });
      else if (path.startsWith(`${DESK}/`) && path !== EXPORT) entries.push({ path: `desk${path.slice(DESK.length)}`, bytes });
      else if (path.startsWith('/slates/')) entries.push({ path: path.slice(1), bytes });
    }

    if (defect === 'export-missing') entries.splice(entries.findIndex((entry) => entry.path === 'desk/preview/binary.dat'), 1);

    if (defect === 'export-changed') {
      const index = entries.findIndex((item) => item.path === 'desk/preview/binary.dat');
      const entry = entries[index];

      if (entry !== undefined) entries[index] = { ...entry, bytes: new Uint8Array([0, 128, 254, 13, 10]) };
    }

    if (defect === 'export-duplicate') entries.push({ path: 'desk/reports/vitest.json', bytes: encoder.encode(read(REPORT)) });

    if (defect === 'export-extra') entries.push({ path: 'desk/.git/config', bytes: encoder.encode('unrequested checkout metadata') });

    files.set(EXPORT, packZip(entries));
  };

  const code = defect === 'memory-code' ? 'TM-COLL-724' : 'TM-COLL-905';
  const coordinator = defect === 'memory-coordinator' ? 'Theo' : 'Rhea';
  const replies = [`${code}, ${coordinator}`];

  return { session, seed, exportArchive, replies, close: () => server.stop(true) };
}

async function grade(index: number, defect?: Defect): Promise<EvalCheck[]> {
  const fixture = desk(defect), turn = turns[index];

  if (turn === undefined || turn.verify === undefined) throw new Error('no turn to grade');

  const nativeFetch = globalThis.fetch;

  const registry = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = v.safeParse(v.string(), input);

    if (url.success && url.output === 'https://registry.npmjs.org/true-myth/latest') return Promise.resolve(Response.json({ version: LATEST.version, dist: { integrity: LATEST.integrity } }));

    return nativeFetch(input, init);
  }, { preconnect: nativeFetch.preconnect }));

  try {
    if (index > 0) await fixture.seed(turns[1] ?? turn);

    if (index === 2) fixture.exportArchive();

    return await new EvalVerifier(fixture.session, fixture.replies).collect(turn.verify);
  } finally {
    registry.mockRestore();
    await fixture.close();
  }
}

const defects: readonly { defect: Defect; turn: number; checks: readonly string[] }[] = [
  { defect: 'helper', turn: 0, checks: ['two-colleagues-finished-the-live-tabs'] },
  { defect: 'board', turn: 0, checks: ['review-desk-deliverables-are-done'] },
  { defect: 'invented-report', turn: 0, checks: ['dashboard-report-is-the-sandbox-test-report'] },
  { defect: 'skipped', turn: 0, checks: ['dashboard-summarizes-the-real-tests', 'release-review-reads-the-dashboard'] },
  { defect: 'copied-calculator', turn: 0, checks: ['report-calculator-is-called-not-a-copied-table'] },
  { defect: 'workspace-preview', turn: 0, checks: ['workspace-dashboard-preview-shows-the-tests'] },
  { defect: 'sandbox-preview', turn: 0, checks: ['sandbox-dashboard-preview-shows-the-tests'] },
  { defect: 'invisible-preview', turn: 0, checks: ['workspace-dashboard-preview-shows-the-tests', 'sandbox-dashboard-preview-shows-the-tests'] },
  { defect: 'swarm', turn: 1, checks: ['independent-review-branches-finished'] },
  { defect: 'audit', turn: 1, checks: ['boundary-review-records-the-actual-answers'] },
  { defect: 'skipped', turn: 1, checks: ['the-same-calculator-handles-the-rerun-and-boundaries'] },
  { defect: 'npm-version', turn: 1, checks: ['release-provenance-matches-the-live-registry'] },
  { defect: 'npm-integrity', turn: 1, checks: ['release-provenance-matches-the-live-registry'] },
  { defect: 'stale-review', turn: 1, checks: ['release-review-shows-the-rerun-and-provenance'] },
  { defect: 'board', turn: 1, checks: ['review-and-provenance-are-done'] },
  { defect: 'export-missing', turn: 2, checks: ['handoff-reimports-with-no-missing-or-changed-file'] },
  { defect: 'export-changed', turn: 2, checks: ['handoff-reimports-with-no-missing-or-changed-file'] },
  { defect: 'export-duplicate', turn: 2, checks: ['handoff-reimports-with-no-missing-or-changed-file'] },
  { defect: 'export-extra', turn: 2, checks: ['handoff-reimports-with-no-missing-or-changed-file'] },
  { defect: 'board', turn: 2, checks: ['the-whole-handoff-board-is-done'] },
  { defect: 'stale-dashboard', turn: 2, checks: ['dashboard-reads-a-report-changed-outside-the-chat'] },
  { defect: 'skipped', turn: 2, checks: ['the-kept-calculator-handles-unseen-data'] },
  { defect: 'stale-review', turn: 2, checks: ['release-review-reads-changed-report-and-provenance'] },
  { defect: 'workspace-preview', turn: 2, checks: ['workspace-preview-reads-unseen-data'] },
  { defect: 'sandbox-preview', turn: 2, checks: ['sandbox-preview-reads-unseen-data'] },
  { defect: 'memory-code', turn: 3, checks: ['recalls-the-corrected-private-handoff'] },
  { defect: 'memory-coordinator', turn: 3, checks: ['recalls-the-corrected-private-handoff'] },
  { defect: 'stale-review', turn: 3, checks: ['live-review-survives-the-new-conversation'] },
];

describe('combined journey graders reject planted defects before accepting the corrected desk', () => {
  for (const { defect, turn, checks: ids } of defects) {
    test(`${defect}, journey turn ${String(turn + 1)}`, async () => {
      const red = await grade(turn, defect);

      for (const id of ids) expect(red.find((check) => check.id === id)?.pass).toBe(false);

      const green = await grade(turn);
      expect(green.filter((check) => !check.pass)).toEqual([]);
    });
  }
});

test('HTML-escaped visible JSON is a compliant dashboard preview', async () => {
  const checks = await grade(0, 'escaped-preview');

  expect(checks.filter((check) => !check.pass)).toEqual([]);
});

describe('Vitest report oracle', () => {
  test('counts repeated assertions and every skipped status, with null and absent durations', () => {
    expect(summaryOf(JSON.stringify({ numTotalTests: 999, testResults: [
      { assertionResults: [{ fullName: 'same', status: 'passed', duration: 0.125 }, { status: 'pending' }, { status: 'todo', duration: null }] },
      { assertionResults: [{ fullName: 'same', status: 'failed', duration: 0.875 }, { status: 'skipped', duration: 2.125 }] },
    ] }))).toEqual({ total: 5, passed: 1, failed: 1, skipped: 3, durationMs: 3.125 });
  });
});
