// Behavior tests for the device-connect module: the once-per-invocation
// prompt latch with a cached device answer, the persisted don't-ask-again
// config key, the session-daemon lifecycle (spawned tied to the CLI, killed
// on exit, no-op next to a running daemon), connectDevice against a stub
// cloud origin, and the desktop command staying a thin shell over the module.
// The daemon installed here is the one inside this CLI. The stub origin still
// answers the retired /pc/daemon.js route, with poison, so a connect that
// fetches executable bytes shows up as poison on disk.
// Env-dependent paths (KINU_HOME) run in subprocesses like config.test.ts.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server, Subprocess } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
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

const repoRoot = resolve(__dirname, '../../..');
/** Every module the daemon requires beside itself, keyed by the name it
 *  requires, with the bytes this CLI ships for it. Derived from the daemon's
 *  own require lines: a sibling the daemon requires and this table lacks is
 *  the defect this suite exists to catch — the pty module shipped nowhere
 *  for one release while the daemon required it, and every clean install
 *  died on its first require. */
const DAEMON_SIBLINGS = { 'sandbox.js': SANDBOX_SOURCE, 'pty.js': PTY_SOURCE } as const;
/** Mirrors the installer's private reader of the daemon's `require('./x')`
 *  lines; drift between the two fails these tests, which is the point. */
const REQUIRED_SIBLINGS = [...DAEMON_SOURCE.matchAll(/require\('\.\/([^']+)'\)/g)]
  .map((m) => m[1] ?? '').filter((n) => n !== '');

const tempDirs: string[] = [];

/** Fresh throwaway project directory per spawn: the CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo. */
function newProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-test-project-'));
  tempDirs.push(dir);
  return dir;
}

const sleepers: Subprocess[] = [];
const deviceDaemonPids: number[] = [];
const stubs: Server<unknown>[] = [];

afterEach(async () => {
  for (const pid of deviceDaemonPids.splice(0)) tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');
  for (const proc of sleepers.splice(0)) proc.kill();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(stubs.splice(0).map((server) => server.stop(true)));
});

interface StubCloud {
  origin: string;
  hits: { register: number; list: number; daemonScript: number };
}

interface StubCloudOptions {
  /** What the stub serves as the device list. Typed as the wire, not as
   *  `CloudDevice`, so a case can serve the row an older hub sends. */
  devices?: () => unknown[];
  /** Holds every registration until the test releases it. */
  registerGate?: { release: Promise<void>; onArrival?: () => void };
  registrationFailure?: { status: number; error: string };
  /** The registration body, so a test can assert the NAME the CLI sent. */
  onRegister?: (body: { label?: string }) => void;
}

/** The file the poisoned daemon writes if it ever runs. */
const POISON_MARKER = 'poisoned-daemon-ran';

/**
 * What a compromised origin serves at /pc/daemon.js. It parses and carries the
 * three strings the retired marker check looked for, so a CLI that downloads
 * its daemon installs this and runs it as the user.
 */
const POISON_DAEMON = [
  '// /pc/connect-ticket',
  "const cancel = 'execCancel';",
  "const rotate = 'ROTATE';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  `fs.writeFileSync(path.join(process.env.KINU_HOME, '${POISON_MARKER}'), 'ran');`,
  'setInterval(() => {}, 1000);',
].join('\n');

/** Minimal cloud origin: device register/list, plus the retired daemon route
 *  serving poison so any fetch of it is visible in the installed bytes. */
function startStubCloud(opts: StubCloudOptions = {}): StubCloud {
  const hits = { register: 0, list: 0, daemonScript: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === '/api/cli/devices' && req.method === 'POST') {
        hits.register += 1;
        const body = v.safeParse(v.object({ label: v.optional(v.string()) }), await req.json());
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
  const home = mkdtempSync(join(tmpdir(), 'kinu-device-'));
  tempDirs.push(home);
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return home;
}

async function runScript(home: string, script: string, environment: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    // The daemon started here is the real one: fence its in-flight root inside
    // the test home so a run never reads or prunes the developer's own.
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
    label: 'laptop',
    os: 'linux',
    hostname: 'box',
    connected,
    createdAt: 0,
    lastSeenAt: null,
    sandbox: { tier: 'sandboxed', capability: 'sandboxed', reason: null, detail: null, gpu: [] },
    ...overrides,
  };
}

/** What connectDevice returns for the stub's default row: the device id plus
 *  the sandbox state that row reported. */
function connectedResult() {
  return { kind: 'connected', deviceId: 'dev_1', sandbox: connectedDevice(true).sandbox };
}

async function waitForPidExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // ESRCH is kill(2)'s "no such process" — the exit this loop waits for.
    try { process.kill(pid, 0); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      return true;
    }
    await Bun.sleep(25);
  }
  return false;
}

/** The pid in the machine's daemon pidfile, which the daemon claims itself. */
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

/** Every live process running the installed daemon at `script`. */
function liveDaemons(script: string): number[] {
  const found = Bun.spawnSync({ cmd: ['pgrep', '-f', script] });
  return new TextDecoder().decode(found.stdout).split('\n').filter(Boolean).map(Number);
}

const DAEMON_PROBE_SCHEMA = v.object({
  // Loose on the result: `connectDevice` reports the machine's sandbox state
  // beside the id, and this probe is about the daemon's command line.
  result: v.looseObject({ kind: v.string(), deviceId: v.string() }),
  runtime: v.string(),
  command: v.string(),
});

/**
 * Connect, then report the live daemon's own command line. `ps` is addressed by
 * absolute path because these runs replace PATH to control which runtimes the
 * CLI can see.
 */
function daemonRuntimeProbe(origin: string): string {
  const ps = Bun.which('ps') ?? '/bin/ps';
  return `
    import { execFileSync } from 'node:child_process';
    import { connectDevice, daemonStatus } from './packages/cli/src/device-connect.ts';
    const result = await connectDevice({ origin: ${JSON.stringify(origin)}, token: 'ptc_test' }, { session: true });
    let pid = daemonStatus().daemonPid;
    for (let attempt = 0; pid === null && attempt < 100; attempt += 1) {
      await Bun.sleep(50);
      pid = daemonStatus().daemonPid;
    }
    const command = execFileSync(${JSON.stringify(ps)}, ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
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

  test('a connected device suppresses the offer without re-fetching', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify([await shouldOfferDeviceConnect(), await shouldOfferDeviceConnect()]));
    `);

    expect(JSON.parse(out.trim())).toEqual([false, false]);
    expect(stub.hits.list).toBe(1);
  });

  test("dismissDeviceConnectPrompt persists don't-ask-again and skips the device fetch", async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { dismissDeviceConnectPrompt, shouldOfferDeviceConnect } from './packages/cli/src/device-connect.ts';
      dismissDeviceConnectPrompt();
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
    expect(status.daemonPid ?? 0).toBeGreaterThan(0); // the daemon holds the machine lock

    // The install came out of this CLI, and the origin was asked for nothing
    // executable.
    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    // `root` is the directory the connect ran in, which runScript sets to the
    // repository root: the daemon carries it to the hub as the consented tree.
    const deviceConfig = parseJsonObject(readFileSync(join(home, 'device.json'), 'utf-8'));
    expect(deviceConfig).toEqual({ user: 'user_1', token: 'device-token', origin: stub.origin, root: repoRoot });
    expect(statSync(join(home, 'pc-agent.js')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'device.json')).mode & 0o777).toBe(0o600);
    // The root the daemon reports to the hub, created by the connect flow.
    expect(statSync(join(home, 'agents')).mode & 0o777).toBe(0o700);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);

    // The CLI process exited — its exit hook must have killed the session daemon.
    expect(await waitForPidExit(status.daemonPid ?? 0)).toBe(true);
  }, 20_000);

  test('session mode is a no-op while a daemon is already running', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(false)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    // A live daemon owner: a sleeper owned by the test, via the pidfile.
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
    // No takeover: nothing registered, installed, or killed.
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
    expect(sleeper.killed).toBe(false);
    expect(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim()).toBe(String(sleeper.pid));
  });
});

describe('the agent-home root the daemon reports', () => {
  // Through the one public path that installs the daemon files: a connect.
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
  }, 20_000);

  test('a root an earlier build left group-readable is tightened', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const root = join(home, 'agents');
    mkdirSync(root);
    chmodSync(root, 0o755);
    expect(statSync(root).mode & 0o777).toBe(0o755);

    await connect(stub, home);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  }, 20_000);
});

describe('the sandbox state the machine reported', () => {
  /** One phrase out of each documented fix: the remedy, or the platform fact
   *  that decides there is none. A fix that stops naming either fails here; a
   *  reason with no row fails the key check below. */
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
      // A reason core carries no fix text for has no sentence to print.
      const fix = sandboxReasonFix(reason);
      expect(fix.length).toBeGreaterThan(20);
      expect(fix).toContain(REASON_FIX_MARKER[reason]);
      expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'files_only', reason, detail: null, gpu: [] }))
        .toEqual(['This machine cannot sandbox.', fix, NO_COMMANDS_LINE]);
    }
  });

  test('the user-namespace fix is core\'s sentence, never a second copy here', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/cli/src/device-connect.ts'), 'utf8');
    const SYSCTL = 'kernel.apparmor_restrict_unprivileged_userns=0';
    expect(sandboxReasonFix('no_userns')).toContain(SYSCTL);
    expect(source).not.toContain(SYSCTL);
    expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'files_only', reason: 'no_userns', detail: null, gpu: [] })[1])
      .toContain(SYSCTL);
  });

  test('a machine that cannot sandbox says so, and the reason code stays out of it', () => {
    expect(describeDeviceSandbox({ tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [] }))
      .toEqual(['This machine cannot sandbox.', sandboxReasonFix(null), NO_COMMANDS_LINE]);
  });

  test('a probe that failed in the daemon\'s own words prints those words before the fix', () => {
    // The fix for `probe_failed` tells the owner to act on what the daemon
    // named, so the line the daemon sent is printed where the owner reads it.
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
        connectedDevice(false, { id: 'dev_4', label: 'retired' }),
      ],
    });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { deviceStatusLine } from './packages/cli/src/device-connect.ts';
      console.log(await deviceStatusLine());
    `);

    expect(out.trim())
      .toBe('Connected: studio (sandbox on), tower (sandbox OFF), vm (cannot sandbox)');
  });

  test('a device row from a hub too old to report the switch still lists', async () => {
    const stub = startStubCloud({
      devices: () => [{
        id: 'dev_1', label: 'laptop', os: 'linux', hostname: 'box',
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
    // The origin serves poison at the retired route. Nothing asked for it, the
    // bytes on disk are this CLI's own, and the poison never ran.
    expect(stub.hits.daemonScript).toBe(0);
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(DAEMON_SOURCE);
    // The daemon requires its siblings by relative path, so a release that
    // ships the daemon without one of them is a daemon that dies on its first
    // require. The shipped set IS the daemon's require lines, and every byte
    // is this CLI's own.
    expect(REQUIRED_SIBLINGS.length).toBeGreaterThan(1);
    expect(Object.keys(DAEMON_SIBLINGS).sort()).toEqual([...REQUIRED_SIBLINGS].sort());
    for (const [name, source] of Object.entries(DAEMON_SIBLINGS)) {
      expect(readFileSync(join(home, name), 'utf-8')).toBe(source);
    }
    expect(existsSync(join(home, POISON_MARKER))).toBe(false);
  }, 20_000);

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
  }, 20_000);

  test('publishes neither install file when the daemon cannot be replaced', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    // A directory where the daemon file belongs: the replacement cannot land,
    // so the config that would activate it is never published either.
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
  }, 20_000);

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
    const pathWithoutNode = mkdtempSync(join(tmpdir(), 'kinu-no-node-'));
    tempDirs.push(pathWithoutNode);

    const out = await runScript(home, daemonRuntimeProbe(stub.origin), { PATH: pathWithoutNode });

    const { result, runtime, command } = v.parse(DAEMON_PROBE_SCHEMA, JSON.parse(out.trim()));
    expect(result).toEqual(connectedResult());
    // The live daemon process is the CLI's own Bun running the installed file.
    expect(command).toContain(runtime);
    expect(command).toContain(join(home, 'pc-agent.js'));
  }, 20_000);

  test('runs the daemon on the CLI Bun even when a WebSocket-less node sits on PATH', async () => {
    // The Mac defect: a PATH node that answers --version but has no global
    // WebSocket won daemonRuntime's probe and killed the daemon at startup.
    // The daemon's runtime is the Bun running this CLI — a PATH node is never
    // consulted, and this test's stub records every invocation to prove it.
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const stubDir = mkdtempSync(join(tmpdir(), 'kinu-stub-node-'));
    tempDirs.push(stubDir);
    writeFileSync(join(stubDir, 'node'), [
      '#!/bin/sh',
      // The stub records the probe, then acts healthy for --version and
      // broken for anything else — the conda node's exact surface.
      'echo "probe $*" >> "$0.calls"',
      'if [ "$1" = "--version" ]; then echo "v18.0.0"; exit 0; fi',
      'echo "no WebSocket implementation is available" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });

    const out = await runScript(home, daemonRuntimeProbe(stub.origin), { PATH: stubDir });

    const { result, runtime, command } = v.parse(DAEMON_PROBE_SCHEMA, JSON.parse(out.trim()));
    expect(result).toEqual(connectedResult());
    // The stub node answered --version and was still never chosen.
    const calls = existsSync(`${join(stubDir, 'node')}.calls`)
      ? readFileSync(`${join(stubDir, 'node')}.calls`, 'utf-8')
      : '';
    expect(calls).toBe('');
    expect(command).toContain(runtime);
    expect(command).toContain(join(home, 'pc-agent.js'));
  }, 20_000);

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
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    // A file where the daemon's in-flight root belongs. The daemon cannot read
    // its own request registry and dies before it reaches the connect loop.
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
  }, 20_000);

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
    const live = liveDaemons(join(home, 'pc-agent.js'));
    expect(live).toHaveLength(1);
    expect(Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim())).toBe(live[0]);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    deviceDaemonPids.push(...live);
  }, 30_000);
});

describe('device daemon single-instance lock', () => {
  /** The installed machine state a daemon needs, without starting one. */
  function installedMachine(origin: string): string {
    const home = makeHome({ origin, accessToken: 'ptc_test' });
    writeFileSync(join(home, 'pc-agent.js'), DAEMON_SOURCE, { mode: 0o700 });
    // Every sibling, because the daemon requires them by relative path: an
    // installed machine missing one is a daemon that dies before it logs
    // anything, which is what this fixture found — twice.
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

  /** The daemon as anything but the CLI starts it: the installed file, run. */
  function startDaemon(home: string) {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(home, 'pc-agent.js')],
      cwd: newProjectDir(),
      env: { ...process.env, KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.pid) deviceDaemonPids.push(proc.pid);
    let output = '';
    const drained = (async () => {
      for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
    })();
    return {
      proc,
      drained,
      output: () => output,
      // Another process writes these lines; there is no event to await, so the
      // wait polls the buffer the reader above fills.
      async waitFor(text: string, timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!output.includes(text)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${output}`);
          await Bun.sleep(25);
        }
      },
    };
  }

  test('a second daemon on the same KINU_HOME exits instead of connecting', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(true)] });
    const home = installedMachine(stub.origin);

    const owner = startDaemon(home);
    await owner.waitFor('Ticket exchange'); // the owner's connect loop is running

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
    // The owner keeps the machine, and the pidfile still names it.
    expect(Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim())).toBe(owner.proc.pid);
    expect(owner.proc.killed).toBe(false);
  }, 30_000);
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

  /** Interactive PTY chat: answer prompts only after they appear. */
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
    let output = '';
    const drained = (async () => {
      for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
    })();
    return {
      proc,
      output: () => output,
      drained,
      async waitFor(text: string, timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!output.includes(text)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${output}`);
          await Bun.sleep(25);
        }
      },
      async send(line: string): Promise<void> {
        await proc.stdin.write(`${line}\n`);
        await proc.stdin.flush();
      },
    };
  }
  test('interactive open offers c/s/n/d and session connect goes end to end', async () => {
    // Devices connect only after the daemon is registered and started.
    let registered = false;
    const stub = startStubCloud({
      devices: () => (registered ? [connectedDevice(true)] : []),
      onRegister: () => { registered = true; },
    });
    const home = makeHome(cloudAgentConfig(stub.origin));

    const chat = spawnChatInPty(home);
    await chat.waitFor('Let this agent use this PC?');
    await chat.waitFor("[c] connect & keep connected · [s] this session only · [n] not now · [d] don't ask again");
    await chat.send('s');
    await chat.waitFor('Connected for this session.');
    // The daemon claims the machine's pidfile itself, whoever started it.
    const daemonPid = await waitForDaemonPid(home);
    await chat.send('/exit');
    await chat.proc.exited;
    await chat.drained;

    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(DAEMON_SOURCE);

    // The CLI exited; its exit hook must have killed the session daemon.
    expect(await waitForPidExit(daemonPid)).toBe(true);
  }, 20_000);

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
    expect(stdout).toContain('No PC connected. Connect one with: kinu connect');
    expect(stub.hits.register).toBe(0);
  });
});

describe('kinu connect states its terms, takes a name, and waits for a yes', () => {
  /** The real `kinu connect`, under a PTY so its /dev/tty prompts are reachable. */
  function spawnConnectInPty(home: string) {
    const cliBin = resolve(repoRoot, 'packages/cli/bin/cli.ts');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const command = [
      `KINU_HOME=${quote(home)}`,
      `KINU_INFLIGHT_ROOT=${quote(join(home, 'inflight'))}`,
      quote(process.execPath),
      quote(cliBin),
      'connect',
    ].join(' ');
    const proc = Bun.spawn({
      cmd: ['script', '-qefc', command, '/dev/null'],
      cwd: newProjectDir(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    let output = '';
    const drained = (async () => {
      for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
    })();
    return {
      proc,
      output: () => output,
      drained,
      // A separate process writes to a PTY; there is no event to await, so the
      // wait polls the buffer the reader fills.
      async waitFor(text: string, timeoutMs = 15_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!output.includes(text)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${output}`);
          await Bun.sleep(25);
        }
      },
      async send(line: string): Promise<void> {
        await proc.stdin.write(`${line}\n`);
        await proc.stdin.flush();
      },
    };
  }

  test('it states what access it grants, registers under the name given, and links', async () => {
    let registered = false;
    let label: string | undefined;
    const stub = startStubCloud({
      devices: () => (registered ? [connectedDevice(true)] : []),
      onRegister: (body) => { registered = true; label = body?.label; },
    });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const connect = spawnConnectInPty(home);
    // The terms come BEFORE anything is installed.
    await connect.waitFor('Connecting installs the Kinu daemon on this machine');
    await connect.waitFor('Revoke it under Account settings');
    await connect.waitFor('one Sandbox switch per device');
    await connect.waitFor('Name this device');
    expect(stub.hits.register).toBe(0);
    expect(existsSync(join(home, 'pc-agent.js'))).toBe(false);

    await connect.send('studio tower');
    await connect.waitFor('Link this machine as "studio tower" and start the daemon?');
    expect(stub.hits.register).toBe(0); // still nothing, the question is unanswered

    await connect.send('y');
    await connect.waitFor('Connected this machine as');
    // The machine's own report reaches the terminal.
    await connect.waitFor('Sandbox on. The agent sees its home plus the folders you picked');
    await connect.proc.exited;
    await connect.drained;

    expect(connect.output()).toContain('studio tower');
    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(0);
    expect(label).toBe('studio tower');
    expect(existsSync(join(home, 'device.json'))).toBe(true);

    const daemonPid = await waitForDaemonPid(home);
    process.kill(daemonPid, 'SIGTERM');
    expect(await waitForPidExit(daemonPid)).toBe(true);
  }, 30_000);

  test('answering no installs nothing at all', async () => {
    const stub = startStubCloud({ devices: () => [] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const connect = spawnConnectInPty(home);
    await connect.waitFor('Name this device');
    await connect.send(''); // take the suggested user@hostname
    await connect.waitFor('and start the daemon?');
    await connect.send('n');
    await connect.proc.exited;
    await connect.drained;

    expect(connect.output()).toContain('Nothing was installed');
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
    expect(existsSync(join(home, 'pc-agent.js'))).toBe(false);
    expect(existsSync(join(home, 'device.json'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.pid'))).toBe(false);
  }, 30_000);

  test('the suggested name is this machine, not a generic label', async () => {
    const home = makeHome({ origin: 'https://example.invalid', accessToken: 'ptc_test' });
    const out = await runScript(home, `
      import { hostname } from 'node:os';
      import { defaultDeviceName, UNNAMED_DEVICE_NAME } from './packages/cli/src/device-connect.ts';
      console.log(JSON.stringify({ name: defaultDeviceName(), host: hostname(), fallback: UNNAMED_DEVICE_NAME }));
    `);
    const { name, host, fallback } = v.parse(v.object({
      name: v.string(), host: v.string(), fallback: v.string(),
    }), JSON.parse(out.trim()));
    expect(fallback).toBe('Your PC');
    // On any POSIX box with a passwd entry this is user@host; the fallback is
    // the only other legal answer, and it is never the empty string.
    expect(name === fallback || name.endsWith(`@${host}`)).toBe(true);
    expect(name.length).toBeGreaterThan(0);
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
  test('desktop.ts keeps zero duplicated daemon/registration logic', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/cli/src/commands/desktop.ts'), 'utf8');
    expect(source).toContain("from '../device-connect'");
    expect(source).toContain('connectDevice');
    // The machinery lives in the module only.
    expect(source).not.toContain('registerCloudDevice');
    expect(source).not.toContain('listCloudDevices');
    expect(source).not.toContain('spawn');
    expect(source).not.toContain('writeFileSync');
    expect(source).not.toContain('daemon.js`');
  });
});
