/**
 * Credentials and decoration vars a test process must not inherit from its shell: an ambient
 * `KINU_TOKEN`/`KINU_ORIGIN` flips isolated-`KINU_HOME` tests onto the signed-in branch. Kept apart
 * from `live-model.ts` so the preload does not load `@kinu.run/core` into every test file.
 */

/** The env vars the live-model resolver reads, named once for its errors and the docs. */
export const LIVE_MODEL_ENV = {
  origin: 'KINU_ORIGIN',
  token: 'KINU_TOKEN',
  gatewayURL: ['AI_GATEWAY_BASE_URL', 'KINU_BASE_URL'],
  gatewayAuth: ['AI_GATEWAY_AUTH', 'KINU_AUTH'],
  model: ['AI_GATEWAY_MODEL', 'KINU_MODEL'],
} as const;

/**
 * Every name above, flattened, so a target the resolver learns is stripped too. Model ids are included:
 * they select which provider a workspace resolves through.
 */
export const AMBIENT_CREDENTIAL_ENV: readonly string[] = Object.values(LIVE_MODEL_ENV).flat();

/**
 * Ambient terminal decoration vars, stripped for the same reason: colour codes land between the tokens
 * content assertions bind. `NO_COLOR` goes too. Tests asserting decoration set these on their own child.
 */
export const AMBIENT_DECORATION_ENV: readonly string[] = ['FORCE_COLOR', 'CLICOLOR_FORCE', 'CLICOLOR', 'NO_COLOR'];

/** An environment as two operations by name: `scripts/ladder-closure.ts` can bound a read by name but
 *  not an object handed over whole. */
export interface EnvByName {
  readonly has: (name: string) => boolean;
  readonly remove: (name: string) => void;
}

/**
 * Remove the ambient credentials and decoration vars; return the names that were present so the
 * preload can report them. Mutates via `remove` before any test file loads, so spawned children inherit it.
 */
export function stripAmbientCredentials(env: EnvByName): readonly string[] {
  const removed: string[] = [];

  for (const name of [...AMBIENT_CREDENTIAL_ENV, ...AMBIENT_DECORATION_ENV]) {
    if (!env.has(name)) continue;
    removed.push(name);
    env.remove(name);
  }

  return removed;
}

/** The process environment projected onto `names`, read by computed key so the ladder's closure walker
 *  can bound it (unlike a `process.env` default). */
export function ambientByName(names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

/** The names a test's child process needs from the ambient environment (paths, home, temp, locale);
 *  spreading `process.env` would make spawning suites uncacheable by the closure walker. */
export const CHILD_ENV_NAMES: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'KINU_HOME', 'KINU_INFLIGHT_ROOT', 'BUN_INSTALL',
];

/** The environment for a child a test spawns: {@link CHILD_ENV_NAMES} by name, then `overrides`.
 *  Absent names stay absent. */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries({ ...ambientByName(CHILD_ENV_NAMES), ...overrides })) {
    if (value !== undefined) env[name] = value;
  }

  return env;
}

/** A plain object as {@link EnvByName}. Presence is the test, never truthiness: `KINU_BASE_URL=` clears. */
export function envObject(env: Record<string, string | undefined>): EnvByName {
  return {
    has: (name) => name in env,
    remove: (name) => { delete env[name]; },
  };
}
