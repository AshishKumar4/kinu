import { execFileSync } from 'node:child_process';

/**
 * `git` against a throwaway repository. Hooks export `GIT_DIR`/`GIT_WORK_TREE`, which override `cwd`,
 * so the env is built from an allowlist (dropping every `GIT_*`) and global/system config point at /dev/null.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL } = process.env;
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

  for (const [name, value] of Object.entries({ PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL })) {
    if (value !== undefined) env[name] = value;
  }

  return env;
}

/** Run `git` inside `repo` and return stdout; `-C` plus the clean env both pin the repository. */
export function git(repo: string, ...args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository with one commit at `repo`, identity set on the repo. */
export function initRepo(repo: string): void {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'kinu@example.invalid');
  git(repo, 'config', 'user.name', 'Kinu Test');
}
