import { execFileSync } from 'node:child_process';

/**
 * `git` against a throwaway repository, with the ambient one unset.
 *
 * A git hook EXPORTS `GIT_DIR` and `GIT_WORK_TREE`, and git obeys those over
 * `cwd`. So a fixture written as `execFileSync('git', ['commit'], { cwd: repo })`
 * is correct when the suite is run by hand and operates on the DEVELOPER'S
 * CHECKOUT when the same suite is run by `pre-commit` or `pre-push`.
 *
 * That is not a hypothetical. Measured 2026-08-17 in
 * `.claude/worktrees/adapter-hoist`, under `git push`: the workspace-diff
 * fixture's `git commit -qm seed` landed a commit named `seed` on the branch
 * being pushed, adding a root-level `tracked.txt`. The commit then re-entered
 * the pre-commit hook — the whole gate ladder, inside a 5-second test — and the
 * test timed out. Four pushes failed that way, each one leaving another junk
 * commit behind, and the suite passed every time it was run directly.
 *
 * The environment is rebuilt rather than patched: `GIT_DIR` is only the one that
 * bit, but `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR` and
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` all redirect a git process at another
 * repository the same way, and hooks export several of them. Dropping the whole
 * `GIT_` prefix is the only version that does not need a list kept current.
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are then set to `/dev/null`, because a
 * fixture that reads the developer's `~/.gitconfig` is a different flavour of
 * the same mistake.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  return env;
}

/** Run `git` inside `repo` and return its stdout. Uses `-C` as well as a clean
 *  environment: two independent ways of saying which repository, so neither one
 *  going wrong is silent. */
export function git(repo: string, ...args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository with one commit, at `repo`, isolated from every ambient git
 *  setting. The identity is set on the repo rather than inherited, so the
 *  fixture does not depend on the developer having one. */
export function initRepo(repo: string): void {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'kinu@example.invalid');
  git(repo, 'config', 'user.name', 'Kinu Test');
}
