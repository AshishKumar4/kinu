import { spawnSync } from 'node:child_process';

export function git(args: readonly string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

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

/** `git diff` between two commits over `paths`: the file names, or the patch itself. */
export function diffBetween(from: string, to: string, request: { paths: readonly string[]; names: boolean }): string {
  ensureCommit(from);
  ensureCommit(to);
  const diff = git(['diff', ...request.names ? ['--name-only'] : [], from, to, '--', ...request.paths]);

  if (diff.status !== 0) throw new Error(`git diff ${from} ${to} exited with ${String(diff.status)}`);

  return diff.stdout;
}
