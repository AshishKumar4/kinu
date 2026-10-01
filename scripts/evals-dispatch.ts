#!/usr/bin/env bun
/**
 * THE EVALS OF A STAGING BUILD, STARTED ON GITHUB (L19). `.github/workflows/evals.yml` runs every eval task ten times
 * on staging, which must be serving `<build>`, and on production, the baseline; its Verdict job is what a promotion
 * waits for. GitHub runs a dispatched workflow as the dispatched ref defines it, so the ref is the branch the build came
 * from, read from git rather than named: of the branches on origin that hold the build, the one whose tip is the
 * fewest commits past it (integration/0965 while that release is open). A default branch that has not caught up would
 * run an older workflow, or refuse the inputs.
 *
 *   bun scripts/evals-dispatch.ts <build sha>      from the deploy's checkout
 *
 * Prints `<run id> <run url> <branch>`; otherwise why nothing was dispatched, and exits 1. The API version that answers
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

/** The branch on origin a build's evals run from, or why there is none. */
export function evalsBranch(repo: string, build: string): { readonly branch: string } | { readonly why: string } {
  const listed = git(repo, ['for-each-ref', '--contains', build, '--format=%(refname:strip=3)', 'refs/remotes/origin/']);

  if (!listed.ok) return { why: `git cannot say which branches hold ${build}: ${listed.out}` };
  const holding = listed.out.split('\n').filter((branch) => branch !== '' && branch !== 'HEAD');

  if (holding.length === 0) return { why: `no branch on origin holds ${build}: push the branch it came from, then deploy again` };

  const past = (branch: string): number => Number(git(repo, ['rev-list', '--count', `${build}..refs/remotes/origin/${branch}`]).out);

  const [nearest] = holding.map((branch) => ({ branch, past: past(branch) }))
    .sort((left, right) => left.past - right.past || left.branch.localeCompare(right.branch));

  return { branch: nearest?.branch ?? '' };
}

/** Starts the evals of `build` from `branch`: the run's id and URL, or why GitHub started none. */
function dispatch(repo: string, build: string, branch: string): { readonly run: number; readonly url: string } | { readonly why: string } {
  let answer: ReturnType<typeof Bun.spawnSync>;

  try {
    answer = Bun.spawnSync([
      'gh', 'api', '-X', 'POST', '-H', `X-GitHub-Api-Version: ${DISPATCH_API_VERSION}`,
      'repos/{owner}/{repo}/actions/workflows/evals.yml/dispatches', '-f', `ref=${branch}`, '-f', `inputs[build]=${build}`,
    ], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  } catch (cause) {
    return { why: `gh could not be started: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const said = `${answer.stdout?.toString() ?? ''}${answer.stderr?.toString() ?? ''}`.trim().slice(0, 300);

  if (answer.exitCode !== 0) return { why: `GitHub refused the dispatch from ${branch}: ${said}` };
  let parsed: v.SafeParseResult<typeof DispatchedSchema>;

  try {
    parsed = v.safeParse(DispatchedSchema, JSON.parse(answer.stdout?.toString() ?? ''));
  } catch (cause) {
    return { why: `GitHub answered the dispatch from ${branch} with no JSON (${cause instanceof Error ? cause.message : String(cause)}): ${said}` };
  }

  return parsed.success ? { run: parsed.output.workflow_run_id, url: parsed.output.html_url } : { why: `GitHub named no run for the dispatch from ${branch}: ${said}` };
}

if (import.meta.main) {
  const build = process.argv[2] ?? '';

  if (!/^[0-9a-f]{7,40}$/u.test(build)) {
    console.log('usage: bun scripts/evals-dispatch.ts <build sha>');
    process.exit(2);
  }

  const repo = process.cwd();
  const found = evalsBranch(repo, build);

  if ('why' in found) {
    console.log(found.why);
    process.exit(1);
  }

  const started = dispatch(repo, build, found.branch);

  if ('why' in started) {
    console.log(started.why);
    process.exit(1);
  }

  console.log(`${String(started.run)} ${started.url} ${found.branch}`);
}
