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
 * The environment is BUILT, never copied: an explicit list of the names a git
 * process legitimately reads, each taken from `process.env` by name. That is
 * what drops every `GIT_*` — `GIT_DIR` is only the one that bit, but
 * `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR` and
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` all redirect a git process at another
 * repository the same way, and hooks export several of them — and it is also
 * what lets the ladder's input closure (`scripts/ladder-closure.ts`) bound
 * what a git child can see. The previous shape copied `process.env` minus the
 * prefix, and a copy of the whole environment is an input no list of names
 * stands for, so every gate reading the corpus through this helper was
 * uncacheable by that one line. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are
 * set to `/dev/null`, because a fixture that reads the developer's
 * `~/.gitconfig` is a different flavour of the same mistake.
 *
 * The names: `PATH` finds git and the helpers it execs; `HOME` and
 * `XDG_CONFIG_HOME` are where git looks before the two config overrides say
 * not to; `TMPDIR` is where it writes; `LANG`/`LC_ALL` choose its message
 * language, which a test may assert on; `TZ` dates a fixture commit; `USER`,
 * `LOGNAME` and `EMAIL` are its identity fallbacks where no repo config sets
 * one. A name not here is a name git does not get.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL } = process.env;
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

  for (const [name, value] of Object.entries({ PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL })) {
    if (value !== undefined) env[name] = value;
  }

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
