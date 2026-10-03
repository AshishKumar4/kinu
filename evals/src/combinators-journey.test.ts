import { describe, expect, test, spyOn } from 'bun:test';
import { basename } from 'node:path';
import * as v from 'valibot';
import { JsonValueSchema, packZip, type ZipEntry } from '@kinu.run/core';
import { combinatorsJourney, summaryOf, type ReportSummary } from '../tasks/combinators-journey';
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

type Defect = 'board' | 'invented-report' | 'skipped' | 'hardcoded-calculator' | 'stale-dashboard' | 'stale-review'
  | 'workspace-preview' | 'sandbox-preview' | 'invisible-preview' | 'swarm' | 'old-swarm' | 'audit' | 'npm-version' | 'npm-integrity'
  | 'export-missing' | 'export-changed' | 'export-duplicate' | 'export-extra' | 'memory-code' | 'memory-coordinator' | 'escaped-preview' | 'reopened-module'
  | 'board-case' | 'relative-review' | 'scratch-after-pack' | 'agent-unused' | 'agent-used-once' | 'empty-memory' | 'memory-note' | 'renamed-export'
  | 'cached-workspace-preview' | 'cached-sandbox-preview' | 'dot-entrypoint' | 'no-main' | 'no-package-members' | 'review-with-rerun' | 'lagged-use';

/** The fixture flattens assertions and counts statuses independently of the grader's loop. */
function calculate(text: string, defect?: Defect) {
  const assertions = v.parse(TestReportSchema, JSON.parse(text)).testResults.flatMap((suite) => suite.assertionResults);
  const passed = assertions.filter((entry) => entry.status === 'passed').length;
  const failed = assertions.filter((entry) => entry.status === 'failed').length;
  const skipped = assertions.filter((entry) => !['passed', 'failed'].includes(entry.status)).length;

  return { total: assertions.length, passed, failed, skipped: defect === 'skipped' ? 0 : skipped,
    durationMs: Number(assertions.reduce((total, entry) => total + (entry.duration ?? 0), 0).toFixed(3)) };
}

/** Real ZIP bytes and a real HTTP preview; application answers are computed from its input files. */
function desk(defect?: Defect) {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const put = (path: string, text: string) => files.set(path, encoder.encode(text));
  const read = (path: string) => decoder.decode(files.get(path));
  put(REPORT, defect === 'invented-report' ? JSON.stringify({ testResults: [{ assertionResults: [{ status: 'passed' }] }] }) : INITIAL);
  put(`/sandbox${CHECKOUT}/vitest-report.json`, read(REPORT));
  put('/sandbox/workspace/combinators/reports/vitest.json', read(REPORT));
  put(`${DESK}/preview/server.mjs`, 'export const server = "workspace and sandbox";\n');
  put(`${DESK}/report-totals.js`, 'export const calculator = "reusable report totals";\n');
  put(RELEASE, JSON.stringify({ version: defect === 'npm-version' ? '8.0.0' : LATEST.version,
    integrity: defect === 'npm-integrity' ? 'sha512-stale' : LATEST.integrity }));
  files.set(`${DESK}/preview/binary.dat`, new Uint8Array([0, 128, 255, 13, 10]));

  for (const module of ['maybe', 'result', 'task', 'toolbelt']) put(`/sandbox${CHECKOUT}/src/${module}.ts`, `export const ${module} = '${module}';\n`);

  for (const id of ['test-results', 'release-review']) {
    let main: string | undefined = defect === 'dot-entrypoint' ? './index.js' : 'index.js';

    if (defect === 'no-main') main = undefined;
    put(`/slates/${id}/package.json`, JSON.stringify({ name: id, main, browser: 'client.js' }));
    put(`/slates/${id}/index.js`, `export const name = '${id}';\n`);
    put(`/slates/${id}/client.js`, `export const client = '${id}';\n`);
  }

  const cached = new Map<string, ReportSummary>();
  let uses = 2;

  if (defect === 'agent-unused' || defect === 'lagged-use') uses = 0;
  else if (defect === 'agent-used-once') uses = 6;

  const current = (path: string, cache: boolean) => {
    const found = cache ? cached.get(path) : undefined;

    if (found !== undefined) return found;
    const answer = calculate(read(path), defect);

    if (cache) cached.set(path, answer);

    return answer;
  };

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.searchParams.get('path') ?? REPORT;
      const sandbox = url.pathname.startsWith('/sandbox/');
      const source = sandbox ? `/sandbox/workspace/combinators${path.slice(DESK.length)}` : path;
      const answer = current(source, defect === (sandbox ? 'cached-sandbox-preview' : 'cached-workspace-preview'));

      if (url.pathname.endsWith('/api/summary')) return Response.json(answer);
      const visible = JSON.stringify(answer);
      const encoded = defect === 'escaped-preview' ? visible.replaceAll('"', '&quot;') : visible;

      return new Response(defect === 'invisible-preview' ? '<h1>No results shown</h1>' : `<h1>Test results</h1><output id="summary">${encoded}</output>`,
        { headers: { 'content-type': 'text/html' } });
    },
  });

  const titles = ['src/maybe.ts', 'src/result.ts', 'src/task.ts', 'src/toolbelt.ts', 'test-results', 'release-review', 'previews', 'boundary-review', 'release-provenance', 'export'];

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
    craftedTools: () => Promise.resolve([{ name: 'report_totals', description: 'Count assertions in a report', usageCount: uses }]),
    runEvents: () => Promise.resolve([{ type: 'craft_cycle', eventIndex: 1, runId: 'this-turn', timestamp: new Date(110).toISOString(),
      crafted: [], invoked: defect === 'agent-used-once' ? [] : ['report_totals'], reused: [], returned: 1, raised: 0, dropped: [] }]),
    memoryContent: () => Promise.resolve(defect === 'memory-note' ? 'Rhea coordinates TM-COLL-905; TM-COLL-724 is cancelled.' : ''),
    memoryFacts: () => Promise.resolve(defect === 'empty-memory' || defect === 'memory-note' ? []
      : [{ key: 'handoff.private', value: { code: 'TM-COLL-905', coordinator: 'Rhea' } }]),
    workspaceWork: () => Promise.resolve({ plans: [], tasks: [{ owner: { name: 'main', path: [] },
      tasks: titles.map((title) => ({ title: defect === 'board-case' ? `\`${title.toUpperCase()}\`.` : title,
        status: defect === 'board' || (defect === 'reopened-module' && title === 'src/maybe.ts') ? 'in_progress' : 'done', subtasks: [] })) }] }),
    inspect: () => Promise.resolve({ view: 'children', page: { status: 'end', items: [] } }),
    swarmRuns: () => Promise.resolve([{ run: { id: 'review', status: 'completed', startedAt: defect === 'old-swarm' ? 90 : 100, winnerScore: null }, params: null,
      head: { rationale: 'custom', heads: [0, 1].map(() => ({ depth: 1, status: defect === 'swarm' ? 'error' : 'completed', spawnedAt: 100, wallClockMs: 1 })) } }]),
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
        if (defect !== 'lagged-use') uses += 1;

        return Promise.resolve({ ok: true, value: calculate(defect === 'hardcoded-calculator' ? INITIAL : read(path), defect) });
      }

      if (call.id === 'test-results' && call.method === 'summary') return Promise.resolve({ ok: true, value: current(path, defect === 'stale-dashboard') });

      if (call.id === 'release-review' && call.method === 'snapshot') return Promise.resolve({ ok: true, value: { summary: current(path, defect === 'stale-dashboard'),
        release: defect === 'stale-review' ? null : JSON.parse(read(RELEASE)),
        review: defect === 'stale-review' ? [] : JSON.parse(read(REVIEW)) } });

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
      const reviewed = defect === 'review-with-rerun' ? [...cases, ...(turn.seed ?? []).filter((file) => basename(file.path) === 'rerun.json')] : cases;
      put(REVIEW, JSON.stringify(reviewed.map((file) => ({ path: defect === 'relative-review' ? basename(file.path) : file.path,
        summary: calculate(read(file.path), defect === 'audit' ? 'skipped' : undefined) }))));
    }
  };

  const exportArchive = () => {
    const entries: ZipEntry[] = [];

    for (const [path, bytes] of files) {
      if (path.startsWith(`/sandbox${CHECKOUT}/src/`)) entries.push({ path: `true-myth${path.slice(`/sandbox${CHECKOUT}`.length)}`, bytes });
      else if (path.startsWith(`${DESK}/`) && path !== EXPORT) entries.push({ path: `desk${path.slice(DESK.length)}`, bytes });
      else if (path.startsWith('/slates/') && !(defect === 'no-package-members' && basename(path) === 'package.json')) entries.push({ path: path.slice(1), bytes });
    }

    if (defect === 'export-missing') entries.splice(entries.findIndex((entry) => entry.path === 'desk/report-totals.js'), 1);

    if (defect === 'export-changed') {
      const index = entries.findIndex((item) => item.path === 'desk/preview/binary.dat');
      const entry = entries[index];

      if (entry !== undefined) entries[index] = { ...entry, bytes: new Uint8Array([0, 128, 254, 13, 10]) };
    }

    if (defect === 'export-duplicate') entries.push({ path: 'duplicate-copy.json', bytes: encoder.encode(read(REPORT)) });

    if (defect === 'export-extra') entries.push({ path: 'outside.txt', bytes: encoder.encode('not found under an allowed source root') });

    const packed = defect === 'renamed-export' ? entries.map((entry, index) => ({ ...entry, path: `recipient/file-${String(index)}.bin` })) : entries;
    files.set(EXPORT, packZip(packed));

    if (defect === 'scratch-after-pack') put(`${DESK}/archive-check.log`, 'checked after packing');
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
    await fixture.seed(turns[1] ?? turn);

    if (index === 3) fixture.exportArchive();

    return await new EvalVerifier(fixture.session, fixture.replies, 100).collect(turn.verify);
  } finally {
    registry.mockRestore();
    await fixture.close();
  }
}

const defects: readonly { defect: Defect; turn: number; checks: readonly string[] }[] = [
  { defect: 'board', turn: 0, checks: ['release-provenance-is-done'] },
  { defect: 'npm-version', turn: 0, checks: ['release-provenance-matches-the-live-registry'] },
  { defect: 'npm-integrity', turn: 0, checks: ['release-provenance-matches-the-live-registry'] },
  { defect: 'memory-code', turn: 2, checks: ['recalls-the-corrected-private-handoff'] },
  { defect: 'memory-coordinator', turn: 2, checks: ['recalls-the-corrected-private-handoff'] },
  { defect: 'empty-memory', turn: 2, checks: ['recalls-the-corrected-private-handoff'] },
  { defect: 'swarm', turn: 1, checks: ['independent-review-branches-finished-this-turn'] },
  { defect: 'old-swarm', turn: 1, checks: ['independent-review-branches-finished-this-turn'] },
  { defect: 'audit', turn: 1, checks: ['boundary-review-records-the-actual-answers'] },
  { defect: 'hardcoded-calculator', turn: 1, checks: ['the-report-calculator-works'] },
  { defect: 'board', turn: 1, checks: ['boundary-review-is-done'] },
  { defect: 'invented-report', turn: 2, checks: ['dashboard-report-is-the-sandbox-test-report'] },
  { defect: 'agent-used-once', turn: 2, checks: ['agent-reused-the-report-calculator'] },
  { defect: 'skipped', turn: 2, checks: ['dashboard-summarizes-the-real-tests', 'dashboard-summarizes-the-rerun'] },
  { defect: 'stale-review', turn: 2, checks: ['release-review-reads-the-dashboard-and-provenance'] },
  { defect: 'board', turn: 2, checks: ['live-views-are-done'] },
  { defect: 'workspace-preview', turn: 3, checks: ['workspace-dashboard-preview-shows-the-tests'] },
  { defect: 'sandbox-preview', turn: 3, checks: ['sandbox-dashboard-preview-shows-the-tests'] },
  { defect: 'invisible-preview', turn: 3, checks: ['workspace-dashboard-preview-shows-the-tests', 'sandbox-dashboard-preview-shows-the-tests'] },
  { defect: 'export-missing', turn: 3, checks: ['handoff-contains-the-required-source-bytes'] },
  { defect: 'export-changed', turn: 3, checks: ['handoff-contains-the-required-source-bytes'] },
  { defect: 'export-extra', turn: 3, checks: ['handoff-contains-the-required-source-bytes'] },
  { defect: 'reopened-module', turn: 3, checks: ['the-whole-handoff-board-is-done'] },
  { defect: 'stale-dashboard', turn: 3, checks: ['dashboard-reads-a-report-changed-outside-the-chat', 'release-review-reads-changed-report-and-provenance'] },
  { defect: 'stale-review', turn: 3, checks: ['release-review-reads-changed-report-and-provenance'] },
  { defect: 'cached-workspace-preview', turn: 3, checks: ['workspace-preview-reads-unseen-data'] },
  { defect: 'cached-sandbox-preview', turn: 3, checks: ['sandbox-preview-reads-unseen-data'] },
];

describe('journey graders reject realistic defects before accepting the corrected artifacts', () => {
  for (const { defect, turn, checks: ids } of defects) {
    test(`${defect}, journey turn ${String(turn + 1)}`, async () => {
      const red = await grade(turn, defect);

      for (const id of ids) expect(red.find((check) => check.id === id)?.pass).toBe(false);
      const green = await grade(turn);

      expect(green.filter((check) => !check.pass)).toEqual([]);
    });
  }
});

for (const [name, defect, turn] of [
  ['escaped visible JSON', 'escaped-preview', 3],
  ['case-normalized board titles', 'board-case', 2],
  ['review paths by basename', 'relative-review', 1],
  ['scratch written after packing', 'scratch-after-pack', 3],
  ['renamed archive members', 'renamed-export', 3],
  ['duplicate copies of allowed bytes', 'export-duplicate', 3],
  ['memory notes instead of keyed facts', 'memory-note', 2],
  ['an unused but reusable calculator at creation', 'agent-unused', 1],
  ['dot-relative declared entry points', 'dot-entrypoint', 3],
  ['node projects without main', 'no-main', 3],
  ['only requested entry points, without package metadata', 'no-package-members', 3],
  ['the correctly checked rerun alongside the three examples', 'review-with-rerun', 1],
  ['this-turn invocation before its counter review', 'lagged-use', 2],
] as const) {
  test(`accepts ${name}`, async () => {
    expect((await grade(turn, defect)).filter((check) => !check.pass)).toEqual([]);
  });
}

test('the report oracle counts repeated assertions and every skipped status with null or absent durations', () => {
  expect(summaryOf(JSON.stringify({ numTotalTests: 999, testResults: [
    { assertionResults: [{ fullName: 'same', status: 'passed', duration: 0.125 }, { status: 'pending' }, { status: 'todo', duration: null }] },
    { assertionResults: [{ fullName: 'same', status: 'failed', duration: 0.875 }, { status: 'skipped', duration: 2.125 }] },
  ] }))).toEqual({ total: 5, passed: 1, failed: 1, skipped: 3, durationMs: 3.125 });
});
