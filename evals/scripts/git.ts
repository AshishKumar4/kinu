import { spawnSync } from 'node:child_process';
import { stripGitContext } from '../../packages/test-utils/src/git-env';
import { DEFINITION_PATHS, EXERCISED_PATHS } from '../src/config';
import type { CommitQuestions } from '../src/comparison';

/** `git` in this checkout, its exit status an answer (`diff --quiet`, `cat-file -e`). A hook's `GIT_DIR` is dropped so
 *  it cannot answer for another repository; the user's own config and agent stay, since this one fetches from origin,
 *  which `gitIn`'s bare environment could not. */
export function git(args: readonly string[]) {
  const env = { ...process.env };

  stripGitContext(env);
  // A release's product diff runs to megabytes; spawnSync's default 1 MiB buffer is no limit of git's.
  const result = spawnSync('git', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: Infinity });

  if (result.error !== undefined) throw new Error(`git ${args.join(' ')} could not start`, { cause: result.error });

  return { status: result.status ?? 1, stdout: result.stdout };
}

/** A build may predate a shallow checkout; fetch its commit on demand. */
export function ensureCommit(sha: string): void {
  if (git(['cat-file', '-e', `${sha}^{commit}`]).status === 0) return;

  if (git(['fetch', '--no-tags', '--depth=1', 'origin', sha]).status !== 0) {
    throw new Error(`commit ${sha} is not in this checkout or on origin`);
  }
}

/** What only this checkout can answer about two commits a comparison holds: whether the code that defines or scores a
 *  trial changed between two eval commits, and which exercised files changed between two builds. */
export const COMMIT_QUESTIONS: Required<CommitQuestions> = {
  definitionsChanged(baselineCommit, candidateCommit) {
    ensureCommit(baselineCommit);
    ensureCommit(candidateCommit);
    const status = git(['diff', '--quiet', baselineCommit, candidateCommit, '--', ...DEFINITION_PATHS]).status;

    if (status > 1) throw new Error(`git diff ${baselineCommit} ${candidateCommit} exited with ${String(status)}`);

    return status === 1;
  },
  changedFiles: (baselineSha, candidateSha) => diffBetween(baselineSha, candidateSha, { paths: EXERCISED_PATHS, names: true })
    .split('\n').filter((line) => line !== ''),
};

/** `git diff` between two commits over `paths`: the file names, or the patch itself. */
export function diffBetween(from: string, to: string, request: { paths: readonly string[]; names: boolean }): string {
  ensureCommit(from);
  ensureCommit(to);
  const diff = git(['diff', ...request.names ? ['--name-only'] : [], from, to, '--', ...request.paths]);

  if (diff.status !== 0) throw new Error(`git diff ${from} ${to} exited with ${String(diff.status)}`);

  return diff.stdout;
}
