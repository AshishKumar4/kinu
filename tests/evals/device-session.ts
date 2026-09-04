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
  // This helper is now the FIRST-CALL route a case can use to reach a machine it
  // owns: make one `laptop` call with a harmless `true`, let the deployment raise
  // the real consent card for that workspace, and answer it `always` through the
  // RPC the card's own button calls. See `grantDeviceAccess` for the work.
  await grantDeviceAccess(account, deviceId, agentName);
}

/**
 * Bind a workspace to a machine, by driving the consent flow the product runs.
 *
 * There is deliberately no PUT /devices/:id/consent any more (b2ceb2e7c): a
 * binding is created by the FIRST device call a workspace makes, which raises
 * the card on the workspace, and only `always` is remembered — so the way an
 * owner grants a machine is the same whether it is a person clicking or this
 * harness resolving. The harness makes one harmless call to raise the card,
 * reads it off the workspace's own pending list, and resolves it.
 *
 * The card answers `always` by binding (workspace, device) with `allow` on the
 * hub, which is exactly the row an owner's click writes. The call that raised
 * the card then settles itself.
 */
export async function grantDeviceAccess(
  account: DeviceAccount, deviceId: string, agentName: string,
): Promise<void> {
  // ONE call that raises the card, retried past the transport's warm-up.
  //
  // The workspace's device transport serves a TTL-cached snapshot and its
  // authoritative refresh runs at TURN start (actor-agent.ts) — so a freshly
  // created workspace answers the very first `executeInExecutor('laptop', …)`
  // with "not available" while the kick its own status() read started is still
  // in flight. A person sees this once and their next click works; this harness
  // waits it out rather than concluding the machine is unreachable.
  const rpcUrl = `${account.origin}/api/cli/workspaces/${encodeURIComponent(agentName)}/rpc`;
  const raiseOnce = (): Promise<{ ok: boolean; detail: string }> => infraBoundary(
    `POST ${rpcUrl} (device consent raise)`,
    async () => {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${account.cliToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'executeInExecutor', args: ['laptop', 'true'] }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`raising the device consent card on ${agentName} failed: `
          + `${String(response.status)} ${response.statusText} — ${text.slice(0, BODY_EXCERPT)}`);
      }
      const answer = v.parse(v.object({ result: v.object({
        error: v.optional(v.string()),
        stdout: v.optional(v.string()),
      }) }), JSON.parse(text)).result;
      const detail = answer.error ?? answer.stdout ?? '';
      return { ok: answer.error === undefined, detail };
    },
  );
  // The raise BLOCKS on the card: `awaitDeviceConsent` parks the workspace's
  // call until somebody answers or the registry's five-minute window closes, so
  // awaiting it here would deadlock the very card this function is trying to
  // read. The raise — with its warm-up retries — therefore runs DETACHED, the
  // card is polled for below, and settling it is what unblocks the raise.
  //
  // IT RETURNS ITS FAILURE RATHER THAN REJECTING. A detached promise that
  // rejects while the poller is still ahead of the join is an UNOBSERVED
  // rejection, and the runtime reports that as a failure of whatever test
  // happens to be running — which is how a deployment answering 400 to
  // everything read as an uncaught error instead of as the refusal it was. The
  // failure is a value, joined below, so it surfaces exactly once and in the
  // caller's own frame.
  const raising = (async (): Promise<Error | null> => {
    try {
      let raised = await raiseOnce();
      for (let attempt = 0; attempt < 12 && !raised.ok; attempt += 1) {
        if (!/not available|no device connected/i.test(raised.detail)) break;
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 1_000);
        await tick.promise;
        raised = await raiseOnce();
      }
      if (!raised.ok && !/queued|approval|denied/i.test(raised.detail)) {
        return new Error(`the laptop executor never became reachable for ${agentName}: `
          + `${raised.detail}`);
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  })();

  // The card, off the workspace's pending list, and answered. The raise is
  // racing in the background and has a warm-up of its own, so absence is
  // retried rather than read as "never raised".
  const listUrl = rpcUrl;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = await infraBoundary(`POST ${rpcUrl} (listPendingConsents)`, async () => {
      const response = await fetch(listUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${account.cliToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'listPendingConsents', args: [] }),
      });
      // The body is read BEFORE the verdict, because a refusal's words are the
      // whole value of the refusal: this read answered `400 Bad Request` and
      // dropped what the deployment actually said, so a scope the route would
      // not accept was indistinguishable from a route that had moved.
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`could not list the pending consents on ${agentName}: `
          + `${String(response.status)} ${response.statusText} — ${text.slice(0, BODY_EXCERPT)}`);
      }
      // The generic RPC route wraps every answer as { result: … } — the same
      // envelope `callHttp` unwraps in the shipped client. Parsed HERE rather
      // than trusted, so a route that changes its envelope is a parse failure
      // rather than a card that reads as absent.
      const envelope = v.parse(v.object({ result: v.array(v.object({ consentId: v.string() })) }),
        JSON.parse(text));
      return envelope.result;
    });
    const card = found.find((entry) => entry.consentId.length > 0) ?? null;
    if (card === null) {
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 500);
      await tick.promise;
      continue;
    }
    await infraBoundary(`POST ${rpcUrl} (resolveDeviceConsent)`, async () => {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${account.cliToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          method: 'resolveDeviceConsent',
          args: [card.consentId, 'always'],
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`answering the device consent card ${card.consentId} failed: `
          + `${String(response.status)} ${response.statusText} — ${text.slice(0, BODY_EXCERPT)}`);
      }
      // The answer's own words, kept whole: `resolve` answers false for an id it
      // no longer holds — already settled, or raced with the window closing —
      // and that is a fact the caller needs, not a parse error. Both the
      // envelope the route wraps in and a bare {ok} are accepted, so a shape
      // change on either side reads as a finding about the deployment rather
      // than as a ValiError three frames from the fact.
      const answer = v.parse(v.union([
        v.object({ result: v.object({ ok: v.boolean() }) }),
        v.object({ ok: v.boolean() }),
      ]), JSON.parse(text));
      const decidedOk = 'result' in answer ? answer.result.ok : answer.ok;
      if (!decidedOk) {
        throw new Error(`the workspace did not record the decision on ${card.consentId} `
          + '— the card was already settled');
      }
    });
    // Settling the card is what unblocks the detached raise; its own verdict
    // (the `true` that finally ran, or the words it answered) is awaited here so
    // a raise that failed for a real reason still fails this grant.
    const raiseFailure = await raising;
    if (raiseFailure) throw raiseFailure;
    return;
  }
  // No card within the budget. The raise may still be parked on a card this
  // poller could not see, so it is raced against a short grace rather than
  // abandoned — but its failure is not this function's finding either way: the
  // finding is that no card was ever raised.
  const lateFailure = await Promise.race([
    raising,
    new Promise<Error | null>((resolve) => { setTimeout(() => { resolve(null); }, 5_000); }),
  ]);
  // The raise's own words when it has any: a deployment that refused the very
  // first call said WHY, and reporting "no card was raised" over that would
  // hide the refusal behind a symptom of it.
  if (lateFailure) throw lateFailure;
  throw new Error(`no device consent card was ever raised on ${agentName} for ${deviceId}`);
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
