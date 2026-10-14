/**
 * The deployment plumbing every ephemeral devbox benchmark needs, owned once.
 *
 * What belongs here is what is true of ANY ephemeral deployed benchmark on this
 * platform, each line bought with a failed run:
 *
 *   - The account must be named non-interactively, because this credential can
 *     see more than one and wrangler refuses to choose (`infra-cloudflare.ts` names it).
 *   - `wrangler delete` needs TWO routes: `--config` has failed against
 *     /workers/services while `--name` succeeded on the first try.
 *   - Deleting the Worker does NOT delete its container application, which keeps
 *     a live instance and blocks the next deploy on the name: it is listed and
 *     deleted by `containerApplicationsNamed` and `deleteContainerApplication`
 *     (`infra-cloudflare.ts`), as the reset deletes one.
 *   - `finally` does not run on a signal, and a killed driver has already left a
 *     fixture Worker live on workers.dev once.
 *
 * What does NOT belong here is anything about arms, phases, layouts or
 * strategies. This module knows how to raise and remove a deployment; it knows
 * nothing about what is measured inside one.
 */

import { wrangler } from './infra-cloudflare';

/** One line for a thrown value, in the shape `new Error(message, { cause })`
 *  already spells. */
export const describeThrown = ({ cause }: { cause: unknown }): string =>
  cause instanceof Error ? cause.message : String(cause);

export const delay = async (ms: number): Promise<void> => {
  const settle = Promise.withResolvers<void>();
  setTimeout(() => settle.resolve(), ms);
  await settle.promise;
};

export interface WranglerOptions {
  readonly allowFailure?: boolean;
}

/** Marker a failed `allowFailure` call returns, so a caller can branch on it
 *  without a second error channel. */
export const WRANGLER_FAILED = 'WRANGLER_FAILED';

const EXPLICIT_ABSENCE = /(?:not found|could not find|already deleted|does not exist|script_not_found|code:\s*100(?:07|21))/i;

/** A successful deletion or an explicit not-found response proves absence.
 * Authentication, account-selection, transport and server failures do not. */
export function wranglerProvesAbsence(output: string): boolean {
  return !output.startsWith(WRANGLER_FAILED) || EXPLICIT_ABSENCE.test(output);
}

/** A benchmark's wrangler call, run from `repoRoot` to completion: its output, or a refusal by policy. */
export function runWrangler(
  repoRoot: string,
  args: readonly string[],
  options: WranglerOptions = {},
): string {
  const run = wrangler(args, { cwd: repoRoot, timeoutMs: null });

  if (run.ok) return run.stdout;
  const detail = `${run.stderr}${run.stdout}`.trim() || `exit ${String(run.code)}`;

  if (options.allowFailure === true) return `${WRANGLER_FAILED}: ${detail}`;
  throw new Error(`wrangler ${args.join(' ')} failed: ${detail}`);
}

/**
 * Teardown reachable from a signal.
 *
 * MEASURED: `finally` does not run when the process is killed, and a SIGTERM
 * mid-run has already left a fixture Worker live on workers.dev once. A driver
 * publishes its teardown here as soon as it has something to tear down; the
 * handlers run it exactly once before exiting.
 */
let teardownHook: (() => Promise<void>) | null = null;

let teardownRan = false;

export function publishTeardown(hook: () => Promise<void>): void {
  teardownHook = hook;
}

export async function runTeardownOnce(): Promise<void> {
  if (teardownRan || teardownHook === null) return;
  teardownRan = true;
  await teardownHook();
}

