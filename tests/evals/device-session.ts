/**
 * THE DEVICE PLANE, over the two surfaces the product itself uses.
 *
 * A linked machine is reached through two different authorities, and a harness
 * that blurs them measures neither:
 *
 *   THE CLI BEARER answers on `/api/cli/*` and nowhere else (cli/routes.ts:87).
 *     It is what `kinu connect` carries, so it registers the device and it reads
 *     the device list. `GET /api/cli/devices` is therefore the route the connect
 *     command's own success check goes through.
 *   THE BROWSER IDENTITY answers on `/api/user/*`. It is what Account settings →
 *     Devices acts with, so it grants a workspace's consent and revokes a
 *     machine. The CLI bearer cannot reach those routes at all, which is why
 *     `resolveWebIdentity` exists and why this module takes both.
 *
 * Everything here is the deployed HTTP surface plus the CLI's own connect
 * implementation. Nothing reimplements a spawn, a token exchange or a socket:
 * `connectDevice` in packages/cli/src/device-connect.ts is the one connect path
 * and the eval calls it.
 *
 * WHY THE LIST READ RETURNS A STATUS INSTEAD OF THROWING. The defect this arm
 * was built for is `GET /api/cli/devices` answering 500 — a UserDO whose
 * `user_devices` table predates the columns `listDevices` selects. A throw would
 * turn the deployment's own words into a stack trace in a harness frame; the
 * status and the body ARE the finding, so they are returned as data and the
 * eval asserts over them.
 */
import { existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as v from 'valibot';

import { parseJsonValue, parseRefusal } from '../../packages/core/src/index';
import { tolerate } from '../../packages/core/src/obs/index';
import { infraBoundary } from '@kinu.run/test-utils';
import { AGENT_HOME } from '../../packages/cli/src/config';
import { DAEMON_LOG_PATH, DEVICE_CONFIG_PATH } from '../../packages/cli/src/device-connect';
import {
  webHeaders,
  type PublicExecutorResult, type PublicSessionResolution, type PublicWebIdentity,
} from './public-session';

/** How much of a deployment's answer a finding carries. Enough to name the SQL
 *  error and the route that raised it, short enough to read in a test failure. */
const BODY_EXCERPT = 400;

/**
 * One device row, exactly as `UserDO.listDevices` declares it
 * (user/user-do.ts:2460-2464).
 *
 * THE FULL THIRTEEN, not the seven the CLI client needs. `listCloudDevices`
 * parses a narrower object and would pass over a route that lost half its
 * columns, and losing a column is the failure mode this arm exists to catch: the
 * production 500 is `SELECT`ing `unstopped_at` from a table created before it.
 * So the contract is asserted whole, and a missing field is a parse failure with
 * the body beside it.
 */
const DeviceRowSchema = v.object({
  id: v.string(),
  label: v.string(),
  os: v.nullable(v.string()),
  hostname: v.nullable(v.string()),
  connected: v.boolean(),
  createdAt: v.number(),
  lastSeenAt: v.nullable(v.number()),
  expiresAt: v.nullable(v.number()),
  lastIp: v.nullable(v.string()),
  lastAgent: v.nullable(v.string()),
  replacedAt: v.nullable(v.number()),
  revokedAt: v.nullable(v.number()),
  unstoppedAt: v.nullable(v.number()),
});
const DeviceListSchema = v.array(DeviceRowSchema);

export type DeviceRow = v.InferOutput<typeof DeviceRowSchema>;

/** What one read of the device list produced. `rows` is null whenever the
 *  deployment did not answer with the declared list — a 500, or a 200 whose
 *  shape lost a field — and `body` carries its own words either way. */
export interface DeviceListing {
  readonly status: number;
  readonly rows: readonly DeviceRow[] | null;
  readonly body: string;
}

/** The two authorities a device case acts with, resolved once by the plan. */
export interface DeviceAccount {
  readonly origin: string;
  /** The CLI bearer. Never logged, never placed in argv. */
  readonly cliToken: string;
  readonly identity: PublicWebIdentity;
}

/**
 * Refuse a run whose CLI home is the developer's own.
 *
 * `AGENT_HOME` is `kinuHome()` read at IMPORT time (cli/src/config.ts:45), so
 * nothing a test does afterwards can move it — the isolation is the runner's
 * (`scripts/test-preload-vitest.ts` for this tier, `bunfig.toml`'s preload for
 * `bun test`) and this asserts it rather than repeating it. Without the check a
 * dropped setup file would install a daemon into `~/.kinu`, connect the
 * developer's machine to the eval deployment, and overwrite the `device.json`
 * their real daemon holds.
 */
export function requireIsolatedAgentHome(home: string = AGENT_HOME): void {
  const resolved = resolve(home);
  const scratch = resolve(tmpdir());
  if (resolved === resolve(homedir(), '.kinu') || !resolved.startsWith(`${scratch}/`)) {
    throw new Error(
      `the device eval installs a daemon under KINU_HOME and this process resolved it to ${resolved}, `
      + `which is not a throwaway home under ${scratch}. The runner supplies one — vitest through `
      + '`setupFiles: [\'./scripts/test-preload-vitest.ts\']` in vitest.evals.config.ts, `bun test` '
      + 'through `preload` in bunfig.toml. Restore that entry rather than setting KINU_HOME here: '
      + 'AGENT_HOME is bound when packages/cli/src/config.ts is imported.',
    );
  }
}

/**
 * What the device arm does with a resolution: run, skip, or refuse.
 *
 * THE THIRD ANSWER IS THE POINT. On any backend but `cloud` this arm has no
 * subject — no deployment, no `/api/cli`, no machine to link — so it skips, and
 * the skip is declared in the lock. Under `cloud` a missing credential is a
 * FAILURE: `scripts/eval-tier.sh` already refuses that backend without one, so
 * an arm that skipped there would let `bun run evals:cloud` exit 0 having
 * measured nothing, which is the exact false green the tier was rebuilt to
 * remove.
 *
 * A decision rather than a branch inside the suite, because the suite is a
 * vitest file and `bun test` cannot import one — this is where the credential-
 * free tier can drive all three directions.
 */
export type DeviceArmGate =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly reason: string };

export function deviceArmGate(
  backend: string, resolution: PublicSessionResolution,
): DeviceArmGate {
  if (resolution.kind === 'ready') return { kind: 'run' };
  if (backend !== 'cloud') return { kind: 'skip', reason: resolution.remedy };
  return {
    kind: 'refuse',
    reason: 'the device arm ran under KINU_EVAL_BACKEND=cloud and resolved no plan. It needs BOTH '
      + 'of the deployment\'s authorities — the CLI bearer for /api/cli/devices and the browser '
      + 'identity for the consent and revoke routes — and a missing half is a failure here rather '
      + `than a skip, because the cloud backend refuses to start without a credential. ${resolution.remedy}`,
  };
}

/**
 * A deployment's answer, in one readable line.
 *
 * A Worker that THROWS never reaches its own error handler: the edge answers the
 * client with a Cloudflare error page, so the body a caller sees is four
 * kilobytes of HTML whose only fact is `Worker threw exception`. The exception
 * text — the SQL error that explains it — is in the Worker's log. So an error
 * page is reduced to its title and told where the cause lives, and any other
 * body is squeezed onto one line and clipped. A failure a reader cannot act on
 * is a failure they will re-derive by hand.
 */
export function summarizeRouteBody(body: string): string {
  const squeezed = body.replace(/\s+/g, ' ').trim();
  const title = /<title>([^<]+)<\/title>/i.exec(squeezed)?.[1]?.trim();
  if (title !== undefined) {
    return `${title} — the edge answered for a Worker that threw, so the cause is in the Worker `
      + 'log (`wrangler tail --env <deployment>`) and never in this body';
  }
  return squeezed.slice(0, BODY_EXCERPT);
}

/**
 * The device list as the CLI bearer reads it.
 *
 * The status and the body are returned rather than raised, for the reason this
 * module's header states. Only the TRANSPORT failing is an infrastructure
 * boundary: a deployment that answers is answering, whatever it says.
 *
 * The WHOLE body is parsed and only the summary is clipped. Parsing a clipped
 * body would report a long healthy list as malformed.
 */
export async function listDevicesOverCliRoute(account: DeviceAccount): Promise<DeviceListing> {
  return infraBoundary(`GET ${account.origin}/api/cli/devices`, async () => {
    const response = await fetch(`${account.origin}/api/cli/devices`, {
      headers: { authorization: `Bearer ${account.cliToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      return { status: response.status, rows: null, body: summarizeRouteBody(text) };
    }
    const parsed = v.safeParse(DeviceListSchema, tolerate(() => parseJsonValue(text), 'malformed-input'));
    return {
      status: response.status,
      rows: parsed.success ? parsed.output : null,
      body: parsed.success
        ? `${String(parsed.output.length)} device(s)`
        : `the list does not match the declared shape — ${v.flatten(parsed.issues).root?.join('; ')
          ?? [...new Set(parsed.issues.map((issue) => issue.message))].join('; ')} `
          + `— ${summarizeRouteBody(text)}`,
    };
  });
}

/**
 * Grant a workspace the full-machine tier on a device, through the route
 * Account settings → Devices uses (`user/routes.ts:244-257`).
 *
 * `full_filesystem` rather than the base grant because the subject is a SHELL
 * command: `deviceConsentScopeForMethod` requires the stronger tier for `exec`
 * and `checkpointRestore`, and the base tier would leave the command waiting on
 * a consent card nobody is there to answer.
 *
 * `agentName` is the workspace's own name. Consent is keyed on the PROVEN
 * workspace when the workspace asks (user-do.ts:1994-2015), so a grant under any
 * other name is a grant the device call will not find.
 */
export async function grantDeviceConsent(
  account: DeviceAccount, deviceId: string, agentName: string,
): Promise<void> {
  const url = `${account.origin}/api/user/devices/${encodeURIComponent(deviceId)}/consent`;
  await infraBoundary(`PUT ${url}`, async () => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...webHeaders(account.identity), 'content-type': 'application/json' },
      body: JSON.stringify({ agentName, scope: 'full_filesystem' }),
    });
    if (!response.ok) {
      throw new Error(`could not grant ${agentName} the full-filesystem tier on ${deviceId}: `
        + `${String(response.status)} ${response.statusText} `
        + `— ${(await response.text()).slice(0, BODY_EXCERPT)}`);
    }
  });
}

/** Revoke a device, through the route Account settings → Devices uses
 *  (`user/routes.ts:221-232`). Answers what the deployment said, so a teardown
 *  that ran against an already-revoked row is distinguishable from one that
 *  could not reach the account at all. */
export async function revokeDeviceOverUserRoute(
  account: DeviceAccount, deviceId: string,
): Promise<{ status: number; body: string }> {
  const url = `${account.origin}/api/user/devices/${encodeURIComponent(deviceId)}`;
  return infraBoundary(`DELETE ${url}`, async () => {
    const response = await fetch(url, { method: 'DELETE', headers: webHeaders(account.identity) });
    return { status: response.status, body: (await response.text()).slice(0, BODY_EXCERPT) };
  });
}

/**
 * What one command on the device plane actually did.
 *
 * THREE ANSWERS, and a case has to tell them apart. The orchestrator answers
 * `{error}` when the executor is absent or unavailable before any tool runs
 * (orchestrator.ts:4101-4102). The device tool itself answers a CLASSIFIED
 * refusal on the stdout channel — `{"reason":"unavailable","error":"No device
 * connected…"}` — which is what a revoked machine produces. Anything else is
 * output, and output is the only one that proves a round-trip.
 */
export type DeviceCommandVerdict =
  | { readonly kind: 'output'; readonly stdout: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly text: string };

export function readDeviceCommand(result: PublicExecutorResult): DeviceCommandVerdict {
  if (result.error !== undefined) {
    return { kind: 'refused', reason: 'executor_unavailable', text: result.error };
  }
  const stdout = result.stdout ?? '';
  const refusal = parseRefusal(stdout);
  if (refusal !== null) return { kind: 'refused', reason: refusal.reason, text: stdout };
  if ((result.exitCode ?? 0) !== 0) {
    return { kind: 'refused', reason: 'nonzero_exit', text: result.stderr ?? stdout };
  }
  return { kind: 'output', stdout };
}

/**
 * The steps one device case walks, declared as data.
 *
 * The list is the DENOMINATOR: a walk that stops at step two records the other
 * four as not reached rather than omitting them, so a partial run cannot read as
 * a shorter success. It lives here rather than in the arm because the runner-free
 * suite asserts over the same list, and `bun test` cannot import a vitest file.
 */
export const DEVICE_STEPS = [
  'devices-route', 'connect', 'listed', 'command', 'revoked', 'refused',
] as const;
export type DeviceStep = typeof DEVICE_STEPS[number];

/** One step's verdict: what was checked, and whether it held. */
export interface DeviceSubgoal {
  readonly what: DeviceStep;
  readonly reached: boolean;
  readonly detail: string;
}

/** Every step's verdict, with the ones the walk never got to named as such and
 *  attributed to the step that stopped it. */
export function completeSubgoals(
  observed: readonly DeviceSubgoal[],
): readonly DeviceSubgoal[] {
  const byStep: Partial<Record<DeviceStep, DeviceSubgoal>> = {};
  for (const subgoal of observed) byStep[subgoal.what] = subgoal;
  const stopped = observed.find((subgoal) => !subgoal.reached);
  return DEVICE_STEPS.map((what) => byStep[what] ?? {
    what,
    reached: false,
    detail: stopped === undefined
      ? 'not reached — the walk ended before this step'
      : `not reached — ${stopped.what} failed first`,
  });
}

/** One thing a case undoes, and what to call it when it fails. */
export interface TeardownStep {
  readonly what: string;
  run(): Promise<void> | void;
}

/**
 * Run every teardown step, in order, and report the ones that failed.
 *
 * EVERY STEP RUNS. A device case leaves four things behind — a live device row
 * on the account, a daemon process, a workspace, and a device credential in the
 * scratch home — and they are undone by four different authorities. A `finally`
 * that awaited them in sequence stopped at the first failure and stranded the
 * rest, which on this plane means a machine still linked to the deployment
 * because deleting a workspace answered 500.
 *
 * The failures are RETURNED rather than thrown: the case's own error is the one
 * a reader needs first, and a teardown that throws inside a `finally` replaces
 * it. The caller decides what to do with the list; it never disappears.
 */
export async function runTeardown(steps: readonly TeardownStep[]): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (caught) {
      failures.push(`${step.what}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return failures;
}

/**
 * Remove what this case wrote into the scratch home.
 *
 * The credential first, because it is the one file that still means something
 * once the process ends: `device.json` holds the device token the daemon
 * authenticates with. The home ITSELF is the runner's to remove — one throwaway
 * directory per test process, released by the `afterAll` in
 * `scripts/test-scratch-home.ts` — so deleting it here would pull it out from
 * under every other suite sharing the process.
 */
export function removeDeviceFiles(): void {
  for (const path of [DEVICE_CONFIG_PATH, DAEMON_LOG_PATH]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}
