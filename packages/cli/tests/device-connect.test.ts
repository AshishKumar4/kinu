// Behavior tests for the device-connect module: the once-per-invocation
// prompt latch with a cached device answer, the persisted don't-ask-again
// config key, the session-daemon lifecycle (spawned tied to the CLI, killed
// on exit, no-op next to a persistent daemon), connectDevice against a stub
// cloud origin, and the desktop command staying a thin shell over the module.
// Env-dependent paths (KINU_HOME) run in subprocesses like config.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server, Subprocess } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseJsonObject, type JsonObject } from '@kinu.run/core';
import type { CloudDevice } from '../src/cloud-api';
import { CloudAgentClient } from '../src/cloud-agent-client';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');
const tempDirs: string[] = [];
const sleepers: Subprocess[] = [];
const stubs: Server<unknown>[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const proc of sleepers.splice(0)) proc.kill();
  for (const server of stubs.splice(0)) server.stop(true);
});

interface StubCloud {
  origin: string;
  hits: { register: number; list: number; daemonScript: number };
}

/** Minimal cloud origin: device register/list plus /pc/daemon.js. */
function startStubCloud(opts: { devices?: () => CloudDevice[]; daemonScript?: string; onRegister?: () => void } = {}): StubCloud {
  const hits = { register: 0, list: 0, daemonScript: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      if (url.pathname === '/api/cli/devices' && req.method === 'POST') {
        hits.register += 1;
        opts.onRegister?.();
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
        return new Response(opts.daemonScript ?? 'setInterval(() => {}, 1000);\n', {
          headers: { 'content-type': 'text/javascript' },
        });
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

async function runScript(home: string, script: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    cwd: repoRoot,
    env: { ...process.env, KINU_HOME: home },
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
    try { process.kill(pid, 0); } catch { return true; }
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
      import { connectDevice, startDaemon } from './packages/cli/src/device-connect.ts';
      const result = await connectDevice({ origin: '${stub.origin}', token: 'ptc_test' }, { session: true });
      console.log(JSON.stringify({ result, started: startDaemon({ session: true }) }));
    `);

    const { result, started } = v.parse(v.object({
      result: v.object({ kind: v.string(), connected: v.boolean() }),
      started: v.object({ started: v.boolean() }),
    }), JSON.parse(out.trim()));
    expect(result).toEqual({ kind: 'already-running', connected: false });
    expect(started).toEqual({ started: false });
    // No takeover: nothing registered, downloaded, or killed.
    expect(stub.hits.register).toBe(0);
    expect(stub.hits.daemonScript).toBe(0);
    expect(sleeper.killed).toBe(false);
    expect(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim()).toBe(String(sleeper.pid));
  });
});

describe('classic cloud chat connect prompt', () => {
  function cloudAgentConfig(origin: string): JsonObject {
    return {
      origin,
      accessToken: 'ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz',
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
      '--no-session',
    ].join(' ');
    const proc = Bun.spawn({
      cmd: ['script', '-qefc', command, '/dev/null'],
      cwd: repoRoot,
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
      send(line: string): void {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
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
    chat.send('s');
    await chat.waitFor('Connected for this session.');
    chat.send('/exit');
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
      cmd: [process.execPath, cliBin, 'chat', 'jarvis', '--no-session'],
      cwd: repoRoot,
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

describe('/connect slash command', () => {
  test('is offered to consent-capable clients and returns the device-connect outcome', async () => {
    const { commandsForClient, executeSlashCommand } = await import('../src/slash-commands');
    const clientOptions = {
      origin: 'https://kinu.invalid', token: 'test', agentName: 'test', cloudName: 'test',
      session: { noSession: true },
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
