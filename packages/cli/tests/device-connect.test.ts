// Behavior tests for the device-connect module: the once-per-invocation
// prompt latch with a cached device answer, the persisted don't-ask-again
// config key, the session-daemon lifecycle (spawned tied to the CLI, killed
// on exit, no-op next to a persistent daemon), connectDevice against a stub
// cloud origin, and the desktop command staying a thin shell over the module.
// Env-dependent paths (KINU_HOME) run in subprocesses like config.test.ts.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server, Subprocess } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import type { CloudDevice } from '../src/cloud-api';
import { CloudAgentClient } from '../src/cloud-agent-client';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');
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
  devices?: () => CloudDevice[];
  /** Body appended to a protocol-shaped daemon source. */
  daemonScript?: string;
  /** Raw source for integrity-refusal cases. */
  rawDaemonScript?: string;
  daemonChecksum?: string;
  daemonDownloadGate?: { release: Promise<void>; onArrival?: () => void };
  registrationFailure?: { status: number; error: string };
  /** The registration body, so a test can assert the NAME the CLI sent. */
  onRegister?: (body: { label?: string }) => void;
}

/** Minimal cloud origin: device register/list plus /pc/daemon.js. */
function startStubCloud(opts: StubCloudOptions = {}): StubCloud {
  const hits = { register: 0, list: 0, daemonScript: 0 };
  const daemonSource = opts.rawDaemonScript ?? [
    '// /pc/connect-ticket',
    "const daemonCancelProtocol = 'execCancel';",
    "const daemonRotationProtocol = 'ROTATE';",
    opts.daemonScript ?? 'setInterval(() => {}, 1000);',
  ].join('\n');
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === '/api/cli/devices' && req.method === 'POST') {
        hits.register += 1;
        const body = v.safeParse(v.object({ label: v.optional(v.string()) }), await req.json());
        opts.onRegister?.(body.success ? body.output : {});
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
        if (opts.daemonDownloadGate) {
          opts.daemonDownloadGate.onArrival?.();
          await opts.daemonDownloadGate.release;
        }
        const headers = new Headers({ 'content-type': 'text/javascript' });
        if (opts.daemonChecksum !== undefined) headers.set('x-kinu-daemon-sha256', opts.daemonChecksum);
        return new Response(daemonSource, { headers });
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
    env: { ...process.env, ...environment, KINU_HOME: home },
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

function connectedDevice(connected: boolean): CloudDevice {
  return {
    id: 'dev_1',
    label: 'laptop',
    os: 'linux',
    hostname: 'box',
    connected,
    createdAt: 0,
    lastSeenAt: null,
  };
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
  test('connectDevice session mode installs, verifies, and kills the daemon with the CLI', async () => {
    // The fake daemon records its pid, then idles until SIGTERM.
    const daemonScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.env.KINU_HOME, 'fake-daemon.pid'), String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const stub = startStubCloud({ devices: () => [connectedDevice(true)], daemonScript });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const out = await runScript(home, `
      import { connectDevice, daemonStatus } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: '${stub.origin}', token: 'ptc_test' }, { session: true });
      console.log(JSON.stringify({ result, status: daemonStatus() }));
      process.exit(0);
    `);

    const { result, status } = v.parse(v.object({
      result: v.object({ kind: v.string(), deviceId: v.string() }),
      status: v.object({ sessionActive: v.boolean(), persistentPid: v.nullable(v.number()) }),
    }), JSON.parse(out.trim()));
    expect(result).toEqual({ kind: 'connected', deviceId: 'dev_1' });
    expect(status.sessionActive).toBe(true);
    expect(status.persistentPid).toBeNull(); // session mode never writes a pidfile
    expect(existsSync(join(home, 'pc-agent.pid'))).toBe(false);

    // The daemon files came from the stub, not a reimplementation.
    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(1);
    const deviceConfig = parseJsonObject(readFileSync(join(home, 'device.json'), 'utf-8'));
    expect(deviceConfig).toEqual({ user: 'user_1', token: 'device-token', origin: stub.origin });
    expect(statSync(join(home, 'pc-agent.js')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'device.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);

    // The CLI process exited — its exit hook must have killed the session daemon.
    const daemonPid = Number(readFileSync(join(home, 'fake-daemon.pid'), 'utf-8').trim());
    expect(daemonPid).toBeGreaterThan(0);
    expect(await waitForPidExit(daemonPid)).toBe(true);
  });

  test('session mode is a no-op while a persistent daemon is running', async () => {
    const stub = startStubCloud({ devices: () => [connectedDevice(false)] });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    // A live "persistent daemon": a sleeper owned by the test, via the pidfile.
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
    // No takeover: nothing registered, downloaded, or killed.
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
    expect(sleeper.killed).toBe(false);
    expect(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim()).toBe(String(sleeper.pid));
  });
});

describe('device-connect install hardening', () => {
  test('refuses a checksum mismatch before replacing a complete prior install', async () => {
    const stub = startStubCloud({
      devices: () => [connectedDevice(true)],
      daemonChecksum: '0'.repeat(64),
    });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const oldScript = '// retained daemon\n';
    const oldConfig = '{"user":"old","token":"old-token","origin":"https://old.example"}\n';
    writeFileSync(join(home, 'pc-agent.js'), oldScript, { mode: 0o700 });
    writeFileSync(join(home, 'device.json'), oldConfig, { mode: 0o600 });

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('checksum verification');
    expect(failure).not.toContain('device-token');
    expect(readFileSync(join(home, 'pc-agent.js'), 'utf-8')).toBe(oldScript);
    expect(readFileSync(join(home, 'device.json'), 'utf-8')).toBe(oldConfig);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  test('rejects a structurally invalid daemon before publishing either install file', async () => {
    const stub = startStubCloud({
      devices: () => [connectedDevice(true)],
      rawDaemonScript: '<html>upstream gateway error</html>',
    });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('integrity verification');
    expect(failure).not.toContain('device-token');
    expect(existsSync(join(home, 'pc-agent.js'))).toBe(false);
    expect(existsSync(join(home, 'device.json'))).toBe(false);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  test('classifies a duplicate device name without downloading or installing anything', async () => {
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

    expect(out.trim()).toContain('supports Linux and macOS');
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
  });

  test('uses the running Bun when Node is absent from PATH', async () => {
    const daemonScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.env.KINU_HOME, 'bun-daemon.pid'), String(process.pid));
      fs.writeFileSync(path.join(process.env.KINU_HOME, 'bun-daemon.runtime'), process.versions.bun ? 'bun' : 'node');
      setInterval(() => {}, 1000);
    `;
    const stub = startStubCloud({ devices: () => [connectedDevice(true)], daemonScript });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });
    const pathWithoutNode = mkdtempSync(join(tmpdir(), 'kinu-no-node-'));
    tempDirs.push(pathWithoutNode);

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      console.log(JSON.stringify(result));
      process.exit(0);
    `, { PATH: pathWithoutNode });

    expect(JSON.parse(out.trim())).toEqual({ kind: 'connected', deviceId: 'dev_1' });
    const daemonPid = Number(readFileSync(join(home, 'bun-daemon.pid'), 'utf-8').trim());
    expect(daemonPid).toBeGreaterThan(0);
    expect(readFileSync(join(home, 'bun-daemon.runtime'), 'utf-8')).toBe('bun');
    deviceDaemonPids.push(daemonPid);
  });

  test('runs the daemon on the CLI Bun even when a WebSocket-less node sits on PATH', async () => {
    // The Mac defect: a PATH node that answers --version but has no global
    // WebSocket won daemonRuntime's probe and killed the daemon at startup.
    // The daemon's runtime is the Bun running this CLI — a PATH node is never
    // consulted, and this test's stub records every invocation to prove it.
    const daemonScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.env.KINU_HOME, 'stub-proof.runtime'), process.versions.bun ? 'bun' : 'node');
      setInterval(() => {}, 1000);
    `;
    const stub = startStubCloud({ devices: () => [connectedDevice(true)], daemonScript });
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

    const out = await runScript(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      console.log(JSON.stringify(result));
      process.exit(0);
    `, { PATH: stubDir });

    expect(JSON.parse(out.trim())).toEqual({ kind: 'connected', deviceId: 'dev_1' });
    // The stub node answered --version and was still never chosen.
    const calls = existsSync(`${join(stubDir, 'node')}.calls`)
      ? readFileSync(`${join(stubDir, 'node')}.calls`, 'utf-8')
      : '';
    expect(calls).toBe('');
    expect(readFileSync(join(home, 'stub-proof.runtime'), 'utf-8')).toBe('bun');
    const pidFile = join(home, 'pc-agent.pid');
    expect(existsSync(pidFile)).toBe(false); // session mode: no pidfile
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

  test('fails fast when a verified but stale daemon exits at startup', async () => {
    const stub = startStubCloud({
      devices: () => [connectedDevice(true)],
      daemonScript: 'process.exit(17);',
    });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const failure = await scriptFailure(home, `
      import { connectDevice } from './packages/cli/src/device-connect.ts';
      try {
        await connectDevice({ origin: ${JSON.stringify(stub.origin)}, token: 'ptc_test' }, { session: true });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `);

    expect(failure).toContain('exited before it could connect');
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

    expect(JSON.parse(out.trim())).toEqual({ kind: 'connected', deviceId: 'dev_1' });
    expect(sleeper.killed).toBe(false);
    expect(tolerate(() => {
      process.kill(sleeper.pid, 0);
      return true;
    }, 'esrch')).toBe(true);
    const daemonPid = Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim());
    expect(daemonPid).toBeGreaterThan(0);
    deviceDaemonPids.push(daemonPid);
  });

  test('concurrent installs leave one daemon owner and no partial files', async () => {
    const release = Promise.withResolvers<void>();
    const bothDownloadsArrived = Promise.withResolvers<void>();
    let arrivals = 0;
    const daemonScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.appendFileSync(path.join(process.env.KINU_HOME, 'concurrent-daemon.pids'), String(process.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const stub = startStubCloud({
      devices: () => [connectedDevice(true)],
      daemonScript,
      daemonDownloadGate: {
        release: release.promise,
        onArrival() {
          arrivals += 1;
          if (arrivals === 2) bothDownloadsArrived.resolve();
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
    await bothDownloadsArrived.promise;
    release.resolve();

    const settled = await outcomes;
    expect(settled.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const started = [...new Set(
      readFileSync(join(home, 'concurrent-daemon.pids'), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number),
    )];
    const live = started.filter((pid) => tolerate(() => {
      process.kill(pid, 0);
      return true;
    }, 'esrch') === true);
    expect(live).toHaveLength(1);
    expect(Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim())).toBe(live[0]);
    expect(readdirSync(home).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    deviceDaemonPids.push(...live);
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

  /** Interactive PTY chat: answer prompts only after they appear. */
  function spawnChatInPty(home: string) {
    const cliBin = resolve(repoRoot, 'packages/cli/bin/cli.ts');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const command = [
      `KINU_HOME=${quote(home)}`,
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
    const daemonScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.env.KINU_HOME, 'fake-daemon.pid'), String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const stub = startStubCloud({
      devices: () => (registered ? [connectedDevice(true)] : []),
      daemonScript,
      onRegister: () => { registered = true; },
    });
    const home = makeHome(cloudAgentConfig(stub.origin));

    const chat = spawnChatInPty(home);
    await chat.waitFor('Let this agent use this PC?');
    await chat.waitFor("[c] connect & keep connected · [s] this session only · [n] not now · [d] don't ask again");
    await chat.send('s');
    await chat.waitFor('Connected for this session.');
    await chat.send('/exit');
    await chat.proc.exited;
    await chat.drained;

    expect(stub.hits.register).toBe(1);
    expect(stub.hits.daemonScript).toBe(1);
    expect(existsSync(join(home, 'pc-agent.pid'))).toBe(false); // session, not persistent

    // The CLI exited; its exit hook must have killed the session daemon.
    const daemonPid = Number(readFileSync(join(home, 'fake-daemon.pid'), 'utf-8').trim());
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
    expect(stdout).toContain('No PC is connected for device access. Connect one with: kinu connect');
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

  const IDLE_DAEMON = `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(process.env.KINU_HOME, 'fake-daemon.pid'), String(process.pid));
    setInterval(() => {}, 1000);
  `;

  test('it states what access it grants, registers under the name given, and links', async () => {
    let registered = false;
    let label: string | undefined;
    const stub = startStubCloud({
      devices: () => (registered ? [connectedDevice(true)] : []),
      daemonScript: IDLE_DAEMON,
      onRegister: (body) => { registered = true; label = body?.label; },
    });
    const home = makeHome({ origin: stub.origin, accessToken: 'ptc_test' });

    const connect = spawnConnectInPty(home);
    // The terms come BEFORE anything is installed.
    await connect.waitFor('Connecting installs the Kinu daemon on this machine');
    await connect.waitFor('revoke it any time under Account settings');
    await connect.waitFor('Name this device');
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);

    await connect.send('studio tower');
    await connect.waitFor('Link this machine as "studio tower" and start the daemon?');
    expect(stub.hits.register).toBe(0); // still nothing, the question is unanswered

    await connect.send('y');
    await connect.waitFor('Connected this machine as');
    await connect.proc.exited;
    await connect.drained;

    expect(connect.output()).toContain('studio tower');
    expect(stub.hits.register).toBe(1);
    expect(label).toBe('studio tower');
    expect(existsSync(join(home, 'device.json'))).toBe(true);

    const daemonPid = Number(readFileSync(join(home, 'fake-daemon.pid'), 'utf-8').trim());
    process.kill(daemonPid, 'SIGTERM');
    expect(await waitForPidExit(daemonPid)).toBe(true);
  }, 30_000);

  test('answering no installs nothing at all', async () => {
    const stub = startStubCloud({ devices: () => [], daemonScript: IDLE_DAEMON });
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
