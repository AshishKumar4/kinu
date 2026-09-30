/**
 * The deployment plumbing every ephemeral devbox benchmark needs, owned once.
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
import { deleteApplicationByRest, deletedByRest } from '../../cloudflare-rest';

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
  setTimeout(() => settle.resolve(), ms);
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

const EXPLICIT_ABSENCE = /(?:not found|could not find|already deleted|does not exist|script_not_found|code:\s*100(?:07|21))/i;

/** A successful deletion or an explicit not-found response proves absence.
 * Authentication, account-selection, transport and server failures do not. */
export function wranglerProvesAbsence(output: string): boolean {
  return !output.startsWith(WRANGLER_FAILED) || EXPLICIT_ABSENCE.test(output);
}

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
    if (deletedByRest(app.id)) {
      const deleted = deleteApplicationByRest(accountId(repoRoot), app.id);

      if (!deleted.ok) {
        log(`WARNING: container application ${app.name} (${app.id}) was NOT deleted: ${deleted.reason}`);

        return `${app.name}: FAILED`;
      }

      return `${app.name}: absent`;
    }

    const deleted = runWrangler(repoRoot, ['containers', 'delete', app.id], { allowFailure: true });

    if (!wranglerProvesAbsence(deleted)) {
      log(`WARNING: container application ${app.name} (${app.id}) was NOT deleted`);

      return `${app.name}: FAILED`;
    }

    return `${app.name}: absent`;
  });
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

