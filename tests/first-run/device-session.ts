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
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';

import { parseJsonValue, type JsonValue, type RunEvent } from '../../packages/core/src/index';
import { tolerate } from '../../packages/core/src/obs/index';
import { infraBoundary } from '@kinu.run/test-utils';
import { AGENT_HOME } from '../../packages/cli/src/config';
import { DAEMON_LOG_PATH, DEVICE_CONFIG_PATH } from '../../packages/cli/src/device-connect';
import { DEVICE_KEY_FILE } from '../../packages/core/src/execution/device-key';
import { ExecutorCommandSchema, type KinuPublicSession, type PublicExecutorResult, type PublicSessionResolution } from '../../evals/src/session';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import type { PublicSocket } from './public-socket';

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
      + '`setupFiles: [\'./scripts/test-preload-vitest.ts\']` in vitest.first-run.config.ts, `bun test` '
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
 * FAILURE: the tier already refuses that backend without one, so an arm that
 * skipped there would let the tier exit 0 having measured nothing, which is the
 * exact false green the tier was rebuilt to remove.
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
  account: DeviceAccount, deviceId: string, agentName: string, deviceName?: string,
): Promise<void> {
  // This helper is now the FIRST-CALL route a case can use to reach a machine it
  // owns: make one `device` call with a harmless `true`, let the deployment raise
  // the real consent card for that workspace, and answer it `always` through the
  // RPC the card's own button calls. See `grantDeviceAccess` for the work.
  await grantDeviceAccess(account, deviceId, agentName, deviceName);
}

/** One wait on the deployment's warm-up, the only clock this harness keeps. */
function pause(ms: number): Promise<void> {
  const tick = Promise.withResolvers<void>();
  setTimeout(tick.resolve, ms);

  return tick.promise;
}

/** The words a device call answers while its consent waits on the owner (`deviceConsentQueued`): NOT RUN, parked. */
export const CONSENT_PARKED = /NOT RUN: using .* waits on the owner's consent/;

/** The cause the run an owner's consent answer opens is stamped with (device-consent.ts `DEVICE_CONSENT_SIGNAL`). */
const CONSENT_WAKE = 'device_consent';

/**
 * Whether the run an owner's consent answer woke has ended, which is when the call that answer let through has been
 * re-issued and its result is in the ledger. The wake opens that run once the answer lands, so the ledger is read again
 * at each turn `room` sees close, from `closed`, the room's wait registered before the answer; the run, once there, is
 * followed to its end. Waited on, never sent into: a send would land in that run and be the ask it answers. False when
 * the room or the case budget ends first.
 */
export async function consentWakeEnded(
  session: Pick<KinuPublicSession, 'runEvents' | 'followRun'>, room: PublicSocket, closed: Promise<boolean>,
): Promise<boolean> {
  let next = closed;

  for (;;) {
    const events = await session.runEvents();
    const woken = events.find((event) => event.type === 'run_start' && event.caused_by === CONSENT_WAKE)?.runId;

    if (woken !== undefined) return await runEnded(session, woken, events);

    if (!(await next)) return false;
    next = room.turnClosed();
  }
}

/** Whether `runId` reached its `run_end`: in `events` already, or on its own stream from the last of them. */
async function runEnded(session: Pick<KinuPublicSession, 'followRun'>, runId: string, events: readonly RunEvent[]): Promise<boolean> {
  const own = events.filter((event) => event.runId === runId);

  if (own.some((event) => event.type === 'run_end')) return true;

  for await (const event of session.followRun(runId, Math.max(...own.map((seen) => seen.eventIndex)))) {
    if (event.type === 'run_end') return true;
  }

  return false;
}

/**
 * Bind a workspace to a machine, by driving the consent flow the product runs.
 *
 * There is deliberately no PUT /devices/:id/consent (7148add5a): a
 * binding is created by the FIRST device call a workspace makes, which parks
 * on a card the workspace raises, and only `always` is remembered — so the way
 * an owner grants a machine is the same whether it is a person clicking or this
 * harness resolving. The flow is the park-and-wake contract, in order: one
 * harmless call parks NOT RUN on the card, the card is read off the
 * workspace's own pending list and answered `always`, and the call is
 * re-issued, as the agent the answer wakes re-issues it: that re-issue spends
 * the answer and records the binding, the row an owner's click leads to.
 */
export async function grantDeviceAccess(
  account: DeviceAccount, deviceId: string, agentName: string, deviceName?: string,
): Promise<void> {
  // The call names its machine when the caller knows it
  // (docs/EXECUTION-LAYER-SPEC.md "The user's account is a fleet"): with
  // several live, an unnamed call is refused with the fleet ask and raises no
  // card, so a grant for the second machine can never mint one unnamed.
  const rpcUrl = `${account.origin}/api/cli/workspaces/${encodeURIComponent(agentName)}/rpc`;

  const call = (method: string, args: readonly JsonValue[]): Promise<string> => infraBoundary(`POST ${rpcUrl} (${method})`, async () => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.cliToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    });

    // The body is read BEFORE the verdict, because a refusal's words are the
    // whole value of the refusal: a scope the route would not accept must not
    // read as a route that had moved.
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${method} on ${agentName} failed: ${String(response.status)} ${response.statusText} — ${text.slice(0, BODY_EXCERPT)}`);
    }

    return text;
  });

  // Read as every device case reads a command: a refusal or a nonzero exit is not a run, whatever stdout says.
  const deviceCall = async (): Promise<{ ok: boolean; detail: string }> => {
    const answer = readDeviceCommand(v.parse(v.object({ result: ExecutorCommandSchema }),
      JSON.parse(await call('executeInExecutor', deviceName === undefined ? ['device', 'true'] : ['device', 'true', deviceName]))).result);

    return answer.kind === 'output' ? { ok: true, detail: answer.stdout } : { ok: false, detail: answer.text };
  };

  // The workspace's device transport serves a TTL-cached snapshot and its
  // authoritative refresh runs at TURN start (actor-agent.ts) — so a freshly
  // created workspace answers the very first `executeInExecutor('device', …)`
  // with "not available" while the kick its own status() read started is still
  // in flight. Warm-up wears two shapes: the transport's ("not available", "no
  // device connected") arrives as an error, the fleet's ("not known here yet",
  // "no connected machine is named") as a stdout refusal — so the loop retries
  // on the WORDS, not on the envelope.
  const warmup = /not available|no device connected|not known here yet|no connected machine is named/i;
  let raised = await deviceCall();

  for (let attempt = 0; attempt < 12 && warmup.test(raised.detail); attempt += 1) {
    await pause(1_000);
    raised = await deviceCall();
  }

  // Bound already: the call ran, and there is nothing to grant.
  if (raised.ok) return;

  if (!CONSENT_PARKED.test(raised.detail)) {
    throw new Error(`the device call on ${agentName} did not park on a consent card: ${raised.detail}`);
  }

  const PendingSchema = v.object({ result: v.array(v.object({ consentId: v.string(), deviceId: v.string() })) });
  const card = v.parse(PendingSchema, JSON.parse(await call('listPendingConsents', []))).result.find((pending) => pending.deviceId === deviceId);

  if (card === undefined) throw new Error(`the parked device call raised no consent card on ${agentName} for ${deviceId}`);

  // `resolve` answers false for an id it no longer holds; both the envelope the
  // route wraps in and a bare {ok} are accepted, so a shape change on either
  // side reads as a finding about the deployment rather than a parse error.
  const decided = v.parse(v.union([v.object({ result: v.object({ ok: v.boolean() }) }), v.object({ ok: v.boolean() })]),
    JSON.parse(await call('resolveDeviceConsent', [card.consentId, 'always'])));

  if (!('result' in decided ? decided.result.ok : decided.ok)) {
    throw new Error(`the workspace did not record the decision on ${card.consentId} — the card was already settled`);
  }

  // The re-issue the answer's wake asks for: it spends the answer and records the binding.
  const reissued = await deviceCall();

  if (!reissued.ok) throw new Error(`the re-issued device call on ${agentName} did not run on the owner's always: ${reissued.detail}`);
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

/** Read the executor's declared status channels; stdout is always command data. */
export type DeviceCommandVerdict =
  | { readonly kind: 'output'; readonly stdout: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly text: string };

export function readDeviceCommand(result: PublicExecutorResult): DeviceCommandVerdict {
  if (result.refusal !== undefined) return { kind: 'refused', reason: result.refusal.reason, text: result.refusal.error };

  if (result.error !== undefined) return { kind: 'refused', reason: 'unclassified', text: result.error };
  const stdout = result.stdout ?? '';

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
 * once the process ends: `device.key` holds the private key the daemon signs
 * its connects with. The home ITSELF is the runner's to remove — one throwaway
 * directory per test process, released by the `afterAll` in
 * `scripts/test-scratch-home.ts` — so deleting it here would pull it out from
 * under every other suite sharing the process.
 */
export function removeDeviceFiles(): void {
  for (const path of [join(dirname(DEVICE_CONFIG_PATH), DEVICE_KEY_FILE), DEVICE_CONFIG_PATH, DAEMON_LOG_PATH]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}
