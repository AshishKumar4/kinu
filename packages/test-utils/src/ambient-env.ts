/**
 * The credentials a test process must not inherit from the shell that launched
 * it, and the one function that takes them out of an environment.
 *
 * WHY THIS EXISTS. `liveModelTarget()` already refuses to SPEND an ambient
 * credential without explicit consent: "a developer's exported credential is a
 * fact about their shell, never a request to bill the owner's account during a
 * commit". This module is the other half of that sentence — an ambient
 * credential must not change what a suite MEASURES either, and nothing stopped
 * it from doing so.
 *
 * Measured on 2026-08-19 at 3ec8eded, `bun test packages/cli/`, one variable
 * pair changed and nothing else:
 *
 *   unset PROTEUS_ORIGIN PROTEUS_TOKEN   312 pass,  0 fail
 *   both exported                        302 pass, 10 fail
 *
 * `resolveCloudSession()` (cli/src/config.ts) prefers `PROTEUS_TOKEN` over the
 * config file, and `resolveCloudOrigin()` prefers `PROTEUS_ORIGIN` over it, so
 * thirteen tests across six files that had each built an isolated
 * `PROTEUS_HOME` holding no session took the SIGNED-IN branch instead. WHICH
 * ten of the thirteen go red depends on what the ambient origin answers — a
 * reachable account reds a different eight than an unreachable one — so the
 * failures move between runs and read as a defect in the code under test. They
 * were chased as one for most of a day.
 *
 * The suites were already isolated against the CONFIG FILE: `test-scratch-home`
 * gives every test process a throwaway `PROTEUS_HOME`, for exactly this reason
 * one layer down. The environment was the half nobody had done, and doing it
 * per test file is the thing that does not scale: `providers-command.test.ts`
 * blanks six variables in its own spawn helper and `behavior.test.ts` blanks
 * six more in its own, both correctly, and neither covers `PROTEUS_TOKEN`.
 *
 * The names are `LIVE_MODEL_ENV`'s, and they live here rather than in
 * `live-model.ts` so that the preload can read them without pulling
 * `@proteus/core` and the AI SDK into all 400+ test files.
 */

/** The env vars the live-model resolver reads, so its failure messages and the
 *  docs can name them without a second copy. */
export const LIVE_MODEL_ENV = {
  origin: 'PROTEUS_ORIGIN',
  token: 'PROTEUS_TOKEN',
  gatewayURL: ['AI_GATEWAY_BASE_URL', 'PROTEUS_BASE_URL'],
  gatewayAuth: ['AI_GATEWAY_AUTH', 'PROTEUS_AUTH'],
  model: ['AI_GATEWAY_MODEL', 'PROTEUS_MODEL'],
} as const;

/**
 * Every name above, flattened — derived rather than restated, so a target the
 * resolver learns to read is a target the strip removes on the same commit.
 *
 * `PROTEUS_MODEL` and the gateway model belong here even though a model id is
 * not a secret: it selects which provider a workspace resolves through, which
 * is precisely what `proteus create`'s "no connected provider" warning reports
 * on.
 */
export const AMBIENT_CREDENTIAL_ENV: readonly string[] = Object.values(LIVE_MODEL_ENV).flat();

/**
 * Remove the ambient credentials from `env`, and return the names that were
 * actually there.
 *
 * Mutates, because the only caller that matters mutates `process.env` before
 * any test file loads — every child process a suite spawns inherits from it, so
 * one strip at the top covers both the in-process reads and the spawn helpers
 * that pass `{ ...process.env }`.
 *
 * The returned names are what makes the strip say something rather than being
 * silent: a developer whose shell is signed in should be told their credential
 * is not in play, not left to infer it.
 */
export function stripAmbientCredentials(env: Record<string, string | undefined>): readonly string[] {
  const removed: string[] = [];
  for (const name of AMBIENT_CREDENTIAL_ENV) {
    if (!(name in env)) continue;
    removed.push(name);
    delete env[name];
  }
  return removed;
}
