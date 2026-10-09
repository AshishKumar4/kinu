import { createHash } from 'node:crypto';
import { basename, posix } from 'node:path';
import * as v from 'valibot';
import { unpackZip, WORKSPACE_ROOT } from '@kinu.run/core';
import type { EvalTurn, SeedFile } from '../src/task';
import { matchesReference, type EvalCheckOutcome, type EvalVerifier } from '../src/verifier';
import { published } from './npm';
import { aSwarmRan } from './swarm-runs';
import { boardHolds } from './work-board';

const DESK = `${WORKSPACE_ROOT}/combinators`;

const REPORT = `${DESK}/reports/vitest.json`;

const RERUN = `${DESK}/reports/rerun.json`;

const REVIEW = `${DESK}/review.json`;

const RELEASE = `${DESK}/release.json`;

const EXPORT = `${DESK}/handoff.zip`;

const MIRROR = '/sandbox/workspace/combinators';

const CALCULATOR = 'report_totals';

const handoff = { coordinator: 'Rhea', cancelled: 'TM-COLL-724', current: 'TM-COLL-905' } as const;

const AssertionSchema = v.object({
  status: v.picklist(['passed', 'failed', 'pending', 'skipped', 'todo']),
  duration: v.optional(v.nullable(v.number())),
});

const ReportSchema = v.object({ testResults: v.array(v.object({ assertionResults: v.array(AssertionSchema) })) });

const SummarySchema = v.object({ total: v.number(), passed: v.number(), failed: v.number(), skipped: v.number(), durationMs: v.number() });

const ReleaseSchema = v.object({ version: v.string(), integrity: v.string() });

const ReviewSchema = v.array(v.object({ path: v.string(), summary: SummarySchema }));

const SnapshotSchema = v.object({ summary: SummarySchema, release: ReleaseSchema, review: ReviewSchema });

const ProjectSchema = v.object({ main: v.optional(v.string()), browser: v.optional(v.string()) });

export type ReportSummary = v.InferOutput<typeof SummarySchema>;

/** Count assertions, not distinct names or the report's cached top-level counters. */
export function summaryOf(text: string): ReportSummary {
  const data = v.parse(v.pipe(v.string(), v.parseJson(), ReportSchema), text);
  const summary: ReportSummary = { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 };

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

/** CI examples include repeated names and deliberately stale aggregate counters. */
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

  return { summary: summaryOf(reportText), release: json(ReleaseSchema, releaseText), review: json(ReviewSchema, reviewText) };
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

/** The visible server-rendered summary and its API, fetched without a workspace credential. */
async function previewAnswer(verifier: EvalVerifier, executor: 'workspace' | 'sandbox', path: string): Promise<EvalCheckOutcome> {
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
}

async function calculator(verifier: EvalVerifier, id: string, paths: readonly string[], requireInvocation = false): Promise<void> {
  await verifier.check(id, async () => {
    const tools = (await verifier.tools()).filter((tool) => tool.name === CALCULATOR);
    const invoked = !requireInvocation || await verifier.toolInvoked(CALCULATOR);
    const client = 'eval-report-reader';
    await verifier.writeFile(`/slates/${client}/package.json`, JSON.stringify({ main: 'server.js' }));
    await verifier.writeFile(`/slates/${client}/server.js`,
      `import { SlateObject } from "kinu:slate"; export class Slate extends SlateObject { async calculate(input) { return this.env.workspace.tools[${JSON.stringify(CALCULATOR)}](input); } }`);

    try {
      const wrong: string[] = [];

      for (const path of paths) {
        const actual = v.parse(SummarySchema, await verifier.call(client, 'calculate', [{ path }]));

        if (JSON.stringify(actual) !== JSON.stringify(summaryOf(await verifier.readFile(path)))) wrong.push(path);
      }

      return { pass: wrong.length === 0 && tools.length === 1 && invoked,
        evidence: { wrong, requireInvocation, invoked, called: paths } };
    } finally {
      await verifier.removeSlate(client);
    }
  });
}

/** Compare actual ZIP payloads with allowed source bytes; names and post-export scratch do not matter. */
async function archive(verifier: EvalVerifier, checkout: string): Promise<void> {
  await verifier.check('handoff-contains-the-required-source-bytes', async () => {
    const roots = [`/sandbox${checkout}`, DESK, '/slates/test-results', '/slates/release-review'].map((path) => posix.normalize(path));
    const allowed = new Map<string, Uint8Array>();
    const hashes = new Map<string, string>();
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

    const collect = async (dir: string): Promise<void> => {
      for (const entry of await verifier.files(dir)) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const path = posix.join(dir, entry.name);

        if (path === EXPORT) continue;

        if (entry.type === 'dir') await collect(path);
        else {
          const bytes = await verifier.readBytes(path);
          const hash = digest(bytes);
          hashes.set(path, hash);
          allowed.set(hash, bytes);
        }
      }
    };

    for (const root of roots) await collect(root);
    const required = ['maybe', 'result', 'task', 'toolbelt'].map((module) => `/sandbox${checkout}/src/${module}.ts`);
    required.push(REPORT, RERUN, REVIEW, RELEASE, `${DESK}/report-totals.js`, `${DESK}/preview/server.mjs`, ...CASES.map((file) => file.path));

    for (const id of ['test-results', 'release-review']) {
      const path = `/slates/${id}/package.json`;
      const project = json(ProjectSchema, await verifier.readFile(path));

      if (project.main !== undefined) required.push(posix.join('/slates', id, project.main));

      if (project.browser !== undefined) required.push(posix.join('/slates', id, project.browser));
    }

    const entries = await unpackZip(await verifier.readBytes(EXPORT));
    const imported = new Set<string>();
    const outside: string[] = [];

    for (const entry of entries) {
      const hash = digest(entry.bytes);
      const source = allowed.get(hash);

      if (source === undefined || source.length !== entry.bytes.length || entry.bytes.some((byte, index) => byte !== source[index])) outside.push(posix.normalize(entry.path));
      else imported.add(hash);
    }

    const missing: string[] = [];

    for (const requested of required) {
      const path = posix.normalize(requested);
      const hash = hashes.get(path);

      if (hash === undefined || !imported.has(hash)) missing.push(path);
    }

    return { pass: outside.length === 0 && missing.length === 0, evidence: { missing, outside, imported: entries.map((entry) => entry.path) } };
  });
}

/** A transition probes an already-read value, then an unseen update, and restores the user's files. */
async function changed(verifier: EvalVerifier, replacements: readonly SeedFile[], body: (replace: () => Promise<void>) => Promise<EvalCheckOutcome>): Promise<EvalCheckOutcome> {
  const before = await Promise.all(replacements.map(async (file) => ({ path: file.path, content: await verifier.readFile(file.path) })));

  try {
    return await body(async () => {
      for (const file of replacements) await verifier.writeFile(file.path, file.content);
    });
  } finally {
    for (const file of before) await verifier.writeFile(file.path, file.content);
  }
}

/** Independent provenance and recall precede the calculator and live-view dependency chain. */
export function combinatorsJourney(checkout: string): readonly [EvalTurn, ...EvalTurn[]] {
  return [{
    prompt: `Before we prepare the release review, look up the current true-myth release on npm and save
{version, integrity} to ${RELEASE}; integrity is that release's dist.integrity. Add a board task titled exactly
release-provenance and mark it done once checked. For our later private handoff, keep coordinator
${handoff.coordinator} and release code ${handoff.cancelled}; I'll ask for them in a new conversation.`,
    verify: async (verifier) => {
      await verifier.check('release-provenance-matches-the-live-registry', async () => {
        const expected = await published('true-myth'), actual = json(ReleaseSchema, await verifier.readFile(RELEASE));

        return { pass: JSON.stringify(actual) === JSON.stringify(expected), evidence: { actual, expected } };
      });
      await verifier.check('release-provenance-is-done', () => boardHolds(verifier, ['release-provenance']));
    },
  }, {
    seed: [...CASES, { path: RERUN, content: RERUN_CONTENT }],
    prompt: `We need a persistent report_totals the workspace can call for the CI reports in ${DESK}/reports/.
I want several independent approaches explored in parallel, judged against the examples, with the best
working approach kept for later reports—not one draft polished serially. Keep the chosen implementation
at ${DESK}/report-totals.js and make report_totals available to workspace calls, not just as a module file.

Given one object {path}, it returns {total, passed, failed, skipped, durationMs}. Count every assertionResults
entry in every testResults suite, including repeated names. passed and failed count those statuses;
pending, skipped and todo count as skipped. Sum durations, treating absent/null as zero, and round to
3 decimals. Ignore cached aggregate counters. Check the chosen calculation on all example reports under
reports/review and on rerun.json. Save an array of {path, summary}, one per example, to ${REVIEW}.
Add a board task titled exactly boundary-review and mark it done after comparing the approaches and results.

A correction for the private handoff: ${handoff.cancelled} is cancelled. Our release code is now ${handoff.current};
${handoff.coordinator} still coordinates it. Keep the corrected code for the new conversation.`,
    verify: async (verifier) => {
      await verifier.check('independent-review-branches-finished-this-turn', async () => {
        const swarm = await aSwarmRan(verifier, {});
        const helpers = await verifier.helperWork();
        const finished = helpers.filter((helper) => helper.runs.some((run) => run.status !== null));

        return { pass: swarm.pass || finished.length >= 2, evidence: { swarm: swarm.evidence, helpers } };
      });
      await verifier.check('boundary-review-records-the-actual-answers', async () => {
        const normalize = (rows: v.InferOutput<typeof ReviewSchema>) => rows.map((row) => ({ ...row, path: basename(row.path) })).sort((a, b) => a.path.localeCompare(b.path));
        const actual = normalize(json(ReviewSchema, await verifier.readFile(REVIEW)));
        const expected = normalize([...CASES, { path: RERUN, content: RERUN_CONTENT }].map(({ path, content }) => ({ path, summary: summaryOf(content) })));
        const missing = CASES.filter((file) => !actual.some((row) => row.path === basename(file.path))).map((file) => basename(file.path));
        const wrong = actual.filter((row) => !expected.some((reference) => JSON.stringify(row) === JSON.stringify(reference)));

        return { pass: missing.length === 0 && wrong.length === 0, evidence: { missing, wrong, actual, expected } };
      });
      await calculator(verifier, 'the-report-calculator-works', [RERUN, ...CASES.map((file) => file.path)]);
      await verifier.check('boundary-review-is-done', () => boardHolds(verifier, ['boundary-review']));
    },
  }, {
    fresh: true,
    prompt: `In this new conversation, what is our private release code and who coordinates the handoff?
After the work below, reply with just the code and coordinator, separated by a comma.

Run the library's tests again and keep the JSON report at ${checkout}/vitest-report.json in the sandbox
and the identical file at ${REPORT} here. Use the report_totals calculation we kept to check that real report.

I want two live workspace views: test-results, the dashboard, and release-review, the release view.
The dashboard shows current test totals. Its API takes one object: summary({path}) returns the calculation
for that file read now. The release view's snapshot({path}) takes the same object and returns
{summary, release, review}: the dashboard's live summary, ${RELEASE}, and ${REVIEW}. Have two colleagues create one view apiece while you
bring the work together. Both need usable visible pages, not copied tables. Track test-results and
release-review as exact task titles on the board and mark them done when the views work with both reports.`,
    verify: async (verifier) => {
      await verifier.check('recalls-the-corrected-private-handoff', async () => {
        const answer = verifier.bareAnswer(/^([A-Z]+-[A-Z]+-\d+\s*,\s*[A-Za-z]+)$/u);
        const [code, coordinator] = (answer ?? '').split(',').map((part) => part.trim());
        const saved = await verifier.memory();
        const values = [saved.content, ...saved.facts.map((fact) => JSON.stringify(fact.value))];
        const hasCode = values.some((value) => value.includes(handoff.current));
        const hasCoordinator = values.some((value) => value.includes(handoff.coordinator));

        return { pass: code === handoff.current && coordinator === handoff.coordinator && hasCode && hasCoordinator,
          evidence: { code, coordinator, hasCode, hasCoordinator, noteRead: true, factKeys: saved.facts.map((fact) => fact.key), replies: verifier.recentReplies() } };
      });
      await verifier.check('dashboard-report-is-the-sandbox-test-report', async () => {
        const [local, sandbox] = await Promise.all([verifier.readFile(REPORT), verifier.readFile(`/sandbox${checkout}/vitest-report.json`)]);
        const summary = summaryOf(local);
        const graderReport = `${checkout}/.kinu-eval-vitest.json`;

        try {
          await verifier.execute('sandbox', `cd ${checkout} && npx vitest run --coverage=false --reporter=json --outputFile=${graderReport}`);
          const rerun = summaryOf(await verifier.readFile(`/sandbox${graderReport}`));
          const counts = ({ total, passed, failed, skipped }: ReportSummary) => ({ total, passed, failed, skipped });

          return { pass: local === sandbox && summary.total > 0 && JSON.stringify(counts(summary)) === JSON.stringify(counts(rerun)),
            evidence: { identical: local === sandbox, summary, independentlyRun: rerun } };
        } finally {
          await verifier.execute('sandbox', `rm -f ${graderReport}`);
        }
      });
      await calculator(verifier, 'agent-reused-the-report-calculator', [REPORT], true);
      await sameSummary(verifier, 'dashboard-summarizes-the-real-tests', REPORT);
      await sameSummary(verifier, 'dashboard-summarizes-the-rerun', RERUN);
      await sameSnapshot(verifier, 'release-review-reads-the-dashboard-and-provenance', RERUN);
      await verifier.check('live-views-are-done', () => boardHolds(verifier, ['test-results', 'release-review']));
    },
  }, {
    prompt: `Open the same dashboard from a dev server in this workspace and from one in the sandbox, and keep both
running for the handoff. Keep its portable entry point at ${DESK}/preview/server.mjs; the sandbox copy lives
at /workspace/combinators, with the same reports and preview sources. Each server accepts a workspace report
path in ?path=, exposes GET /api/summary?path= as the JSON totals, and server-renders those totals as visible
JSON inside <output id="summary">. Show vitest.json and rerun.json without copying a fixed table into the page.

Package the changed library modules, calculator, original and rerun reports, example reports, review and npm
provenance, both views' declared server/client entry points and portable preview source at ${EXPORT}.
A recipient should get the same file bytes; leave dependencies and git history out. Keep the live views and
previews reading changes without a rebuild. Add board tasks titled exactly previews and export, mark them
done when ready, and keep earlier work closed.`,
    verify: async (verifier) => {
      await verifier.check('workspace-dashboard-preview-shows-the-tests', () => previewAnswer(verifier, 'workspace', REPORT));
      await verifier.check('sandbox-dashboard-preview-shows-the-tests', () => previewAnswer(verifier, 'sandbox', REPORT));
      await archive(verifier, checkout);
      await verifier.check('the-whole-handoff-board-is-done', () => boardHolds(verifier,
        ['src/maybe.ts', 'src/result.ts', 'src/task.ts', 'src/toolbelt.ts', 'release-provenance', 'boundary-review', 'test-results', 'release-review', 'previews', 'export']));
      await verifier.check('dashboard-reads-a-report-changed-outside-the-chat', () => changed(verifier, [{ path: RERUN, content: UNSEEN_CONTENT }], async (replace) => {
        const expectedBefore = summaryOf(await verifier.readFile(RERUN));
        const before = v.parse(SummarySchema, await verifier.call('test-results', 'summary', [{ path: RERUN }]));
        await replace();
        const expectedAfter = summaryOf(UNSEEN_CONTENT);
        const after = v.parse(SummarySchema, await verifier.call('test-results', 'summary', [{ path: RERUN }]));

        return { pass: JSON.stringify(before) === JSON.stringify(expectedBefore) && JSON.stringify(after) === JSON.stringify(expectedAfter),
          evidence: { before, expectedBefore, after, expectedAfter } };
      }));
      await verifier.check('release-review-reads-changed-report-and-provenance', () => changed(verifier,
        [{ path: RERUN, content: UNSEEN_CONTENT }, { path: RELEASE, content: JSON.stringify({ version: '0.0.0-heldout', integrity: 'sha512-heldout' }) }], async (replace) => {
          const expectedBefore = await snapshot(verifier, RERUN);
          const before = v.parse(SnapshotSchema, await verifier.call('release-review', 'snapshot', [{ path: RERUN }]));
          await replace();
          const expectedAfter = await snapshot(verifier, RERUN);
          const after = v.parse(SnapshotSchema, await verifier.call('release-review', 'snapshot', [{ path: RERUN }]));

          return { pass: JSON.stringify(before) === JSON.stringify(expectedBefore) && JSON.stringify(after) === JSON.stringify(expectedAfter),
            evidence: { before, expectedBefore, after, expectedAfter } };
        }));

      for (const executor of ['workspace', 'sandbox'] as const) {
        await verifier.check(`${executor}-preview-reads-unseen-data`, () => changed(verifier,
          [{ path: RERUN, content: UNSEEN_CONTENT }, { path: `${MIRROR}/reports/rerun.json`, content: UNSEEN_CONTENT }], async (replace) => {
            const before = await previewAnswer(verifier, executor, RERUN);
            await replace();
            const after = await previewAnswer(verifier, executor, RERUN);

            return { pass: before.pass && after.pass, evidence: { before: before.evidence, after: after.evidence } };
          }));
      }
    },
  }];
}
