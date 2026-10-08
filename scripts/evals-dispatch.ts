#!/usr/bin/env bun
/**
 * THE EVALS OF A STAGING BUILD, STARTED ON GITHUB (L19). `.github/workflows/evals.yml` runs every eval task ten times
 * on staging, which must be serving `<build>`, and on production, the baseline; its Verdict job is what a promotion
 * waits for. The `eval` environment releases its secrets to main alone (its deployment branch policy), so the ref is
 * main, which must hold the build: GitHub runs a dispatched workflow as that ref defines it, and a release pushes main
 * before it deploys.
 *
 *   bun scripts/evals-dispatch.ts <build sha>      from the deploy's checkout
 *
 * Prints `<run id> <run url>`; otherwise why nothing was dispatched, and exits 1. The API version that answers
 * a dispatch with the run it started is asked for by name.
 */
import * as v from 'valibot';

/** What GitHub answers a dispatch with, in the API version asked for below. */
const DispatchedSchema = v.looseObject({ workflow_run_id: v.number(), html_url: v.string() });

const DISPATCH_API_VERSION = '2026-03-10';

function git(repo: string, args: readonly string[]) {
  const run = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });

  return { ok: run.exitCode === 0, out: (run.exitCode === 0 ? run.stdout : run.stderr).toString().trim() };
}

/** Why `build`'s evals cannot start from main, or null when main on origin holds it. */
function mainRefusal(repo: string, build: string): string | null {
  const listed = git(repo, ['for-each-ref', '--contains', build, '--format=%(refname)', 'refs/remotes/origin/main']);

  if (!listed.ok) return `git cannot say whether main on origin holds ${build}: ${listed.out}`;

  return listed.out === '' ? `main on origin does not hold ${build}: the eval environment accepts only main, and the release pushes main first` : null;
}

/** Starts the evals of `build` from main: the run's id and URL, or why GitHub started none. */
function dispatch(repo: string, build: string): { readonly run: number; readonly url: string } | { readonly why: string } {
  let answer: ReturnType<typeof Bun.spawnSync>;

  try {
    answer = Bun.spawnSync([
      'gh', 'api', '-X', 'POST', '-H', `X-GitHub-Api-Version: ${DISPATCH_API_VERSION}`,
      'repos/{owner}/{repo}/actions/workflows/evals.yml/dispatches', '-f', 'ref=main', '-f', `inputs[build]=${build}`,
    ], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  } catch (cause) {
    return { why: `gh could not be started: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const said = `${answer.stdout?.toString() ?? ''}${answer.stderr?.toString() ?? ''}`.trim().slice(0, 300);

  if (answer.exitCode !== 0) return { why: `GitHub refused the dispatch from main: ${said}` };
  let parsed: v.SafeParseResult<typeof DispatchedSchema>;

  try {
    parsed = v.safeParse(DispatchedSchema, JSON.parse(answer.stdout?.toString() ?? ''));
  } catch (cause) {
    return { why: `GitHub answered the dispatch from main with no JSON (${cause instanceof Error ? cause.message : String(cause)}): ${said}` };
  }

  return parsed.success ? { run: parsed.output.workflow_run_id, url: parsed.output.html_url } : { why: `GitHub named no run for the dispatch from main: ${said}` };
}

if (import.meta.main) {
  const build = process.argv[2] ?? '';

  if (!/^[0-9a-f]{7,40}$/u.test(build)) {
    console.log('usage: bun scripts/evals-dispatch.ts <build sha>');
    process.exit(2);
  }

  const repo = process.cwd();
  const refused = mainRefusal(repo, build);

  if (refused !== null) {
    console.log(refused);
    process.exit(1);
  }

  const started = dispatch(repo, build);

  if ('why' in started) {
    console.log(started.why);
    process.exit(1);
  }

  console.log(`${String(started.run)} ${started.url}`);
}
