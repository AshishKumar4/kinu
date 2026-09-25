// The stub origin serves poison at the retired /pc/daemon.js route, so a connect that fetches
// executable bytes shows up as poison on disk.
import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { join, resolve } from 'node:path';
import type { Server, Subprocess } from 'bun';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  DEVICE_SANDBOX_CAPABILITIES,
  DEVICE_SANDBOX_REASONS,
  parseJsonObject,
  sandboxReasonFix,
  type DeviceSandboxReason,
  type JsonObject,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { listCloudDevices, type CloudDevice } from '../src/cloud-api';
import { describeDeviceSandbox } from '../src/device-connect';
import { CloudAgentClient } from '../src/cloud-agent-client';
import * as v from 'valibot';
import DAEMON_SOURCE from '../../pc-agent/src/index.js' with { type: 'text' };
import SANDBOX_SOURCE from '../../pc-agent/src/sandbox.js' with { type: 'text' };
import PTY_SOURCE from '../../pc-agent/src/pty.js' with { type: 'text' };
import UPDATE_SOURCE from '../../pc-agent/src/update.js' with { type: 'text' };
import { daemonArchive, releaseSigningEnv, startUpdateHub, until, type UpdateHub } from './helpers/update-hub';

const repoRoot = resolve(__dirname, '../../..');

/** What the daemon requires beside itself, as this repo ships it: the installer must land each one, byte for byte. */
const DAEMON_SIBLINGS = { 'sandbox.js': SANDBOX_SOURCE, 'pty.js': PTY_SOURCE, 'update.js': UPDATE_SOURCE } as const;

function newProjectDir(): string {
  const dir = scratchDir('test-project');

  return dir;
}

const sleepers: Subprocess[] = [];

const deviceDaemonPids: number[] = [];

const stubs: Server<unknown>[] = [];

const updateHubs: UpdateHub[] = [];

afterEach(async () => {
  for (const pid of deviceDaemonPids.splice(0)) tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');

  for (const proc of sleepers.splice(0)) proc.kill();

  await Promise.all(stubs.splice(0).map((server) => server.stop(true)));
  await Promise.all(updateHubs.splice(0).map((hub) => hub.close()));
});

interface StubCloud {
  origin: string;
  hits: { register: number; list: number; daemonScript: number; ticket: number };
}

interface StubCloudOptions {
  /** Typed as the wire, not `CloudDevice`, so a case can serve an older hub's row. */
  devices?: () => unknown[];
  registerGate?: { release: Promise<void>; onArrival?: () => void };
  registrationFailure?: { status: number; error: string };
  onRegister?: (body: { label?: string; replaces?: string }) => void;
  /** Ticket-exchange statuses in order, last repeating; 401 makes the daemon exit, 404 retries. */
  ticketStatuses?: readonly number[];
}

const POISON_MARKER = 'poisoned-daemon-ran';

/** A compromised origin's /pc/daemon.js: it parses and passes the retired marker check. */
const POISON_DAEMON = [
  '// /pc/connect-ticket',
  "const cancel = 'execCancel';",
  "const rotate = 'ROTATE';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  `fs.writeFileSync(path.join(process.env.KINU_HOME, '${POISON_MARKER}'), 'ran');`,
  'setInterval(() => {}, 1000);',
].join('\n');

function startStubCloud(opts: StubCloudOptions = {}): StubCloud {
  const hits = { register: 0, list: 0, daemonScript: 0, ticket: 0 };

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === '/api/cli/devices' && req.method === 'POST') {
        hits.register += 1;
        const body = v.safeParse(v.object({ label: v.optional(v.string()), replaces: v.optional(v.string()) }), await req.json());
        opts.onRegister?.(body.success ? body.output : {});

        if (opts.registerGate) {
          opts.registerGate.onArrival?.();
          await opts.registerGate.release;
        }

        if (opts.registrationFailure) {
          return Response.json({ error: opts.registrationFailure.error }, { status: opts.registrationFailure.status });
        }

        return Response.json({
          deviceId: 'dev_1',
          token: 'device-token',
          userId: 'user_1',
          origin: `http://localhost:${server.port}`,
        });
      }

      if (url.pathname === '/api/cli/devices' && req.method === 'GET') {
        hits.list += 1;

        return Response.json(opts.devices?.() ?? []);
      }

      if (url.pathname === '/pc/connect-ticket' && opts.ticketStatuses !== undefined) {
        const status = opts.ticketStatuses[Math.min(hits.ticket, opts.ticketStatuses.length - 1)];
        hits.ticket += 1;

        return Response.json({ error: 'refused by the stub' }, { status });
      }

      if (url.pathname === '/pc/daemon.js') {
        hits.daemonScript += 1;

        return new Response(POISON_DAEMON, { headers: { 'content-type': 'text/javascript' } });
      }

      return new Response('not found', { status: 404 });
    },
  });

  stubs.push(server);

  return { origin: `http://localhost:${server.port}`, hits };
}

function makeHome(config: JsonObject): string {
  const home = scratchDir('device');
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return home;
}

async function runScript(home: string, script: string, environment: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    // Fence the real daemon's in-flight root inside the test home.
    env: { ...process.env, KINU_INFLIGHT_ROOT: join(home, 'inflight'), ...environment, KINU_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`script failed (${exitCode}): ${stderr}`);
  }

  return stdout;
}

async function scriptFailure(home: string, script: string, environment: Record<string, string> = {}): Promise<string> {
  try {
    await runScript(home, script, environment);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }

  throw new Error('expected script to fail');
}

function connectedDevice(connected: boolean, overrides: Partial<CloudDevice> = {}): CloudDevice {
  return {
    id: 'dev_1',
    label: 'device',
    os: 'linux',
    hostname: 'box',
    connected,
    createdAt: 0,
    lastSeenAt: null,
    sandbox: { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] },
    wholeMachine: false,
    ...overrides,
  };
}

function connectedResult(label = connectedDevice(true).label) {
  return { kind: 'connected', deviceId: 'dev_1', label, sandbox: connectedDevice(true).sandbox, wholeMachine: false };
}

async function waitForPidExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;

      return true;
    }

    await Bun.sleep(25);
  }

  return false;
}

async function waitForDaemonPid(home: string, timeoutMs = 10_000): Promise<number> {
  const pidfile = join(home, 'pc-agent.pid');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(pidfile)) {
      const pid = Number(readFileSync(pidfile, 'utf-8').trim());

      if (Number.isInteger(pid) && pid > 0) return pid;
    }

    await Bun.sleep(25);
  }

  throw new Error(`no daemon claimed ${pidfile} within ${timeoutMs}ms`);
}

interface ProcessOutput {
  drained: Promise<void>;
  output: () => string;
  waitFor: (text: string, timeoutMs?: number) => Promise<void>;
}

/** A child's stdout buffer; no event exists for another process's lines, so `waitFor` polls it. */
function readProcessOutput(stdout: ReadableStream<Uint8Array>): ProcessOutput {
  let output = '';

  const drained = (async () => {
    for await (const chunk of stdout) output += new TextDecoder().decode(chunk);
  })();

  return {
    drained,
    output: () => output,
    waitFor: async (text, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;

      while (!output.includes(text)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${output}`);
        await Bun.sleep(25);
      }
    },
  };
}

async function liveDaemons(script: string): Promise<number[]> {
  const found = await runToExit(['pgrep', '-f', script]);

  return found.stdout.split('\n').filter(Boolean).map(Number);
}

const DAEMON_PROBE_SCHEMA = v.object({
  result: v.looseObject({ kind: v.string(), deviceId: v.string() }),
  runtime: v.string(),
  command: v.string(),
});

/** Connect, then report the live daemon's command line. `ps` is absolute: these runs replace PATH. */
function daemonRuntimeProbe(origin: string): string {
  const ps = Bun.which('ps') ?? '/bin/ps';

  return `
    import { connectDevice, daemonStatus } from './packages/cli/src/device-connect.ts';
    const result = await connectDevice({ origin: ${JSON.stringify(origin)}, token: 'ptc_test' }, { session: true });
    let pid = daemonStatus().daemonPid;
    for (let attempt = 0; pid === null && attempt < 100; attempt += 1) {
      await Bun.sleep(50);
      pid = daemonStatus().daemonPid;
    }
    const listed = Bun.spawn([${JSON.stringify(ps)}, '-p', String(pid), '-o', 'command='], { stdout: 'pipe' });
    const command = (await new Response(listed.stdout).text()).trim();
    if (await listed.exited !== 0) throw new Error('ps found no process ' + String(pid));
    console.log(JSON.stringify({ result, runtime: process.execPath, command }));
    process.exit(0);
  `;
}

describe('device-connect prompt policy', () => {
  test('offers once per invocation with a cached device-list answer', async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify([await shouldOfferDeviceConnect(), await shouldOfferDeviceConnect()]));
    `);

    expect(JSON.parse(out.trim())).toEqual([true, false]);
    expect(stub.hits.list).toBe(1);
  });

  test('THIS machine connected suppresses the offer without re-fetching', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true, { hostname: hostname() })] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify([await shouldOfferDeviceConnect(), await shouldOfferDeviceConnect()]));
    `);

    expect(JSON.parse(out.trim())).toEqual([false, false]);
    expect(stub.hits.list).toBe(1);
  });

  test("another machine's connected device still leaves this computer to offer", async () => {
    // The card asks about this PC; a daemon connected elsewhere on the account must not suppress it.
    const stub = startStubCloud({ devices: () => [connectedDevice(true, { hostname: 'some-other-box' })] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify([await shouldOfferDeviceConnect(), await shouldOfferDeviceConnect()]));
    `);

    expect(JSON.parse(out.trim())).toEqual([true, false]);
    expect(stub.hits.list).toBe(1);
  });

  test("dismissDeviceConnectPrompt persists don't-ask-again and skips the device fetch", async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { dismissDeviceConnectPrompt, shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      await dismissDeviceConnectPrompt();
      console.log(JSON.stringify(await shouldOfferDeviceConnect()));
    `);

    expect(JSON.parse(out.trim())).toBe(false);
    expect(stub.hits.list).toBe(0);
    const config = parseJsonObject(readFileSync(join(home, 'config.json'), 'utf-8'));
    expect(config.deviceConnectPromptDismissed).toBe(true);
  });

  test('no cloud auth means no offer and no fetch', async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome({ origin: stub.origin });

    const out = await runScript(home, `
      import { shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify(await shouldOfferDeviceConnect()));
    `);

    expect(JSON.parse(out.trim())).toBe(false);
    expect(stub.hits.list).toBe(0);
  });
});

describe('device-connect daemon lifecycle', () => {
  test('connectDevice session mode installs the shipped daemon and kills it with the CLI', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { connectDevice, daemonStatus } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: '${stub.origin}', token: 'ptc_test' }, { session: true });
      // The daemon claims the machine's pidfile itself, in its own process, so
      // this waits for that claim rather than assuming it already landed.
      let status = daemonStatus();
      for (let attempt = 0; status.daemonPid === null && attempt < 100; attempt += 1) {
        await Bun.sleep(50);
        status = daemonStatus();
      }
      console.log(JSON.stringify({ result, status }));
      process.exit(0);
    `);

    const { result, status } = v.parse(v.object({
      result: v.looseObject({ kind: v.string(), deviceId: v.string() }),
      status: v.object({ sessionActive: v.boolean(), daemonPid: v.nullable(v.number()) }),
    }), JSON.parse(out.trim()));

    expect(result).toEqual(connectedResult());
    expect(status.sessionActive).toBe(true);
    expect(status.daemonPid ?? 0).toBeGreaterThan(0);

    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    // runScript sets cwd to the repo root; the daemon reports it to the hub as the consented tree.
    const deviceConfig = parseJsonObject(readFileSync(join(home, 'device.json'), 'utf-8'));
    expect(deviceConfig).toEqual({ user: 'user_1', token: 'device-token', origin: stub.origin, root: repoRoot });
    expect(statSync(join(home, 'pc-agent.js')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'device.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'agents')).mode & 0o777).toBe(0o700);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);

    expect(await waitForPidExit(status.daemonPid ?? 0)).toBe(true);
  });

  test('linking this machine again names the registration it replaces, only to the hub that issued it', async () => {
    const bodies: Array<{ label?: string; replaces?: string }> = [];
    const stub = startStubCloud({ devices: () => [connectedDevice(true)], onRegister: (body) => { bodies.push(body); } });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    // The session daemon dies with the script; a pidfile it left must name a dead process, or the
    // next connect reads "already running" and registers nothing.
    const connect = async () => {
      await runScript(home, `
        import { connectDevice } from './packages/cli/src/device-connect.ts';
        await connectDevice({ origin: '${stub.origin}', token: 'ptc_test' }, { session: true });
        process.exit(0);
      `);
      const pidfile = join(home, 'pc-agent.pid');

      if (existsSync(pidfile)) expect(await waitForPidExit(Number(readFileSync(pidfile, 'utf-8').trim()))).toBe(true);
    };

    // A device.json another deployment issued is that deployment's secret, and stays unsent.
    writeFileSync(join(home, 'device.json'), JSON.stringify({ user: 'u', token: 'pdt_other_hub', origin: 'https://other.example' }));
    await connect();
    await connect();

    expect(bodies.map((body) => body.replaces)).toEqual([undefined, 'device-token']);
  });

  test('session mode is a no-op while a daemon is already running', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(false)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const sleeper = Bun.spawn({ cmd: ['sleep', '30'] });
    sleepers.push(sleeper);
    writeFileSync(join(home, 'pc-agent.pid'), `${sleeper.pid}\n`, { mode: 0o600 });

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: '${stub.origin}', token: 'ptc_test' }, { session: true });
      console.log(JSON.stringify({ result }));
    `);

    const { result } = v.parse(v.object({
      result: v.object({ kind: v.string(), connected: v.boolean() }),
    }), JSON.parse(out.trim()));

    expect(result).toEqual({ kind: 'already-running', connected: false });
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
    expect(sleeper.killed).toBe(false);
    expect(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim()).toBe(String(sleeper.pid));
  });
});

describe('the agent-home root the daemon reports', () => {
  const connect = (stub: ReturnType<typeof startStubCloud>, home: string) => runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      process.exit(0);
    `);

  test('connect creates it owner-only under the home in KINU_HOME', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    await connect(stub, home);
    expect(statSync(join(home, 'agents')).mode & 0o777).toBe(0o700);
  });

  test('a root an earlier build left group-readable is tightened', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const root = join(home, 'agents');
    mkdirSync(root);
    chmodSync(root, 0o755);
    expect(statSync(root).mode & 0o777).toBe(0o755);

    await connect(stub, home);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});

describe('the sandbox state the machine reported', () => {
  /** One phrase from each documented fix; a reason with no row fails the key check below. */
  const REASON_FIX_MARKER = {
    no_bwrap: 'sudo apt install bubblewrap',
    no_userns: 'kernel.apparmor_restrict_unprivileged_userns=0',
    wsl1: 'wsl --set-version',
    no_sandbox_exec: 'Turn Sandbox off',
    unsupported_platform: 'Linux or macOS',
    probe_failed: 'Fix what the daemon named',
    daemon_outdated: 'Update the Kinu CLI',
  } satisfies Record<DeviceSandboxReason, string>;

  const NO_COMMANDS_LINE =
    'Nothing runs here until you fix that, or turn Sandbox off for this device.';

  test('every reason a machine cannot sandbox prints its documented fix', () => {
    expect(Object.keys(REASON_FIX_MARKER).sort()).toEqual([...DEVICE_SANDBOX_REASONS].sort());

    for (const reason of DEVICE_SANDBOX_REASONS) {
      const fix = sandboxReasonFix(reason);
      expect(fix.length).toBeGreaterThan(20);
      expect(fix).toContain(REASON_FIX_MARKER[reason]);
      expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'files_only', reason, detail: null, gpu: [] }))
        .toEqual(['This machine cannot sandbox.', fix, NO_COMMANDS_LINE]);
    }
  });

  test('a machine that cannot sandbox says so, and the reason code stays out of it', () => {
    expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [] }))
      .toEqual(['This machine cannot sandbox.', sandboxReasonFix(null), NO_COMMANDS_LINE]);
  });

  test('a probe that failed in the daemon\'s own words prints those words before the fix', () => {
    // The `probe_failed` fix tells the owner to act on what the daemon named, so that line is printed.
    const detail = "sandbox probe failed: bwrap: Can't chdir to /tmp/kinu-first-run-probe-6B5G: No such file or directory";
    expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'files_only', reason: 'probe_failed', detail, gpu: [] }))
      .toEqual([
        'This machine cannot sandbox.',
        `The daemon said: ${detail}`,
        sandboxReasonFix('probe_failed'),
        NO_COMMANDS_LINE,
      ]);
  });

  test('sandbox on names what the agent sees and the GPU nodes found', () => {
    expect(describeDeviceSandbox({
      tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: ['/dev/nvidia0', '/dev/nvidiactl'],
    })).toEqual([
      'Sandbox on. The agent sees its home plus the folders you picked. Your other files stay invisible.'
      + ' GPU: nvidia0, nvidiactl.',
    ]);
    expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] })[0])
      .toContain('GPU: none.');
  });

  test('sandbox off says the agent runs with full access, whatever the machine proved', () => {
    for (const capability of DEVICE_SANDBOX_CAPABILITIES) {
      expect(describeDeviceSandbox({ tier: 'raw', capability, reason: null, detail: null, gpu: [] }))
        .toEqual(['Sandbox is OFF for this device. Commands run as you, with full access.']);
    }
  });

  test('the device status line carries each connected device state', async () => {
    const stub = startStubCloud({
      devices: () => [
        connectedDevice(true, { label: 'studio' }),
        connectedDevice(true, {
          id: 'dev_2', label: 'tower',
          sandbox: { tier: 'raw', capability: 'sandboxed', reason: null, detail: null, gpu: [] },
        }),
        connectedDevice(true, {
          id: 'dev_3', label: 'vm',
          sandbox: { tier: 'sandboxed', capability: 'files_only', reason: 'no_userns', detail: null, gpu: [] },
        }),
        connectedDevice(true, { id: 'dev_5', label: 'server', wholeMachine: true }),
        connectedDevice(false, { id: 'dev_4', label: 'retired' }),
      ],
    });

    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { deviceStatusLine } from './packages/cli/src/device-connect.ts';
      console.log(await deviceStatusLine());
    `);

    expect(out.trim())
      .toBe('Connected: studio (sandbox on), tower (sandbox OFF), vm (cannot sandbox), server (whole machine)');
  });

  test('a machine linked from / is described as the whole machine, whatever the switch says', () => {
    const [line] = describeDeviceSandbox({ tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] }, true);

    expect(line).toContain('the agent has this whole machine');
    expect(line).not.toContain('Sandbox on');
  });

  test('a device row from a hub too old to report the switch still lists', async () => {
    const stub = startStubCloud({
      devices: () => [{
        id: 'dev_1', label: 'device', os: 'linux', hostname: 'box',
        connected: true, createdAt: 0, lastSeenAt: null,
      }],
    });

    const devices = await listCloudDevices(stub.origin, 'ptc_test');

    expect(devices).toHaveLength(1);
    expect(devices[0].sandbox).toEqual({ tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [] });
  });
});

describe('device-connect install hardening', () => {
  test('installs the daemon inside this CLI and fetches no executable bytes', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify(
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true }),
      ));
      process.exit(0);
    `);

    expect(JSON.parse(out.trim())).toEqual(connectedResult());
    expect(stub.hits.daemonScript).toBe(0);
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(DAEMON_SOURCE);
    // A sibling missing beside the installed daemon kills it on its first require.
    expect(await runScript(home, `require(${JSON.stringify(join(home, 'pc-agent.js'))}); console.log('loaded');`)).toBe('loaded\n');

    for (const [name, source] of Object.entries(DAEMON_SIBLINGS)) {
      expect(readFileSync(join(home, name), 'utf-8')).toBe(source);
    }

    expect(existsSync(join(home, POISON_MARKER))).toBe(false);
  });

  test('a tampered daemon on disk is replaced by the bytes this CLI ships', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    writeFileSync(join(home, 'pc-agent.js'), '// tampered daemon\n', { mode: 0o700 });
    writeFileSync(join(home, 'device.json'), '{"user":"old","token":"old-token","origin":"https://old.example"}\n', { mode: 0o600 });

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify(
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true }),
      ));
      process.exit(0);
    `);

    expect(JSON.parse(out.trim())).toEqual(connectedResult());
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(DAEMON_SOURCE);
    expect(parseJsonObject(readFileSync(join(home, 'device.json'), 'utf-8')))
      .toEqual({ user: 'user_1', token: 'device-token', origin: stub.origin, root: repoRoot });
    expect(statSync(join(home, 'pc-agent.js')).mode & 0o777).toBe(0o700);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  test('publishes neither install file when the daemon cannot be replaced', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    // A directory where the daemon file belongs: the replacement cannot land, so its config is never published.
    mkdirSync(join(home, 'pc-agent.js'));

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('installing the device daemon');
    expect(failure).not.toContain('device-token');
    expect(existsSync(join(home, 'device.json'))).toBe(false);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  test('classifies a duplicate device name without installing anything', async () => {
    const stub = startStubCloud({
      registrationFailure: { status: 409, error: 'device name already exists' },
    });

    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { label: 'studio tower' });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('that device name is already registered');
    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    expect(existsSync(join(home, 'device.json'))).toBe(false);
  });

  test('refuses an unsupported operating system before registration', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    `);

    expect(out.trim()).toContain('runs on Linux and macOS only');
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
  });

  test('starts the daemon on the running Bun when Node is absent from PATH', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const pathWithoutNode = scratchDir('no-node');

    const out = await runScript(home, daemonRuntimeProbe(stub.origin), { PATH: pathWithoutNode });

    const { result, runtime, command } = v.parse(DAEMON_PROBE_SCHEMA, JSON.parse(out.trim()));
    expect(result).toEqual(connectedResult());
    expect(command).toContain(runtime);
    expect(command).toContain(join(home, 'pc-agent.js'));
  });

  test('runs the daemon on the CLI Bun even when a WebSocket-less node sits on PATH', async () => {
    // A PATH node lacking a global WebSocket must never be chosen; the daemon runs on this CLI's Bun.
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const stubDir = scratchDir('stub-node');
    writeFileSync(join(stubDir, 'node'), [
      '#!/bin/sh',
      'echo "probe $*" >> "$0.calls"',
      'if [ "$1" = "--version" ]; then echo "v18.0.0"; exit 0; fi',
      'echo "no WebSocket implementation is available" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });

    const out = await runScript(home, daemonRuntimeProbe(stub.origin), { PATH: stubDir });

    const { result, runtime, command } = v.parse(DAEMON_PROBE_SCHEMA, JSON.parse(out.trim()));
    expect(result).toEqual(connectedResult());

    const calls = existsSync(`${join(stubDir, 'node')}.calls`)
      ? readFileSync(`${join(stubDir, 'node')}.calls`, 'utf-8')
      : '';

    expect(calls).toBe('');
    expect(command).toContain(runtime);
    expect(command).toContain(join(home, 'pc-agent.js'));
  });

  test('reports a device-log permission failure without exposing the device token', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const logPath = join(home, 'pc-agent.log');
    writeFileSync(logPath, 'read-only log\n', { mode: 0o400 });
    chmodSync(logPath, 0o400);

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('opening the device daemon log');
    expect(failure).not.toContain('device-token');
  });

  test('fails fast when the daemon exits at startup', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(false)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    // A file where the in-flight root belongs: the daemon dies before the connect loop.
    const inflight = join(home, 'inflight-is-a-file');
    writeFileSync(inflight, 'not a directory\n', { mode: 0o600 });

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `, { KINU_INFLIGHT_ROOT: inflight });

    expect(failure).toContain('exited before it could connect');
  });

  test('the connect wait ends on the daemon exiting, not on a clock', async () => {
    // 404 then 401: the daemon exits 4 about 1.2 s in, and the wait must end on that exit, not the 20 s bound.
    const stub = startStubCloud({ devices: () => [connectedDevice(false)], ticketStatuses: [404, 401] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        const result = await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
        console.log(JSON.stringify(result));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('exited before it could connect (exit code 4)');
    expect(stub.hits.list).toBeLessThan(5);
  });

  test('a caller ends the wait through its signal and the result says so', async () => {
    // Tickets keep failing with 404, so only the caller's signal ends this wait.
    const stub = startStubCloud({ devices: () => [connectedDevice(false)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      const stop = new AbortController();
      let polls = 0;
      const result = await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, {
        session: true,
        signal: stop.signal,
        onWaiting: () => { polls += 1; if (polls === 2) stop.abort(); },
      });
      console.log(JSON.stringify({ result, polls }));
      // The session daemon is this process's child; exiting is what stops it.
      process.exit(0);
    `);

    expect(JSON.parse(out.trim())).toEqual({ result: { kind: 'cancelled', deviceId: 'dev_1' }, polls: 2 });
  });

  test('never signals an unrelated live process named by a stale pidfile', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const sleeper = Bun.spawn({ cmd: ['sleep', '30'] });
    sleepers.push(sleeper);
    writeFileSync(join(home, 'pc-agent.pid'), `${sleeper.pid}\n`, { mode: 0o600 });

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' });
      console.log(JSON.stringify(result));
    `);

    expect(JSON.parse(out.trim())).toEqual(connectedResult());
    expect(sleeper.killed).toBe(false);
    expect(tolerate(() => {
      process.kill(sleeper.pid, 0);

      return true;
    }, 'esrch')).toBe(true);
    const daemonPid = Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim());
    expect(daemonPid).toBeGreaterThan(0);
    deviceDaemonPids.push(daemonPid);
  });

  test('concurrent connects leave one daemon owner and no partial files', async () => {
    const release = Promise.withResolvers<void>();
    const bothRegistered = Promise.withResolvers<void>();
    let arrivals = 0;

    const stub = startStubCloud({
      devices: () => [connectedDevice(true)],
      registerGate: {
        release: release.promise,
        onArrival() {
          arrivals += 1;

          if (arrivals === 2) bothRegistered.resolve();
        },
      },
    });

    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const program = `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' });
      console.log(JSON.stringify(result));
    `;

    const outcomes = Promise.allSettled([runScript(home, program), runScript(home, program)]);
    await bothRegistered.promise;
    release.resolve();

    const settled = await outcomes;
    expect(settled.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const live = await liveDaemons(join(home, 'pc-agent.js'));
    expect(live).toHaveLength(1);
    expect(Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim())).toBe(live[0]);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    deviceDaemonPids.push(...live);
  });
});

describe('device daemon single-instance lock', () => {
  function installedMachine(origin: string): string {
    const home = makeHome({ origin, accessToken: 'ptc_test' });
    writeFileSync(join(home, 'pc-agent.js'), DAEMON_SOURCE, { mode: 0o700 });

    for (const [name, source] of Object.entries(DAEMON_SIBLINGS)) {
      writeFileSync(join(home, name), source, { mode: 0o700 });
    }

    writeFileSync(
      join(home, 'device.json'),
      `${JSON.stringify({ user: 'user_1', token: 'device-token', origin })}\n`,
      { mode: 0o600 },
    );

    return home;
  }

  let signing: Record<string, string> = {};
  beforeAll(async () => { signing = await releaseSigningEnv(); });

  function startDaemon(home: string) {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(home, 'pc-agent.js')],
      cwd: newProjectDir(),
      // The hub helper signs its release with the test key; the daemon pins it.
      env: { ...process.env, KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight'), ...signing },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.pid) deviceDaemonPids.push(proc.pid);

    return { proc, ...readProcessOutput(proc.stdout) };
  }

  test('a second daemon on the same KINU_HOME exits instead of connecting', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = installedMachine(stub.origin);

    const owner = startDaemon(home);
    await owner.waitFor('Ticket exchange');

    const second = startDaemon(home);

    const exited = await Promise.race([
      second.proc.exited,
      // Bounds a daemon that never exits, which is the defect this pins.
      Bun.sleep(5_000).then(() => 'still running' as const),
    ]);

    await Promise.race([second.drained, Bun.sleep(100)]);

    expect(second.output()).toContain('already running');
    expect(second.output()).not.toContain('Ticket exchange');
    expect(exited).toBe(3);
    expect(Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim())).toBe(owner.proc.pid);
    expect(owner.proc.killed).toBe(false);
  });

  test('a self-update hands the machine to exactly one successor; a third daemon still exits', async () => {
    // Handover: the successor takes the pidfile over and the old daemon exits.
    const newDaemon = `${DAEMON_SOURCE}\n// build 2.0.0+new\n`;
    const hub = startUpdateHub({ served: '2.0.0+new', archive: await daemonArchive({ ...DAEMON_SIBLINGS, 'pc-agent.js': newDaemon }, '2.0.0+new') });
    updateHubs.push(hub);
    const home = installedMachine(hub.origin);
    writeFileSync(join(home, 'pc-agent.version'), '1.0.0+old\n', { mode: 0o600 });

    const old = startDaemon(home);
    await old.waitFor('Connected');
    const oldPid = await waitForDaemonPid(home);
    await until(() => hub.sockets[1], 'the successor to connect', old.output);
    expect(await old.proc.exited).toBe(0);

    const successorPid = await waitForDaemonPid(home);
    expect(successorPid).not.toBe(oldPid);
    deviceDaemonPids.push(successorPid);
    expect(await waitForPidExit(oldPid)).toBe(true);
    expect(await liveDaemons(join(home, 'pc-agent.js'))).toEqual([successorPid]);
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(newDaemon);

    const third = startDaemon(home);
    expect(await Promise.race([third.proc.exited, Bun.sleep(5_000).then(() => 'still running' as const)])).toBe(3);
    await Promise.race([third.drained, Bun.sleep(100)]);
    expect(third.output()).toContain('already running');
    expect(Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim())).toBe(successorPid);
  });
});

describe('classic cloud chat connect prompt', () => {
  function cloudAgentConfig(origin: string): JsonObject {
    return {
      origin,
      accessToken: ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join(''),
      agents: {
        jarvis: {
          name: 'jarvis',
          mode: 'cloud',
          cloudName: 'jarvis',
          purpose: 'Cloud agent',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
    };
  }

  function spawnChatInPty(home: string) {
    const cliBin = resolve(repoRoot, 'packages/cli/bin/cli.ts');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

    const command = [
      `KINU_HOME=${quote(home)}`,
      `KINU_INFLIGHT_ROOT=${quote(join(home, 'inflight'))}`,
      quote(process.execPath),
      quote(cliBin),
      'chat',
      'jarvis',
      '--classic',
      '--no-transcript',
    ].join(' ');

    const proc = Bun.spawn({
      cmd: ['script', '-qefc', command, '/dev/null'],
      cwd: newProjectDir(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    return {
      proc,
      ...readProcessOutput(proc.stdout),
      async send(line: string): Promise<void> {
        await proc.stdin.write(`${line}\n`);
        await proc.stdin.flush();
      },
    };
  }

  test('interactive open offers c/s/n/d and session connect goes end to end', async () => {
    let registered = false;

    const stub = startStubCloud({
      devices: () => (registered ? [connectedDevice(true)] : []),
      onRegister: () => { registered = true; },
    });

    const home = makeHome(cloudAgentConfig(stub.origin));

    const chat = spawnChatInPty(home);
    await chat.waitFor('Let this agent use this computer?');
    await chat.waitFor("[c] connect and stay connected · [s] this session only · [n] not now · [d] don't ask again");
    await chat.send('s');
    await chat.waitFor('Connected for this session.');
    const daemonPid = await waitForDaemonPid(home);
    await chat.send('/exit');
    await chat.proc.exited;
    await chat.drained;

    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(DAEMON_SOURCE);

    expect(await waitForPidExit(daemonPid)).toBe(true);
  });

  test('non-interactive stdin prints the kinu connect instruction instead', async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome(cloudAgentConfig(stub.origin));
    const cliBin = resolve(repoRoot, 'packages/cli/bin/cli.ts');

    const proc = Bun.spawn({
      cmd: [process.execPath, cliBin, 'chat', 'jarvis', '--no-transcript'],
      cwd: newProjectDir(),
      stdin: Buffer.from('/exit\n'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, KINU_HOME: home },
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('No computer is connected. Connect this one with: kinu connect');
    expect(stub.hits.register).toBe(0);
  });
});

describe('kinu connect waits on the daemon and says less', () => {
  function spawnPtyCommand(command: string) {
    const proc = Bun.spawn({
      cmd: ['script', '-qefc', command, '/dev/null'],
      cwd: newProjectDir(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    let output = '';
    let eof = false;

    // Strip at the seam: a colour TERM makes chalk wrap tokens in escape bytes.
    const drained = (async () => {
      for await (const chunk of proc.stdout) output += Bun.stripANSI(new TextDecoder().decode(chunk));
      eof = true;
    })();

    return {
      proc,
      output: () => output,
      drained,
      // Resolves on the text; rejects only after exit and PTY EOF (output can land after exit). No deadline:
      // the product waits on the daemon, not a clock.
      async waitFor(text: string): Promise<void> {
        while (true) {
          if (output.includes(text)) return;

          if (eof) {
            throw new Error(`pty reached EOF while waiting for ${JSON.stringify(text)} in:\n${output}`);
          }

          await Bun.sleep(25);
        }
      },
      async send(line: string): Promise<void> {
        await proc.stdin.write(`${line}\n`);
        await proc.stdin.flush();
      },
    };
  }

  function spawnConnectInPty(home: string, label?: string) {
    const cliBin = resolve(repoRoot, 'packages/cli/bin/cli.ts');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

    const command = [
      `KINU_HOME=${quote(home)}`,
      `KINU_INFLIGHT_ROOT=${quote(join(home, 'inflight'))}`,
      quote(process.execPath),
      quote(cliBin),
      'connect',
      ...(label === undefined ? [] : ['--label', quote(label)]),
    ].join(' ');

    return spawnPtyCommand(command);
  }


  test('the hub row reading connected ends the wait with the row label', async () => {
    // The stub reports label and typed name apart, so a success echoing the prompt input fails.
    let registered = false;

    const devices = () => (registered ? [connectedDevice(true, { label: 'hub-names-it' })] : []);
    const stub = startStubCloud({ devices, onRegister: () => { registered = true; } });

    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const connect = spawnConnectInPty(home);
    await connect.waitFor('Kinu installs a small daemon here');
    await connect.waitFor('Everything else stays invisible to it.');
    await connect.waitFor('The daemon only dials out.');
    await connect.waitFor('Device name');
    expect(stub.hits.register).toBe(0);
    expect(existsSync(join(home, 'pc-agent.js'))).toBe(false);

    await connect.send('typed-name');
    await connect.waitFor('Link and start the daemon?');
    expect(stub.hits.register).toBe(0);

    await connect.send('y');
    await connect.waitFor('✓ Connected as hub-names-it');
    await connect.waitFor('Sandbox on. The agent sees its home plus the folders you picked');
    await connect.waitFor('Manage it under Account settings → Devices.');
    await connect.waitFor('Daemon log:');
    await connect.proc.exited;
    await connect.drained;

    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    expect(existsSync(join(home, 'device.json'))).toBe(true);

    const daemonPid = await waitForDaemonPid(home);
    process.kill(daemonPid, 'SIGTERM');
    expect(await waitForPidExit(daemonPid)).toBe(true);
  });

  test('the stub daemon exiting ends the wait with its tail', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(false)], ticketStatuses: [401] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const connect = spawnConnectInPty(home, 'tail-box');
    await connect.waitFor('Link and start the daemon?');
    await connect.send('y');
    await connect.waitFor('the device daemon exited before it could connect (exit code 4)');
    await connect.waitFor('device credentials were rejected; re-run: kinu connect');
    await connect.proc.exited;
    await connect.drained;

    expect(connect.output()).not.toContain('✓ Connected as');
  });

  test('a stub alive and never connecting leaves the command waiting', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(false)], ticketStatuses: [404] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const waiting = spawnConnectInPty(home, 'patient-box');
    await waiting.waitFor('Link and start the daemon?');
    await waiting.send('y');
    await waiting.waitFor('Waiting for the daemon to connect');
    // Advance by the stub's poll counter, not a sleep.

    const listsAtStart = stub.hits.list;

    await waiting.waitFor('.');

    while (stub.hits.list < listsAtStart + 2) await Bun.sleep(25);
    expect(waiting.proc.exitCode).toBeNull();
    expect(waiting.output()).not.toContain('✓ Connected as');
    expect(waiting.output()).not.toContain('exited before it could connect');
    expect(stub.hits.list).toBeGreaterThanOrEqual(listsAtStart + 2);

    waiting.proc.kill('SIGINT');
    await waiting.proc.exited;
    await waiting.drained;

    const daemonPid = await waitForDaemonPid(home);
    process.kill(daemonPid, 'SIGTERM');
    expect(await waitForPidExit(daemonPid)).toBe(true);
  });

  test('answering no installs nothing at all', async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const connect = spawnConnectInPty(home);
    await connect.waitFor('Device name');
    await connect.send('');
    await connect.waitFor('Link and start the daemon?');
    await connect.send('n');
    await connect.proc.exited;
    await connect.drained;

    expect(connect.output()).toContain('Nothing was installed');
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
    expect(existsSync(join(home, 'pc-agent.js'))).toBe(false);
    expect(existsSync(join(home, 'device.json'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.pid'))).toBe(false);
  });

  test('the suggested name is the hostname, nothing else', async () => {
    const home = makeHome({ origin: 'https://example.invalid', accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { hostname } from 'node:os';
      import { defaultDeviceName } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify({ name: defaultDeviceName(), host: hostname().trim() }));
    `);

    const { name, host } = v.parse(v.object({ name: v.string(), host: v.string() }), JSON.parse(out.trim()));
    expect(name).toBe(host);
    expect(name.length).toBeGreaterThan(0);
  });

  test('a stub that prints the awaited text and exits immediately resolves', async () => {
    // The text lands the same moment the child exits; the wait must read the buffer before the EOF flag.

    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const print = `${quote(process.execPath)} -e ${quote('console.log("✓ Connected as hub-names-it")')}`;
    const fast = spawnPtyCommand(print);

    await fast.waitFor('✓ Connected as hub-names-it');
    await fast.proc.exited;
    await fast.drained;
  });
});

describe('/connect slash command', () => {
  test('is offered to consent-capable clients and returns the device-connect outcome', async () => {
    const { commandsForClient, executeSlashCommand } = await import('../src/slash-commands');

    const clientOptions = {
      origin: 'https://kinu.invalid', token: 'test', agentName: 'test', cloudName: 'test',
      transcript: { noTranscript: true },
    };

    const cloudish = new CloudAgentClient(clientOptions);
    const localish = new CloudAgentClient(clientOptions);
    Object.defineProperty(localish, 'consents', { value: null });

    expect(commandsForClient(cloudish).map((c) => c.name)).toContain('/connect');
    expect(commandsForClient(localish).map((c) => c.name)).not.toContain('/connect');
    expect(await executeSlashCommand(cloudish, '/connect')).toEqual({ kind: 'device-connect' });
    expect(await executeSlashCommand(localish, '/connect')).toEqual({ kind: 'unknown', command: '/connect' });
    await cloudish.close();
    await localish.close();
  });
});

describe('desktop command reuses device-connect', () => {
  // Asserts behaviour, not `desktop.ts` source: a second copy of the module's paths prints a different path.
  test('desktop status and logs report the paths device-connect owns', async () => {
    const home = makeHome({ cloudOrigin: 'http://localhost:1', token: 'tok' });

    const stdout = await runScript(home, `
      import { desktopCommand } from './packages/cli/src/commands/desktop.ts';
      import { DEVICE_CONFIG_PATH, DAEMON_LOG_PATH } from './packages/cli/src/device-connect.ts';
      import { writeFileSync } from 'node:fs';
      writeFileSync(DAEMON_LOG_PATH, 'daemon line one\\ndaemon line two\\n');
      const lines = [];
      const real = console.log;
      console.log = (...args) => { lines.push(args.join(' ')); };
      await desktopCommand('status', {});
      await desktopCommand('logs', {});
      console.log = real;
      console.log(JSON.stringify({ printed: lines.join('\\n'), DEVICE_CONFIG_PATH, DAEMON_LOG_PATH }));
    `);

    const seen = v.parse(
      v.object({ printed: v.string(), DEVICE_CONFIG_PATH: v.string(), DAEMON_LOG_PATH: v.string() }),
      JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}'),
    );

    expect(seen.DEVICE_CONFIG_PATH.startsWith(home)).toBe(true);
    expect(seen.DAEMON_LOG_PATH.startsWith(home)).toBe(true);
    expect(seen.printed).toContain(seen.DEVICE_CONFIG_PATH);
    expect(seen.printed).toContain(seen.DAEMON_LOG_PATH);
    expect(seen.printed).toContain('daemon line two');
  });

  test('an unknown desktop subcommand names the three it has', async () => {
    const home = makeHome({ cloudOrigin: 'http://localhost:1', token: 'tok' });

    const failure = await scriptFailure(home, `
      import { desktopCommand } from './packages/cli/src/commands/desktop.ts';
      await desktopCommand('reinstall-everything', {});
    `);

    expect(failure).toContain('Usage: kinu desktop [connect|status|logs]');
  });
});
