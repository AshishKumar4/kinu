/** A hook's repository, index and object-store variables override a spawned git's cwd. */
export function stripGitContext(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
}

/**
 * `git` against a throwaway repository. Hooks export `GIT_DIR`/`GIT_WORK_TREE`, which override `cwd`,
 * so the env is built from an allowlist (dropping every `GIT_*`) and global/system config point at /dev/null.
 * Its own module, free of imports, because scripts/sources.ts loads it under raw Node from the lint plugin.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL } = process.env;
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

  for (const [name, value] of Object.entries({ PATH, HOME, XDG_CONFIG_HOME, TMPDIR, LANG, LC_ALL, TZ, USER, LOGNAME, EMAIL })) {
    if (value !== undefined) env[name] = value;
  }

  return env;
}
