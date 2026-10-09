// The reduce task: all inputs come from native armada trial artifacts, never the driver's checkout outputs.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { connect } from 'armada';
import { extractTar } from 'armada/ci';
import { parseResults, trials } from '../evals/src/results';
import { redact } from '../evals/src/redact';
import { joinTrialReports, PostItemSchema, type TrialItem } from './evals-artifacts';
import { ciVerdictRow } from './ladder';

const ROOT = join(import.meta.dirname, '..');

async function main(): Promise<number> {
  const { run, items, outcomes } = v.parse(PostItemSchema, JSON.parse(process.env['ARMADA_ITEM'] ?? '{}'));
  const artifacts = process.env['ARMADA_ARTIFACTS'];

  if (artifacts === undefined) throw new Error('armada named no post-task artifacts directory');
  const dir = join(ROOT, 'bench-artifacts', `evals-post-${run.job}`);
  const inputs = join(dir, 'inputs');
  const armada = connect();

  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  const reports: { item: TrialItem; path?: string; failure: string }[] = [];

  for (const [index, item] of items.entries()) {
    const outcome = outcomes.find((entry) => entry.index === index);
    const archive = await armada.artifacts(run.job, index);

    if (archive === null || outcome?.exitCode !== 0) {
      reports.push({ item, failure: outcome === undefined ? 'armada returned no outcome' : `${outcome.kind}: ${outcome.tail}` });
      continue;
    }

    const into = join(inputs, String(index));
    const kept = new Set(extractTar(archive, into));
    const row = v.parse(v.object({ artifacts: v.array(v.string()) }), JSON.parse(readFileSync(join(into, 'row.json'), 'utf8')));

    if (row.artifacts.some((path) => !kept.has(path))) throw new Error(`trial ${String(index)} names evidence its task did not keep`);
    const path = join(into, 'evals', 'results.json');

    reports.push({ item, path, failure: '' });
    const evidence = join(dir, item.leg, 'evidence');

    mkdirSync(evidence, { recursive: true });

    for (const entry of readdirSync(join(into, 'evals'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('evals-')) {
        cpSync(join(into, 'evals', entry.name), join(evidence, entry.name), { recursive: true });
      }
    }
  }

  for (const leg of run.pass ? ['candidate'] : ['candidate', 'baseline']) {
    const legDir = join(dir, leg);

    mkdirSync(legDir, { recursive: true });
    writeFileSync(join(legDir, 'results.json'), `${joinTrialReports(reports.filter(({ item }) => item.leg === leg))}\n`);
  }

  // Every command below is a post-step of the same artifacts. A failed advisory review is recorded,
  // never swapped for a mock diagnosis and never substituted for the comparison's verdict.
  const step = async (name: string, argv: readonly string[], origin?: string): Promise<number> => {
    const child = Bun.spawn([process.execPath, ...argv], { cwd: ROOT,
      env: origin === undefined ? process.env : { ...process.env, KINU_EVAL_ORIGIN: origin }, stdout: 'pipe', stderr: 'pipe' });

    const chunks: string[] = [];

    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      for await (const bytes of stream) {
        const text = new TextDecoder().decode(bytes);

        chunks.push(text);
        process.stdout.write(text);
      }
    };

    await Promise.all([pump(child.stdout), pump(child.stderr)]);

    const exitCode = await child.exited;

    writeFileSync(join(dir, `${name}.log`), redact(chunks.join('')));

    return exitCode;
  };

  let verdictExit = 1;

  if (run.pass) {
    const assertions = trials(parseResults('soak', readFileSync(join(dir, 'candidate', 'results.json'), 'utf8')));

    verdictExit = assertions.length === items.length && assertions.every((assertion) => assertion.status === 'passed') ? 0 : 1;
    writeFileSync(join(dir, 'results.json'), readFileSync(join(dir, 'candidate', 'results.json')));
  } else {
    for (const [leg, worker] of [['candidate', 'kinu-staging'], ['baseline', 'kinu']] as const) {
      await step(`${leg}-platform`, ['evals/scripts/platform-bugs.ts', join(dir, leg, 'results.json'),
        '--worker', worker, '--out', join(dir, leg, 'platform.json')]);
      await step(`${leg}-validate`, ['evals/scripts/validate.ts', join(dir, leg, 'results.json'), '--trials', String(run.trials)]);
    }

    const compareArgs = ['evals/scripts/compare.ts', '--candidate', join(dir, 'candidate', 'results.json'),
      '--baseline', join(dir, 'baseline', 'results.json'), '--candidate-build', run.candidateBuild, '--baseline-build', run.baselineBuild,
      '--tasks', run.taskFiles.map((file) => file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, '')).join(','),
      '--trials', String(run.trials), '--out', join(dir, 'comparison')];

    for (const leg of ['candidate', 'baseline']) {
      const platform = join(dir, leg, 'platform.json');

      if (existsSync(platform)) compareArgs.push(`--${leg}-platform`, platform);
    }

    if (await step('compare', compareArgs) !== 0) throw new Error('comparison failed: compare.log retains its real error');
    const verdict = v.parse(v.object({ pass: v.boolean(), reason: v.string() }), JSON.parse(readFileSync(join(dir, 'comparison', 'verdict.json'), 'utf8')));

    verdictExit = verdict.pass ? 0 : 1;
    writeFileSync(join(dir, 'verdict.log'), `${verdict.reason}\n`);
    await step('trajectories', ['evals/scripts/trajectories.ts', join(dir, 'candidate', 'results.json'), join(dir, 'comparison', 'trajectories.md')]);
    writeFileSync(join(dir, 'comparison', 'comment.md'), `<!-- kinu-evals-results -->\n${readFileSync(join(dir, 'comparison', 'comparison.md'), 'utf8')}\nArmada job: ${run.job}.\n`);
    mkdirSync(join(dir, 'why'), { recursive: true });

    const diagnosis = await step('diagnose', ['evals/scripts/diagnose.ts', '--results', join(dir, 'candidate', 'results.json'),
      '--baseline', join(dir, 'baseline', 'results.json'), '--comparison', join(dir, 'comparison', 'comparison.json'),
      '--evidence', join(dir, 'candidate', 'evidence'), '--out', join(dir, 'why', 'why.md')], 'https://staging.kinu.run');

    const review = await step('review', ['evals/scripts/review.ts', '--results', join(dir, 'candidate', 'results.json'),
      '--comparison', join(dir, 'comparison', 'comparison.json'), '--out', join(dir, 'why')], 'https://staging.kinu.run');

    const pages = ['why.md', 'review.md'].filter((name) => existsSync(join(dir, 'why', name)))
      .map((name) => readFileSync(join(dir, 'why', name), 'utf8'));

    if (pages.length > 0) writeFileSync(join(dir, 'why', 'comment.md'), `<!-- kinu-evals-why -->\n${pages.join('\n')}\n`);
    writeFileSync(join(dir, 'advisory.json'), `${JSON.stringify({ diagnosis, review })}\n`);
  }

  const row = ciVerdictRow({ run: `evals post ${run.job}`, evidence: 'evals' },
    { exitCode: verdictExit, seconds: (Date.now() - run.startedAt) / 1000, stdout: '', stderr: '' }, undefined, { dir, artifacts });

  writeFileSync(join(artifacts, 'row.json'), `${JSON.stringify(row)}\n`);

  return verdictExit;
}

if (import.meta.main) process.exitCode = await main();
