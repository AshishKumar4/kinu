/**
 * THE DEVICE ARM'S WIRING, credential-free.
 *
 * Everything in the device family that is a property of the HARNESS rather than
 * of a deployment is checkable without one, and this is where it is checked. The
 * live arm links a real machine to a real deployment and costs minutes, so a
 * defect that can be caught here must not be discovered there.
 *
 * WHAT EACH GROUP GUARDS, stated because a test whose failure mode is unclear
 * gets deleted by the next person:
 *
 *   gating     the arm runs ONLY under `KINU_EVAL_BACKEND=cloud`, and under
 *              cloud a missing credential FAILS rather than skips. The second
 *              half is the one with teeth: a skip there would let
 *              `bun run evals:cloud` exit 0 having linked no machine at all.
 *   home       the daemon is installed under a throwaway `KINU_HOME`. The
 *              runner supplies it and `AGENT_HOME` binds at import, so the arm
 *              ASSERTS the isolation instead of setting it — a dropped setup
 *              file would otherwise put a daemon in the developer's own
 *              `~/.kinu` and overwrite the `device.json` their real one holds.
 *   teardown   four things are undone by four authorities, and every step runs
 *              even after one fails. A `finally` that stopped at the first
 *              failure left a machine LINKED to the deployment because deleting
 *              a workspace answered 500.
 *   reading    a refusal is told apart from output. If `{"reason":"unavailable"}`
 *              read as stdout, a revoked device would score as a round-trip and
 *              the last step of the live arm would pass on the product being
 *              broken.
 */
import { describe, expect, test } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { UNCONFIGURED_LLM } from '@kinu.run/test-utils';
import { AGENT_HOME } from '../../packages/cli/src/config';
import evalsConfig from '../../vitest.evals.config';
import { resolvePublicSessionPlan } from './public-session';
import {
  DEVICE_STEPS, completeSubgoals, deviceArmGate, grantDeviceConsent, listDevicesOverCliRoute,
  readDeviceCommand, requireIsolatedAgentHome, revokeDeviceOverUserRoute, runTeardown,
  summarizeRouteBody, type DeviceAccount, type DeviceSubgoal, type TeardownStep,
} from './device-session';

/** The suite name the gating probes resolve under. NOT the live arm's own name:
 *  `liveModelTarget` prints `[skip] <suite>` when it refuses, and a probe
 *  borrowing the real name would put a skip line for a suite this file does not
 *  run into every credential-free tier's log. */
const PROBE_SUITE = 'Device Gate Probe';
const STAGING = 'https://staging.kinu.run';

/** A resolution with no plan, as the arm sees one. The remedy text is the
 *  session resolver's; this file asserts what the ARM does with it. */
const UNAVAILABLE = { kind: 'unavailable', remedy: 'export KINU_EVAL_WEB_IDENTITY' } as const;

describe('the device arm runs on the cloud backend and nowhere else', () => {
  test('the default and the local backend both refuse, naming the invocation', () => {
    for (const env of [{}, { KINU_EVAL_BACKEND: 'local' }]) {
      const resolution = resolvePublicSessionPlan(PROBE_SUITE, '@cf/model', env);
      if (resolution.kind !== 'unavailable') {
        throw new Error('a non-cloud backend resolved a plan, so this arm could try to link a '
          + 'machine to a deployment that is not there');
      }
      expect(resolution.remedy).toContain('KINU_EVAL_BACKEND');
      expect(resolution.remedy).toContain('evals:cloud');
    }
  });

  test('a local backend SKIPS, and the skip carries the remedy', () => {
    const gate = deviceArmGate('local', UNAVAILABLE);
    expect(gate.kind).toBe('skip');
    expect(gate.kind === 'skip' ? gate.reason : '').toContain('KINU_EVAL_WEB_IDENTITY');
  });

  test('a cloud backend with a missing credential FAILS, and names which one', () => {
    // The teeth. `scripts/eval-tier.sh` refuses --backend cloud without a
    // credential, so an unresolved plan there is a broken environment rather
    // than a machine that cannot pay — and reporting it as a skip is how an arm
    // exits 0 having measured nothing.
    const gate = deviceArmGate('cloud', UNAVAILABLE);
    expect(gate.kind).toBe('refuse');
    const reason = gate.kind === 'refuse' ? gate.reason : '';
    // Both authorities named, because the arm needs both and "no plan" says
    // neither: the CLI bearer answers on /api/cli, the browser identity on the
    // consent and revoke routes.
    expect(reason).toContain('/api/cli/devices');
    expect(reason).toContain('browser identity');
    expect(reason).toContain('KINU_EVAL_WEB_IDENTITY');
  });

  test('a resolved plan runs, whatever the backend string says', () => {
    // The plan is only ever produced under cloud (`resolvePublicSessionPlan`
    // gate 1), so a ready resolution IS the cloud case and the gate does not
    // re-derive it. Built rather than asserted: `open` throws because the gate
    // reads `kind` and nothing else, and a stand-in that could open a session
    // would need a deployment.
    const gate = deviceArmGate('cloud', {
      kind: 'ready',
      plan: {
        describe: 'probe',
        llm: UNCONFIGURED_LLM,
        origin: STAGING,
        identity: { kind: 'secret', secret: 'probe' },
        open: () => { throw new Error('the gate never opens a session'); },
      },
    });
    expect(gate.kind).toBe('run');
  });
});

describe('the daemon is installed under a throwaway home, never the developer\'s', () => {
  test('this process resolved an isolated home at import time', () => {
    // The claim the live arm depends on, measured on the home the module ACTUALLY
    // bound — `AGENT_HOME` is `kinuHome()` read when packages/cli/src/config.ts
    // is imported, so nothing later can move it.
    expect(AGENT_HOME).toBe(resolve(process.env.KINU_HOME ?? ''));
    expect(AGENT_HOME.startsWith(`${resolve(tmpdir())}/`)).toBe(true);
    expect(AGENT_HOME).not.toBe(resolve(homedir(), '.kinu'));
    requireIsolatedAgentHome();
  });

  test('the developer\'s own home is refused, and so is anywhere outside the temp dir', () => {
    // Both directions: a check that fires on everything is as useless as one
    // that fires on nothing.
    expect(() => requireIsolatedAgentHome(join(homedir(), '.kinu'))).toThrow(/throwaway home/);
    expect(() => requireIsolatedAgentHome('/opt/kinu')).toThrow(/throwaway home/);
    requireIsolatedAgentHome(join(tmpdir(), 'kinu-test-home-probe'));
  });

  test('the eval tier still loads the setup file that supplies that home', () => {
    // The structural half. The isolation is the RUNNER's: drop this entry and
    // every `*.eval.ts` process falls back to `~/.kinu`, where this arm would
    // install a daemon and overwrite a live device credential.
    expect(evalsConfig.test?.setupFiles).toContain('./scripts/test-preload-vitest.ts');
  });
});

describe('teardown undoes everything, in order, even after a failure', () => {
  test('a failing step does not strand the ones after it', async () => {
    const ran: string[] = [];
    const step = (what: string, fail = false): TeardownStep => ({
      what,
      run: () => {
        ran.push(what);
        if (fail) throw new Error(`${what} answered 500`);
      },
    });

    const failures = await runTeardown([
      step('revoke the device'),
      step('stop the session daemon', true),
      step('delete the workspace'),
      step('remove the device credential'),
    ]);

    // ORDER, because the device row is undone first: it is the only thing here
    // that outlives the process, and a machine left linked to the account is
    // reachable by a workspace nobody is watching.
    expect(ran).toEqual([
      'revoke the device', 'stop the session daemon', 'delete the workspace',
      'remove the device credential',
    ]);
    // And the failure is REPORTED rather than thrown: a throw inside the case's
    // `finally` would replace the case's own error, which is the one a reader
    // needs first.
    expect(failures).toEqual(['stop the session daemon: stop the session daemon answered 500']);
  });

  test('a clean teardown reports nothing', async () => {
    expect(await runTeardown([{ what: 'revoke the device', run: () => undefined }])).toEqual([]);
  });
});

describe('a refusal is not output', () => {
  test('a classified payload on the stdout channel reads as a refusal', () => {
    // What a revoked or unattached machine answers — `refusalText` in
    // core/src/execution/exec-result.ts, read back through core's own parser.
    const refusal = JSON.stringify({ reason: 'unavailable', error: 'No device connected.' });
    expect(readDeviceCommand({ stdout: refusal, exitCode: 0 })).toEqual({
      kind: 'refused', reason: 'unavailable', text: refusal,
    });
  });

  test('the orchestrator\'s own error reads as a refusal before any tool ran', () => {
    // `executeInExecutor` answers this when the executor is absent or
    // unavailable (orchestrator.ts:4101-4102), and it carries no class of its
    // own — so the reader supplies one rather than dropping the answer.
    expect(readDeviceCommand({ error: 'Executor "laptop" is not available' })).toEqual({
      kind: 'refused', reason: 'executor_unavailable', text: 'Executor "laptop" is not available',
    });
  });

  test('real output reads as output, and a non-zero exit does not', () => {
    expect(readDeviceCommand({ stdout: 'KINU_DEVICE_ROUNDTRIP_OK\n', exitCode: 0 }))
      .toEqual({ kind: 'output', stdout: 'KINU_DEVICE_ROUNDTRIP_OK\n' });
    expect(readDeviceCommand({ stdout: '', stderr: 'no such file', exitCode: 127 }).kind)
      .toBe('refused');
  });
});

describe('a failed route says something a reader can act on', () => {
  test('an edge error page is reduced to its title and points at the Worker log', () => {
    // Measured against staging on 2026-09-01: `GET /api/cli/devices` answered
    // 500 and the body was this page. Four kilobytes of markup whose only fact
    // is that the Worker threw — the SQL error behind it (`no such column:
    // last_ip at offset 85: SQLITE_ERROR`) reached the Worker log alone.
    const page = '<!DOCTYPE html>\n<html>\n<head>\n'
      + '<title>Worker threw exception | staging.kinu.run | Cloudflare</title>\n'
      + '</head><body>error code: 1101</body></html>';
    const summary = summarizeRouteBody(page);
    expect(summary).toContain('Worker threw exception | staging.kinu.run | Cloudflare');
    expect(summary).toContain('wrangler tail');
    expect(summary).not.toContain('<html');
  });

  test('a plain body is squeezed onto one line and kept', () => {
    expect(summarizeRouteBody('{\n  "error":\n "Agent x not found"\n}'))
      .toBe('{ "error": "Agent x not found" }');
  });
});

describe('a partial walk reports every step it declared', () => {
  test('the steps it never reached are named, and attributed to the one that failed', () => {
    const observed: DeviceSubgoal[] = [
      { what: 'devices-route', reached: true, detail: 'GET /api/cli/devices → 200' },
      { what: 'connect', reached: false, detail: 'connectDevice → timeout' },
    ];
    const complete = completeSubgoals(observed);

    // The denominator is the declared list, so a run that stopped at step two
    // cannot read as a two-step success.
    expect(complete.map((subgoal) => subgoal.what)).toEqual([...DEVICE_STEPS]);
    expect(complete.filter((subgoal) => subgoal.reached)).toHaveLength(1);
    for (const subgoal of complete.slice(2)) {
      expect(subgoal.detail).toBe('not reached — connect failed first');
    }
  });

  test('a complete walk is returned unchanged', () => {
    const observed: DeviceSubgoal[] = DEVICE_STEPS.map((what) => ({
      what, reached: true, detail: 'ok',
    }));
    expect(completeSubgoals(observed)).toEqual(observed);
  });
});

/**
 * WHAT THE CLIENT SENDS, over a server that records it.
 *
 * Not a stand-in for the deployment: the live arm is the only thing that says
 * what a deployment does. This is the other half — that the requests this module
 * makes are the ones the product's own surfaces answer — and it is the half no
 * live run could reach on 2026-09-01, because `GET /api/cli/devices` answered
 * 500 on both deployed builds and the walk stopped at step one. A route typed
 * wrong here would be discovered only after the schema fix ships, by another
 * red run.
 *
 * The declared-shape case is the CONTRACT: `UserDO.listDevices` returns thirteen
 * fields and the CLI client parses seven, so a route that lost `unstoppedAt`
 * would satisfy the shipped client and fail here, which is the direction that
 * matters.
 */
describe('the client speaks the routes the product\'s own surfaces speak', () => {
  const DEVICE_ROW = {
    id: 'dev-abc123', label: 'user@box', os: 'linux', hostname: 'box', connected: true,
    createdAt: 1, lastSeenAt: 2, expiresAt: 3, lastIp: '203.0.113.1', lastAgent: 'kinu-pc-agent',
    replacedAt: null, revokedAt: null, unstoppedAt: null,
  };

  interface Recorded {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
    readonly identity: string | null;
    readonly body: string;
  }

  /** A server that records what it was asked and answers what it was told to. */
  async function withServer(
    answer: (request: Request) => Response,
    drive: (account: DeviceAccount, seen: Recorded[]) => Promise<void>,
  ): Promise<Recorded[]> {
    const seen: Recorded[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
          identity: request.headers.get('x-kinu-dev-identity'),
          body: await request.text(),
        });
        return answer(request);
      },
    });
    try {
      await drive({
        origin: `http://127.0.0.1:${String(server.port)}`,
        cliToken: 'ptc_probe',
        identity: { kind: 'secret', secret: 'probe-identity' },
      }, seen);
    } finally {
      await server.stop(true);
    }
    return seen;
  }

  test('the device list is read with the CLI bearer and parsed whole', async () => {
    const seen = await withServer(
      () => Response.json([DEVICE_ROW]),
      async (account) => {
        const listing = await listDevicesOverCliRoute(account);
        expect(listing.status).toBe(200);
        expect(listing.rows).toEqual([DEVICE_ROW]);
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.path).toBe('/api/cli/devices');
    // The CLI bearer, because `/api/cli/*` is the only surface it answers on.
    expect(seen[0]?.authorization).toBe('Bearer ptc_probe');
  });

  test('a row missing one of the declared columns is not a device list', async () => {
    const { unstoppedAt: _dropped, ...older } = DEVICE_ROW;
    await withServer(
      () => Response.json([older]),
      async (account) => {
        const listing = await listDevicesOverCliRoute(account);
        expect(listing.status).toBe(200);
        expect(listing.rows).toBeNull();
        expect(listing.body).toContain('dev-abc123');
      },
    );
  });

  test('the grant drives the card flow, and never the route the product deleted', async () => {
    // This test used to assert a single `PUT /api/user/devices/:id/consent`
    // carrying the browser identity. That route does not exist: `b2ceb2e7c`
    // deleted it, and `user/routes.ts` now serves only `GET /devices/consents`
    // and `DELETE /devices/:id/consent`. The old assertions passed anyway,
    // because this fake answers 200 to anything — green over a route the
    // product had dropped. So the pin is now the flow an owner really performs:
    // one harmless `laptop` call raises the card, the workspace's own pending
    // list is read, and the card is answered `always` through the RPC its
    // button calls. All three go through `/api/cli` under the bearer, because
    // consent is keyed on the PROVEN workspace when the workspace asks.
    //
    // The answers are ordered rather than dispatched on the body, because the
    // fake's handler is synchronous and a request body is not: the ORDER is
    // itself part of the contract this test pins, and a fourth call — a retry
    // this flow should not need — answers 500 so it fails rather than repeats.
    const scripted = [
      Response.json({ result: { stdout: 'ok' } }),
      Response.json({ result: [{ consentId: 'consent-1' }] }),
      Response.json({ result: { ok: true } }),
    ];
    let served = 0;
    const seen = await withServer(
      () => scripted[served++] ?? new Response('the flow asked for a fourth call', { status: 500 }),
      (account) => grantDeviceConsent(account, 'dev-abc123', 'eval-device-ws'),
    );
    expect(seen).toHaveLength(3);
    expect(seen.map((entry) => entry.body ?? '')).toEqual([
      expect.stringContaining('executeInExecutor'),
      expect.stringContaining('listPendingConsents'),
      expect.stringContaining('resolveDeviceConsent'),
    ]);
    // Every call is the workspace's own plane under its bearer, and the deleted
    // account route must not come back — a request to it would be the regression.
    for (const entry of seen) {
      expect(entry.method).toBe('POST');
      expect(entry.path).toBe('/api/cli/workspaces/eval-device-ws/rpc');
      expect(entry.authorization).not.toBeNull();
      expect(entry.path.endsWith('/consent')).toBe(false);
    }
    // Only `always` is remembered, so only `always` grants the machine.
    expect(seen[2]?.body ?? '').toContain('"always"');
  });

  test('a refused consent grant carries the deployment\'s own words', async () => {
    await withServer(
      () => new Response('consent scope not updated', { status: 400 }),
      async (account) => {
        await expect(grantDeviceConsent(account, 'dev-abc123', 'ws'))
          .rejects.toThrow(/consent scope not updated/);
      },
    );
  });

  test('the revoke is a DELETE on the account route, and answers what it was told', async () => {
    const seen = await withServer(
      () => Response.json({ ok: true, unstoppedCommands: 0 }),
      async (account) => {
        expect((await revokeDeviceOverUserRoute(account, 'dev-abc123')).status).toBe(200);
      },
    );
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.path).toBe('/api/user/devices/dev-abc123');
    expect(seen[0]?.identity).toBe('probe-identity');
  });
});
