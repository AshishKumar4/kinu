// Light post-steps on the deploy driver, reading only artifacts armada map --artifacts extracted.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { parseResults, trials } from '../evals/src/results';
import { redact } from '../evals/src/redact';
import { joinTrialReports, type EvalRun, type MapResult, type TrialItem } from './evals-artifacts';
import { deploymentOf } from './infra-manifest';
import { REPO_ROOT as ROOT } from './repo-root';


/** Light deploy-driver post-steps use the workstation's serialized 4G scope, never uncapped local work. */
export const LOCAL_CHECK = '/mnt/local/kinu/bin/local-check.sh';

/** A step that waits on the network (a deployment, Cloudflare's logs, a model's diagnosis or review): a 4G scope of its
 *  own, never the shared check lock, which serializes short local checks and stops one at ten minutes, mid-answer for a
 *  model. An eval run has no elapsed limit (AGENTS.md); a step ends when its work does. */
export const NETWORK_SCOPE = ['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=4G', '-p', 'MemorySwapMax=0', '--'] as const;

/** The two comments a run posts on the build it measured, each with the marker its next run replaces it by. */
const COMMENTS = [['comparison', '<!-- kinu-evals-results -->'], ['why', '<!-- kinu-evals-why -->']] as const;

/** The `gh` a run posts through: `GH`, else the one on `PATH`; null when neither names one. Resolved here, in the
 *  caller's environment, and handed to the posting script as `GH`, so the scope it runs in need not find it. */
export function resolveGh(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env['GH'];

  if (named !== undefined && named !== '') return Bun.which(named, { PATH: env['PATH'] ?? '' });

  return Bun.which('gh', { PATH: env['PATH'] ?? '' });
}

/** A step a finished run runs: its argv, run in the network scope; its exit code. */
export type SettleStep = (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;

const scoped: SettleStep = async (argv, env) => {
  const child = Bun.spawn([...NETWORK_SCOPE, ...argv], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });

  return await child.exited;
};

/**
 * What a finished run does with its report at `dir`: records its verdict for `promote.ts` when `record`, then posts its
 * comments on `post`'s build. The verdict comes first, and a comment that could not be posted is reported, never
 * thrown: 2026-10-19, `gh: command not found` threw after 3.5 hours of trials and the verdict never reached
 * `promote.ts`. A verdict that could not be recorded still throws: that is the run's failure.
 */
export async function settleEvalRun(input: {
  readonly dir: string;
  readonly record: boolean;
  readonly post: string | undefined;
  readonly gh: string | null;
  readonly step?: SettleStep;
}): Promise<{ readonly unposted: readonly string[] }> {
  const step = input.step ?? scoped;

  if (input.record && await step([process.execPath, 'scripts/promote.ts', 'evals', input.dir], process.env) !== 0) {
    throw new Error('recording this eval verdict failed');
  }

  if (input.post === undefined) return { unposted: [] };
  const unposted: string[] = [];

  for (const [name, marker] of COMMENTS) {
    const exit = input.gh === null ? null
      : await step(['bash', 'evals/scripts/post-comment.sh', input.post, join(input.dir, name, 'comment.md'), marker], { ...process.env, GH: input.gh });

    if (exit === 0) continue;
    unposted.push(name);
    console.error(`evals: the ${name} comment was not posted on ${input.post} (${exit === null ? 'no gh: put it on PATH or name it in GH' : `post-comment.sh exited ${String(exit)}`}); `
      + `the verdict stands. Post it again with: bun scripts/evals-map.ts --settle=${input.dir} --post=${input.post}`);
  }

  return { unposted };
}

export async function processEvals(run: EvalRun, items: readonly TrialItem[], outcomes: readonly MapResult[], dir: string): Promise<number> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);

  const reports: { item: TrialItem; path?: string; failure: string }[] = [];

  for (const [index, item] of items.entries()) {
    const outcome = outcomes.find((entry) => entry.index === index);

    if (outcome?.artifacts === undefined || outcome.exitCode !== 0) {
      reports.push({ item, failure: outcome === undefined ? 'armada returned no outcome' : `${outcome.kind}: ${outcome.tail}` });
      continue;
    }

    const into = outcome.artifacts;
    const row = v.parse(v.object({ artifacts: v.array(v.string()) }), JSON.parse(readFileSync(join(into, 'row.json'), 'utf8')));

    if (row.artifacts.some((path) => !existsSync(join(into, path)))) throw new Error(`trial ${String(index)} names evidence its task did not keep`);
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

  // The legs the run planned, read off its items: a leg whose every trial was lost still reports, empty.
  const legs = [...new Set(items.map((item) => item.leg))];

  for (const leg of legs) {
    const legDir = join(dir, leg);

    mkdirSync(legDir, { recursive: true });
    writeFileSync(join(legDir, 'results.json'), `${joinTrialReports(reports.filter(({ item }) => item.leg === leg))}\n`);
  }

  // Every command below is a post-step of the same artifacts. A failed advisory review is recorded,
  // never swapped for a mock diagnosis and never substituted for the comparison's verdict.
  const step = async (name: string, argv: readonly string[], { origin, network = false }: { readonly origin?: string; readonly network?: boolean } = {}): Promise<number> => {
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (origin !== undefined) env['KINU_EVAL_ORIGIN'] = origin;

    const child = Bun.spawn([...network ? NETWORK_SCOPE : [LOCAL_CHECK], process.execPath, ...argv], { cwd: ROOT,
      env, stdout: 'pipe', stderr: 'pipe' });

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
    const workers = { candidate: deploymentOf('staging').worker, baseline: deploymentOf('production').worker };

    for (const leg of legs) {
      await step(`${leg}-platform`, ['evals/scripts/platform-bugs.ts', join(dir, leg, 'results.json'),
        '--worker', workers[leg], '--out', join(dir, leg, 'platform.json')], { network: true });
      await step(`${leg}-validate`, ['evals/scripts/validate.ts', join(dir, leg, 'results.json'), '--trials', String(run.trials)]);
    }

    const compareArgs = ['evals/scripts/compare.ts', '--candidate', join(dir, 'candidate', 'results.json'),
      ...legs.includes('baseline') ? ['--baseline', join(dir, 'baseline', 'results.json'), '--baseline-build', run.baselineBuild] : [],
      '--candidate-build', run.candidateBuild,
      '--tasks', run.taskFiles.map((file) => file.slice('evals/tasks/'.length).replace(/\.eval\.ts$/u, '')).join(','),
      '--trials', String(run.trials), '--out', join(dir, 'comparison')];

    for (const leg of legs) {
      const platform = join(dir, leg, 'platform.json');

      if (existsSync(platform)) compareArgs.push(`--${leg}-platform`, platform);
    }

    if (await step('compare', compareArgs) !== 0) throw new Error('comparison failed: compare.log retains its real error');
    const verdict = v.parse(v.object({ pass: v.boolean(), reason: v.string() }), JSON.parse(readFileSync(join(dir, 'comparison', 'verdict.json'), 'utf8')));

    writeFileSync(join(dir, 'verdict.log'), `${verdict.reason}\n`);
    await step('trajectories', ['evals/scripts/trajectories.ts', join(dir, 'candidate', 'results.json'), join(dir, 'comparison', 'trajectories.md')]);
    writeFileSync(join(dir, 'comparison', 'comment.md'), `<!-- kinu-evals-results -->\n${readFileSync(join(dir, 'comparison', 'comparison.md'), 'utf8')}\nArmada jobs: ${run.jobs.join(', ')}.\n`);

    // Staging alone compares models on one build: its report is the result, and there is no verdict to stand or fall.
    if (!legs.includes('baseline')) return 0;
    verdictExit = verdict.pass ? 0 : 1;
    mkdirSync(join(dir, 'why'), { recursive: true });

    const diagnosis = await step('diagnose', ['evals/scripts/diagnose.ts', '--results', join(dir, 'candidate', 'results.json'),
      '--baseline', join(dir, 'baseline', 'results.json'), '--comparison', join(dir, 'comparison', 'comparison.json'),
      '--evidence', join(dir, 'candidate', 'evidence'), '--out', join(dir, 'why', 'why.md')], { origin: deploymentOf('staging').origin, network: true });

    const review = await step('review', ['evals/scripts/review.ts', '--results', join(dir, 'candidate', 'results.json'),
      '--comparison', join(dir, 'comparison', 'comparison.json'), '--out', join(dir, 'why')], { origin: deploymentOf('staging').origin, network: true });

    const pages = ['why.md', 'review.md'].filter((name) => existsSync(join(dir, 'why', name)))
      .map((name) => readFileSync(join(dir, 'why', name), 'utf8'));

    if (pages.length > 0) writeFileSync(join(dir, 'why', 'comment.md'), `<!-- kinu-evals-why -->\n${pages.join('\n')}\n`);
    writeFileSync(join(dir, 'advisory.json'), `${JSON.stringify({ diagnosis, review })}\n`);
  }

  return verdictExit;
}
