/**
 * The deployment plumbing both benchmark drivers need, owned once.
 *
 * `scripts/bench-r2-workspace.ts` and `scripts/bench-devbox-strategies.ts` each
 * grew their own copy of this while they were being built against a platform that
 * refused them in a new way every run. Both copies now work, and they had already
 * begun to drift: the same `accountId` with two different error messages, the same
 * `wrangler` wrapper with two different ways of describing a thrown value. That
 * drift is the reason to extract rather than a reason to wait — two copies of
 * recovery logic diverge silently, and the next platform lesson gets learned by
 * one of them.
 *
 * What belongs here is what is true of ANY ephemeral deployed benchmark on this
 * platform, each line bought with a failed run:
 *
 *   - The account must be named non-interactively, because this credential can
 *     see more than one and wrangler refuses to choose.
 *   - `wrangler delete` needs TWO routes: `--config` has failed against
 *     /workers/services while `--name` succeeded on the first try.
 *   - Deleting the Worker does NOT delete its container application, which keeps
 *     a live instance and blocks the next deploy on the name.
 *   - `finally` does not run on a signal, and a killed driver has already left a
 *     fixture Worker live on workers.dev once.
 *
 * What does NOT belong here is anything about arms, phases, layouts or
 * strategies. This module knows how to raise and remove a deployment; it knows
 * nothing about what is measured inside one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

/** What `wrangler containers list --json` is trusted to say. Parsed rather than
 *  cast, because a listing this driver cannot understand must not read as
 *  "nothing to clean up" — a leaked container application holds a live instance
 *  and blocks the next deploy. */
const ContainerAppListSchema = v.array(v.looseObject({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
}));

/** One line for a thrown value, in the shape `new Error(message, { cause })`
 *  already spells. */
export const describeThrown = ({ cause }: { cause: unknown }): string =>
  cause instanceof Error ? cause.message : String(cause);

export const delay = async (ms: number): Promise<void> => {
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, ms);
  await settle.promise;
};

/**
 * The account every wrangler call runs against.
 *
 * MEASURED: `wrangler r2 bucket` takes no config file, and this credential can
 * see more than one account, so wrangler refuses to choose and the run dies
 * before it starts. Read from the product's own config rather than duplicated,
 * so a benchmark cannot end up measuring a different account than the product
 * deploys to. `CLOUDFLARE_ACCOUNT_ID` still wins, which is how
 * `scripts/deploy.sh` is parameterised too.
 */
export function accountId(repoRoot: string): string {
  const fromEnv = process.env['CLOUDFLARE_ACCOUNT_ID'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const config = readFileSync(join(repoRoot, 'packages/cf-backend/wrangler.jsonc'), 'utf8');
  const found = /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(config);
  if (found === null) {
    throw new Error(
      'no account_id in packages/cf-backend/wrangler.jsonc and no CLOUDFLARE_ACCOUNT_ID in the '
      + 'environment, so wrangler cannot pick an account non-interactively.',
    );
  }
  const id = found[1];
  if (id === undefined) throw new Error('account_id match contained no capture');
  return id;
}

export interface WranglerOptions {
  readonly allowFailure?: boolean;
}

/** Marker a failed `allowFailure` call returns, so a caller can branch on it
 *  without a second error channel. */
export const WRANGLER_FAILED = 'WRANGLER_FAILED';

export function runWrangler(
  repoRoot: string,
  args: readonly string[],
  options: WranglerOptions = {},
): string {
  try {
    return execFileSync('bunx', ['wrangler', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId(repoRoot) },
    });
  } catch (error) {
    const detail = describeThrown({ cause: error });
    if (options.allowFailure === true) return `${WRANGLER_FAILED}: ${detail}`;
    throw new Error(`wrangler ${args.join(' ')} failed: ${detail}`, { cause: error });
  }
}

/**
 * Container applications matching `names`, by id.
 *
 * MEASURED: `wrangler delete` removes the Worker and LEAVES the container
 * application behind holding a live instance, so the next deploy fails with
 * "already an application with the name … associated with a different durable
 * object namespace". `containers delete` takes an id rather than a name, which is
 * why this resolves one.
 */
export function containerAppIds(
  repoRoot: string,
  names: readonly string[],
  log: (message: string) => void,
  wrangle: typeof runWrangler = runWrangler,
): { id: string; name: string }[] {
  const output = wrangle(repoRoot, ['containers', 'list', '--json'], { allowFailure: true });
  if (output.startsWith(WRANGLER_FAILED)) {
    log(`container application listing failed: ${output.slice(0, 240)}`);
    throw new Error('container application listing failed; absence is unproved');
  }
  const start = output.indexOf('[');
  if (start === -1) {
    log(`container application listing returned no JSON array: ${output.slice(0, 240)}`);
    throw new Error('container application listing had no JSON array; absence is unproved');
  }
  try {
    const apps = v.parse(ContainerAppListSchema, JSON.parse(output.slice(start)));
    return apps
      .filter((app): app is { id: string; name: string } =>
        app.id !== undefined && app.name !== undefined && names.includes(app.name))
      .map((app) => ({ id: app.id, name: app.name }));
  } catch (error) {
    log('container application listing did not match its schema');
    throw new Error('container application listing was invalid; absence is unproved', {
      cause: error,
    });
  }
}

export function deleteContainerApps(
  repoRoot: string,
  names: readonly string[],
  log: (message: string) => void,
): string[] {
  const found = containerAppIds(repoRoot, names, log);
  if (found.length === 0) return ['absent'];
  return found.map((app) => {
    const deleted = runWrangler(repoRoot, ['containers', 'delete', app.id], { allowFailure: true });
    if (deleted.startsWith(WRANGLER_FAILED)) {
      log(`WARNING: container application ${app.name} (${app.id}) was NOT deleted`);
      return `${app.name}: FAILED`;
    }
    return `${app.name}: deleted`;
  });
}

/**
 * Remove the fixture Worker, trying both routes.
 *
 * MEASURED: `delete --config` errored against /workers/services/kinu-r2-bench
 * and left the Worker live on workers.dev, while `delete --name` removed it on
 * the first try. A teardown with one route leaks whenever that route is the one
 * that breaks.
 */
export function deleteFixtureWorker(
  repoRoot: string,
  configPath: string,
  workerName: string,
  log: (message: string) => void,
): boolean {
  let deleted = runWrangler(repoRoot, ['delete', '--config', configPath, '--force'], { allowFailure: true });
  if (deleted.startsWith(WRANGLER_FAILED)) {
    log(`delete --config failed, falling back to --name: ${deleted.slice(0, 160)}`);
    deleted = runWrangler(repoRoot, ['delete', '--name', workerName, '--force'], { allowFailure: true });
  }
  if (deleted.startsWith(WRANGLER_FAILED)) {
    log(`WARNING: the fixture Worker was NOT deleted. Remove it by hand: ${deleted.slice(0, 300)}`);
    return false;
  }
  log('fixture Worker deleted');
  return true;
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

export function armSignalTeardown(log: (message: string) => void): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal} received; running teardown before exit`);
      void runTeardownOnce().finally(() => process.exit(130));
    });
  }
}

/**
 * Wait until the deployment accepts THIS run's token.
 *
 * MEASURED: a stable workers.dev hostname means an unauthenticated 401 proves
 * only that SOMETHING is answering — an older deployment 401s identically. A run
 * started on that evidence got 401 back on its own freshly minted token for every
 * arm and recorded failed creates that were nothing of the kind. So the
 * unauthenticated probe stays as a security assertion, and readiness is an
 * AUTHORIZED 200.
 */
export async function awaitTokenAccepted(
  origin: string,
  token: string,
  probePath: string,
  log: (message: string) => void,
  deadlineMs = 180_000,
): Promise<void> {
  const probe = async (headers?: Record<string, string>): Promise<number | 'unreachable'> => {
    const init: RequestInit = { signal: AbortSignal.timeout(15_000) };
    if (headers !== undefined) init.headers = headers;
    try {
      return (await fetch(`${origin}${probePath}`, init)).status;
    } catch (error) {
      // TOLERATED AND NAMED: a transport failure here is not a status and must
      // not be scored as one. During a cold deploy it means "not yet"; past the
      // deadline the caller reports the origin never came up. Recorded so a
      // persistent DNS or TLS fault is visible rather than looking like a slow
      // deploy.
      log(`readiness probe unreachable: ${describeThrown({ cause: error })}`);
      return 'unreachable';
    }
  };

  const unauth = await probe();
  if (unauth === 200) {
    throw new Error('the fixture answered an unauthenticated request; refusing to run');
  }

  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const authed = await probe({ authorization: `Bearer ${token}` });
    if (authed === 200) return;
    if (Date.now() > deadline) {
      throw new Error(
        `the deployment never accepted this run's token at ${origin} (last status ${authed}). `
        + 'A stable workers.dev hostname means an older deployment can answer here.',
      );
    }
    await delay(3_000);
  }
}
