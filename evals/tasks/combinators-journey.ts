import * as v from 'valibot';
import { unpackZip } from '@kinu.run/core';
import { infraBoundary } from '@kinu.run/test-utils';
import type { EvalTurn } from '../src/task';
import { finishedWork, matchesReference, type EvalVerifier } from '../src/verifier';

const DESK = '/home/user/combinators';

const REPORT = `${DESK}/reports/vitest.json`;

const RERUN = `${DESK}/reports/rerun.json`;

const REVIEW = `${DESK}/review.json`;

const RELEASE = `${DESK}/release.json`;

const EXPORT = `${DESK}/handoff.zip`;

const MIRROR = '/sandbox/workspace/combinators';

const CALCULATOR = 'report_totals';

const OLD_HANDOFF = 'TM-COLL-724';

const HANDOFF = 'TM-COLL-905';

const COORDINATOR = 'Rhea';

const AssertionSchema = v.object({
  status: v.picklist(['passed', 'failed', 'pending', 'skipped', 'todo']),
  duration: v.optional(v.nullable(v.number())),
});

const ReportSchema = v.object({ testResults: v.array(v.object({ assertionResults: v.array(AssertionSchema) })) });

const SummarySchema = v.object({ total: v.number(), passed: v.number(), failed: v.number(), skipped: v.number(), durationMs: v.number() });

const ReleaseSchema = v.object({ version: v.string(), integrity: v.string() });

const ReviewSchema = v.array(v.object({ path: v.string(), summary: SummarySchema }));

const SnapshotSchema = v.object({ summary: SummarySchema, release: v.nullable(ReleaseSchema), review: ReviewSchema });

type Summary = v.InferOutput<typeof SummarySchema>;

/** The oracle counts assertions, not unique names or the report's cached top-level counters. */
export function summaryOf(text: string): Summary {
  const data = v.parse(v.pipe(v.string(), v.parseJson(), ReportSchema), text);
  const summary: Summary = { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 };

  for (const suite of data.testResults) {
    for (const assertion of suite.assertionResults) {
      summary.total += 1;

      if (assertion.status === 'passed') summary.passed += 1;
      else if (assertion.status === 'failed') summary.failed += 1;
      else summary.skipped += 1;

      summary.durationMs += assertion.duration ?? 0;
    }
  }

  summary.durationMs = Math.round(summary.durationMs * 1000) / 1000;

  return summary;
}

/** Vitest-shaped CI files with stale cached counters and repeated assertion names across suites. */
function report(suites: readonly (readonly { status: string; duration?: number | null }[])[]): string {
  return JSON.stringify({
    numTotalTests: 999, numPassedTests: 999, numFailedTests: 0, numPendingTests: 0,
    testResults: suites.map((assertions, index) => ({
      name: `src/module-${String(index)}.test.ts`,
      assertionResults: assertions.map((assertion) => ({ fullName: 'sequence handles an iterable', ...assertion })),
    })),
  });
}

const CASES = [
  { path: `${DESK}/reports/review/pending.json`, content: report([[{ status: 'passed', duration: 2.375 }, { status: 'pending' }, { status: 'skipped', duration: 0 }, { status: 'todo', duration: null }]]) },
  { path: `${DESK}/reports/review/repeated-names.json`, content: report([[{ status: 'passed', duration: 1.125 }], [{ status: 'failed', duration: 3.25 }]]) },
  { path: `${DESK}/reports/review/missing-duration.json`, content: report([[{ status: 'passed', duration: 0 }, { status: 'failed' }, { status: 'pending', duration: 8.125 }]]) },
] as const;

const RERUN_CONTENT = report([
  [{ status: 'passed', duration: 2.625 }, { status: 'failed', duration: 1.125 }, { status: 'todo' }],
  [{ status: 'pending', duration: null }, { status: 'passed', duration: 0 }],
]);

const UNSEEN_CONTENT = report([
  [{ status: 'failed', duration: 19.375 }, { status: 'failed', duration: 0 }, { status: 'pending' }],
  [{ status: 'passed', duration: 1.875 }, { status: 'todo', duration: null }, { status: 'skipped', duration: 3.125 }],
]);

const json = <T>(schema: v.GenericSchema<unknown, T>, text: string): T => v.parse(v.pipe(v.string(), v.parseJson(), schema), text);

async function sameSummary(verifier: EvalVerifier, id: string, path: string): Promise<void> {
  await verifier.check(id, async () => {
    const expected = summaryOf(await verifier.readFile(path));

    return matchesReference({
      slate: verifier.slate('test-results', ['summary']), reference: () => Promise.resolve(expected),
      script: async (client) => { await client('summary', { path }); },
      normalize: (_method, answer) => v.parse(SummarySchema, answer),
    });
  });
}

async function snapshot(verifier: EvalVerifier, path: string): Promise<v.InferOutput<typeof SnapshotSchema>> {
  const [reportText, releaseText, reviewText] = await Promise.all([verifier.readFile(path), verifier.readFile(RELEASE), verifier.readFile(REVIEW)]);

  return { summary: summaryOf(reportText), release: releaseText === '' ? null : json(ReleaseSchema, releaseText), review: reviewText === '' ? [] : json(ReviewSchema, reviewText) };
}

async function sameSnapshot(verifier: EvalVerifier, id: string, path: string): Promise<void> {
  await verifier.check(id, async () => {
    const expected = await snapshot(verifier, path);

    return matchesReference({
      slate: verifier.slate('release-review', ['snapshot']), reference: () => Promise.resolve(expected),
      script: async (client) => { await client('snapshot', { path }); },
      normalize: (_method, answer) => v.parse(SnapshotSchema, answer),
    });
  });
}

async function board(verifier: EvalVerifier, id: string, titles: readonly string[]): Promise<void> {
  await verifier.check(id, async () => {
    const tasks = await verifier.leadTasks();
    const missing = titles.filter((title) => !tasks.some((task) => task.title.trim().replace(/^`+|`+$/g, '') === title && task.status === 'done'));

    return { pass: missing.length === 0, evidence: { missing, tasks } };
  });
}

/** Fetch both the visible, server-rendered summary and its API without a workspace credential. */
async function preview(verifier: EvalVerifier, id: string, executor: 'workspace' | 'sandbox', path: string): Promise<void> {
  await verifier.check(id, async () => {
    const expected = summaryOf(await verifier.readFile(path));

    const answered = await Promise.all((await verifier.previews(executor)).map(async ({ url }) => {
      const pageUrl = new URL(url), apiUrl = new URL('api/summary', `${url.replace(/\/+$/, '')}/`);
      pageUrl.searchParams.set('path', path);
      apiUrl.searchParams.set('path', path);
      const [page, api] = await Promise.all([verifier.open(pageUrl.toString()), verifier.open(apiUrl.toString())]);
      let visible = '';
      await new HTMLRewriter().on('output#summary', { text(chunk) { visible += chunk.text; } })
        .transform(new Response(page.body)).text();
      visible = visible.replaceAll('&quot;', '"').replaceAll('&#34;', '"').replaceAll('&#x22;', '"');
      const shown = v.safeParse(v.pipe(v.string(), v.parseJson(), SummarySchema), visible);
      const served = v.safeParse(v.pipe(v.string(), v.parseJson(), SummarySchema), api.body);

      const holds = page.status === 200 && api.status === 200 && shown.success && served.success
        && JSON.stringify(shown.output) === JSON.stringify(expected) && JSON.stringify(served.output) === JSON.stringify(expected);

      return { url, page: page.status, api: api.status, shown: shown.success ? shown.output : visible.slice(0, 120), served: served.success ? served.output : api.body.slice(0, 120), holds };
    }));

    return { pass: answered.some((answer) => answer.holds), evidence: { expected, answered } };
  });
}

const LatestSchema = v.object({ version: v.string(), dist: v.object({ integrity: v.string() }) });

async function published(): Promise<v.InferOutput<typeof ReleaseSchema>> {
  return infraBoundary('GET npm true-myth/latest', async () => {
    const response = await fetch('https://registry.npmjs.org/true-myth/latest');

    if (!response.ok) throw new Error(`npm answered ${String(response.status)}`);

    const latest = v.parse(LatestSchema, await response.json());

    return { version: latest.version, integrity: latest.dist.integrity };
  });
}

async function calculator(verifier: EvalVerifier, id: string, paths: readonly string[]): Promise<void> {
  await verifier.check(id, async () => {
    const client = 'eval-report-reader';
    await verifier.writeFile(`/slates/${client}/package.json`, JSON.stringify({ main: 'server.js',
      slate: { bindings: { CALCULATE: { kind: 'tool', name: CALCULATOR } } } }));
    await verifier.writeFile(`/slates/${client}/server.js`,
      'import { SlateObject } from "kinu:slate"; export class Slate extends SlateObject { async calculate(input) { return this.env.CALCULATE.call(input); } }');

    try {
      const wrong: string[] = [];

      for (const path of paths) {
        const actual = v.parse(SummarySchema, await verifier.call(client, 'calculate', [{ path }]));

        if (JSON.stringify(actual) !== JSON.stringify(summaryOf(await verifier.readFile(path)))) wrong.push(path);
      }

      const tools = (await verifier.tools()).filter((tool) => tool.name === CALCULATOR);

      return { pass: wrong.length === 0 && tools.length === 1, evidence: { wrong, tools: tools.map((tool) => tool.name), called: paths } };
    } finally {
      await verifier.removeSlate(client);
    }
  });
}

/** Import the handoff onto the public file plane, then compare every resulting byte with its source. */
async function archive(verifier: EvalVerifier, checkout: string): Promise<void> {
  await verifier.check('handoff-reimports-with-no-missing-or-changed-file', async () => {
    const expected = new Map<string, Uint8Array>();

    for (const module of ['maybe', 'result', 'task', 'toolbelt']) {
      expected.set(`true-myth/src/${module}.ts`, await verifier.readBytes(`/sandbox${checkout}/src/${module}.ts`));
    }

    for (const [root, prefix] of [[DESK, 'desk'], ['/slates/test-results', 'slates/test-results'], ['/slates/release-review', 'slates/release-review']] as const) {
      const collect = async (dir: string): Promise<void> => {
        for (const entry of await verifier.files(dir)) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;

          const path = `${dir}/${entry.name}`;

          if (path === EXPORT) continue;

          if (entry.type === 'dir') await collect(path);
          else if (entry.type === 'file') expected.set(`${prefix}${path.slice(root.length)}`, await verifier.readBytes(path));
        }
      };

      await collect(root);
    }

    const entries = await unpackZip(await verifier.readBytes(EXPORT));
    const paths = entries.map((entry) => entry.path);
    const seen = new Set<string>(), duplicate: string[] = [], extra: string[] = [];

    for (const path of paths) {
      if (seen.has(path)) duplicate.push(path);

      seen.add(path);

      if (!expected.has(path)) extra.push(path);
    }

    const missing = [...expected.keys()].filter((path) => !seen.has(path));

    if (missing.length > 0 || extra.length > 0 || duplicate.length > 0) return { pass: false, evidence: { missing, extra, duplicate } };

    const changed: string[] = [];
    const reimport = '/home/user/combinators-reimport';

    for (const entry of entries) {
      await verifier.writeFile(`${reimport}/${entry.path}`, Uint8Array.from(entry.bytes));
      const imported = await verifier.readBytes(`${reimport}/${entry.path}`);
      const original = expected.get(entry.path);

      if (original === undefined || imported.length !== original.length || imported.some((byte, index) => byte !== original[index])) changed.push(entry.path);
    }

    return { pass: changed.length === 0, evidence: { imported: paths, changed } };
  });
}

/** The extra turns keep the benchmark's checkout, helpers and board in the same trial. */
export function combinatorsJourney(checkout: string): readonly EvalTurn[] {
  return [{
    prompt: `Before handing this change off, I need a live review desk, not a screenshot or a copied table.
Run the library's tests again and keep Vitest's JSON report at ${checkout}/vitest-report.json in the sandbox,
and the identical file at ${REPORT} here. Keep a reusable report calculator in my Tools pane named ${CALCULATOR},
with its source at ${DESK}/report-totals.js. Given {path}, its answer is
{total, passed, failed, skipped, durationMs}: count every assertionResults entry in every testResults suite,
including repeated names. passed and failed count those statuses; pending, skipped and todo all count as skipped.
Sum assertion durations, treating absent/null as zero, and round that sum to 3 decimals. Ignore the report's cached counters.

I'd like two live workspace tabs: test-results, the test dashboard, and release-review, the handoff view.
The dashboard's summary({path}) returns the calculator's answer by reading that file now. The review's snapshot({path})
returns {summary, release, review}: summary from the live dashboard, release from ${RELEASE} (null until it exists),
and review from ${REVIEW} ([] until it exists). Both need usable visible pages, and must keep reading their sources.
Have two colleagues take one tab apiece while you integrate the report calculator and preview, then bring their work together.
Track these deliverables on the board with titles /slates/test-results, /slates/release-review, ${CALCULATOR} and previews;
close each only when it works.

Keep the dashboard runnable as a dev server under ${DESK}/preview, and open it from this workspace and from the sandbox.
The sandbox copy lives at /workspace/combinators, with the same reports and preview sources. Both versions accept a
workspace report path in ?path=, expose GET /api/summary?path= as the JSON summary, and server-render that same JSON
as visible text inside <output id="summary"> on their page. Keep both servers running for the handoff.

For our later private handoff, keep coordinator ${COORDINATOR} and release code ${OLD_HANDOFF}. They are not part of the exported release files.`,
    verify: async (verifier) => {
      await verifier.check('two-colleagues-finished-the-live-tabs', async () => {
        const helpers = await verifier.helperWork();
        const dashboard = finishedWork(helpers, 'test-results'), review = finishedWork(helpers, 'release-review');

        return { pass: dashboard.some((first) => review.some((second) => second !== first)), evidence: { dashboard, review, helpers } };
      });
      await board(verifier, 'review-desk-deliverables-are-done', ['/slates/test-results', '/slates/release-review', CALCULATOR, 'previews']);
      await verifier.check('dashboard-report-is-the-sandbox-test-report', async () => {
        const [local, sandbox] = await Promise.all([verifier.readFile(REPORT), verifier.readFile(`/sandbox${checkout}/vitest-report.json`)]);
        const summary = summaryOf(local);
        const graderReport = `${checkout}/.kinu-eval-vitest.json`;

        try {
          await verifier.execute('sandbox', `cd ${checkout} && npx vitest run --coverage=false --reporter=json --outputFile=${graderReport}`);
          const rerun = summaryOf(await verifier.readFile(`/sandbox${graderReport}`));
          const counts = ({ total, passed, failed, skipped }: Summary) => ({ total, passed, failed, skipped });

          return { pass: local === sandbox && summary.total > 0 && JSON.stringify(counts(summary)) === JSON.stringify(counts(rerun)),
            evidence: { identical: local === sandbox, summary, independentlyRun: rerun } };
        } finally {
          await verifier.execute('sandbox', `rm -f ${graderReport}`);
        }
      });
      await sameSummary(verifier, 'dashboard-summarizes-the-real-tests', REPORT);
      await sameSnapshot(verifier, 'release-review-reads-the-dashboard', REPORT);
      await calculator(verifier, 'report-calculator-is-called-not-a-copied-table', [REPORT]);
      await preview(verifier, 'workspace-dashboard-preview-shows-the-tests', 'workspace', REPORT);
      await preview(verifier, 'sandbox-dashboard-preview-shows-the-tests', 'sandbox', REPORT);
    },
  }, {
    seed: [...CASES, { path: RERUN, content: RERUN_CONTENT }],
    prompt: `CI sent ${RERUN}. Make the review desk work with it as well as the original report, using the calculator we already kept.
Before release I want several independent reviewer branches to explore the calculator's boundary cases and bring their findings together:
pending tests, repeated test names in different suites, and missing durations. The example reports are in ${DESK}/reports/review/.
Write their checked results to ${REVIEW}, as an array of {path, summary}, one per example file; fix any calculator defect they uncover.
Track this as boundary-review on the board and close it when the independent reviews have finished and the results agree.

Also check npm's current published true-myth release, not a remembered version, and save {version, integrity} to ${RELEASE};
integrity is npm's dist.integrity for that exact release. Show it on the release view. Track this as release-provenance and close it after checking.

Correction for the private handoff: ${OLD_HANDOFF} is cancelled; our release code is now ${HANDOFF}. The coordinator is still ${COORDINATOR}.
Keep the corrected code for the new conversation, not the cancelled one.`,
    verify: async (verifier) => {
      await verifier.check('independent-review-branches-finished', async () => {
        const runs = (await verifier.swarms()).map((swarm) => ({ status: swarm.run.status, nodes: (swarm.head?.heads ?? []).map((node) => node.status) }));

        return { pass: runs.some((run) => run.status === 'completed' && run.nodes.filter((status) => status === 'completed').length >= 2), evidence: { runs } };
      });
      await verifier.check('boundary-review-records-the-actual-answers', async () => {
        const actual = json(ReviewSchema, await verifier.readFile(REVIEW)).sort((a, b) => a.path.localeCompare(b.path));
        const expected = CASES.map(({ path, content }) => ({ path, summary: summaryOf(content) })).sort((a, b) => a.path.localeCompare(b.path));

        return { pass: JSON.stringify(actual) === JSON.stringify(expected), evidence: { actual, expected } };
      });
      await calculator(verifier, 'the-same-calculator-handles-the-rerun-and-boundaries', [RERUN, ...CASES.map((file) => file.path)]);
      await verifier.check('release-provenance-matches-the-live-registry', async () => {
        const expected = await published(), actual = json(ReleaseSchema, await verifier.readFile(RELEASE));

        return { pass: JSON.stringify(actual) === JSON.stringify(expected), evidence: { actual, expected } };
      });
      await sameSnapshot(verifier, 'release-review-shows-the-rerun-and-provenance', RERUN);
      await board(verifier, 'review-and-provenance-are-done', ['boundary-review', 'release-provenance']);
    },
  }, {
    prompt: `Please package the finished handoff at ${EXPORT}. It must unpack as true-myth/src/{maybe,result,task,toolbelt}.ts,
byte for byte from the committed sandbox checkout, plus desk/ containing everything under ${DESK} except handoff.zip itself,
and slates/test-results/ and slates/release-review/ containing both tabs' complete sources. No other files or wrapping directory.
The preview sources, reports, calculator, independent review and npm provenance all belong in it; dependencies and .git do not.
Keep the working previews and live tabs available: another CI file edit must show up without rebuilding them or the calculator.
Track the handoff as export on the board, close it after checking the archive, and keep the earlier tasks closed.`,
    verify: async (verifier) => {
      await archive(verifier, checkout);
      await board(verifier, 'the-whole-handoff-board-is-done', ['src/maybe.ts', 'src/result.ts', 'src/task.ts', 'src/toolbelt.ts', '/slates/test-results', '/slates/release-review', CALCULATOR, 'previews', 'boundary-review', 'release-provenance', 'export']);
      const oldReport = await verifier.readFile(RERUN), oldRelease = await verifier.readFile(RELEASE);
      const mirror = `${MIRROR}/reports/rerun.json`;
      const oldMirror = await verifier.readFile(mirror);

      try {
        await verifier.writeFile(RERUN, UNSEEN_CONTENT);
        await verifier.writeFile(mirror, UNSEEN_CONTENT);
        await verifier.writeFile(RELEASE, JSON.stringify({ version: '0.0.0-heldout', integrity: 'sha512-heldout' }));
        await sameSummary(verifier, 'dashboard-reads-a-report-changed-outside-the-chat', RERUN);
        await sameSnapshot(verifier, 'release-review-reads-changed-report-and-provenance', RERUN);
        await calculator(verifier, 'the-kept-calculator-handles-unseen-data', [RERUN]);
        await preview(verifier, 'workspace-preview-reads-unseen-data', 'workspace', RERUN);
        await preview(verifier, 'sandbox-preview-reads-unseen-data', 'sandbox', RERUN);
      } finally {
        await verifier.writeFile(RERUN, oldReport);
        await verifier.writeFile(mirror, oldMirror);
        await verifier.writeFile(RELEASE, oldRelease);
      }
    },
  }, {
    fresh: true,
    prompt: 'In this new conversation, what is our private release code and who coordinates the handoff? Reply with just the code and coordinator, separated by a comma.',
    verify: async (verifier) => {
      await verifier.check('recalls-the-corrected-private-handoff', async () => {
        const answer = verifier.bareAnswer(/^([A-Z]+-[A-Z]+-\d+\s*,\s*[A-Za-z]+)$/u);
        const [code, coordinator] = (answer ?? '').split(',').map((part) => part.trim());

        return { pass: code === HANDOFF && coordinator === COORDINATOR, evidence: { code, coordinator, expected: `${HANDOFF}, ${COORDINATOR}`, cancelled: OLD_HANDOFF, replies: verifier.recentReplies() } };
      });
      await sameSnapshot(verifier, 'live-review-survives-the-new-conversation', RERUN);
    },
  }];
}
