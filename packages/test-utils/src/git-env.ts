import { execFileSync } from 'node:child_process';

/** A hook's repository, index and object-store variables override a spawned git's cwd. */
export function stripGitContext(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
}

/**
 * `git` against a throwaway repository. Hooks export `GIT_DIR`/`GIT_WORK_TREE`, which override `cwd`,
 * so the env is built from an allowlist (dropping every `GIT_*`) and global/system config point at /dev/null.
 * Its own module, importing only Node's own, because scripts/sources.ts loads it under raw Node from the lint plugin.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL } = process.env;
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

  for (const [name, value] of Object.entries({ PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL })) {
    if (value !== undefined) env[name] = value;
  }

  return env;
}

/**
 * `git -C repo …` with {@link gitEnv}, its stdout trimmed: the tooling's one synchronous git. A non-zero exit throws
 * with git's own words. The environment pins the repository, so a hook's `GIT_DIR` cannot answer for it, and no one's
 * global config shapes the answer.
 */
export function gitIn(repo: string, ...args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { env: gitEnv(), encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}
