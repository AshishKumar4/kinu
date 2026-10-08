import { readText } from '@nimbus-sh/core/vfs/vfs.js';
/** Device daemon self-update, and the frames it shares with the hub, with the hub faked at its two seams (helpers/update-hub.ts). */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { present, killAndAwaitExit, recordedIn, scratchDir } from '@kinu.run/test-utils';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  bunResolutionShell, deviceFiles, DEVICE_EXEC_ACK_METHOD, DEVICE_TOKEN_ROTATION_ACK, JsonValueSchema,
  parseJsonObject, type DeviceStatus, type DeviceTransport, type JsonObject,
} from '@kinu.run/core';
import {
  DAEMON_FILES, daemonArchive, PLATFORM_ARTIFACT, releaseSigningEnv, ROTATED_TOKEN, startUpdateHub,
  type HubPush, type HubSocket, type UpdateHub,
} from './helpers/update-hub';
import { readProcessOutput, waitForDaemonPid, waitForFileText } from './helpers/device-process';

const repoRoot = resolve(__dirname, '../../..');

const OLD = '1.0.0+old';

const NEW = '2.0.0+new';

const NEW_DAEMON = `${DAEMON_FILES['pc-agent.js']}\n// build ${NEW}\n`;

const NEW_FILES = { ...DAEMON_FILES, 'pc-agent.js': NEW_DAEMON };

const hubs: UpdateHub[] = [];

/** Homes minted; teardown re-reads each pidfile, which names the owner after a handover. */
const homes: string[] = [];

const mintedHomes: string[] = [];

const daemons: Subprocess[] = [];

const alive = (pid: number) => tolerate(() => {
  process.kill(pid, 0);

  return true;
}, 'esrch') === true;

afterAll(() => {
  // Every daemon this suite caused must be dead before the shared scratch release removes the tree.
  for (const home of mintedHomes) {
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
  }
});

afterEach(async () => {
  // Each daemon writes into its home until it exits.
  for (const proc of daemons.splice(0)) {
    proc.kill('SIGKILL');
    await proc.exited;
  }

  // After a handover only the pidfile names the owning daemon.
  for (const home of homes.splice(0)) {
    const daemon = recordedIn(join(home, 'pc-agent.pid'));

    if (daemon !== null) await killAndAwaitExit(daemon);
  }

  await Promise.all(hubs.splice(0).map((started) => started.close()));
});

function hub(opts: Parameters<typeof startUpdateHub>[0]): UpdateHub {
  const started = startUpdateHub(opts);
  hubs.push(started);

  return started;
}

function installedMachine(origin: string, stamp: string | null, config: JsonObject = {}): string {
  const home = scratchDir('daemon-update');
  homes.push(home);
  mintedHomes.push(home);

  for (const [name, source] of Object.entries(DAEMON_FILES)) writeFileSync(join(home, name), source, { mode: 0o700 });

  if (stamp !== null) writeFileSync(join(home, 'pc-agent.version'), `${stamp}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'device.json'), `${JSON.stringify({ user: 'user_1', token: `pdt_${'a'.repeat(32)}`, origin })}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return home;
}

function startDaemon(home: string, extraEnv: Record<string, string> = {}) {
  const logPath = join(home, 'pc-agent.log');
  const logFd = Bun.file(logPath);

  const proc = Bun.spawn({
    cmd: [process.execPath, join(home, 'pc-agent.js')],
    cwd: home,
    env: { ...process.env, KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight'), ...extraEnv },
    stdout: logFd,
    stderr: logFd,
    stdin: 'ignore',
  });

  daemons.push(proc);

  return {
    proc,
    log: () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : ''),
    waitForLog: (text: string) => waitForFileText(logPath, text, proc.exited),
  };
}

/**
 * A daemon whose log is read from a pipe as it is written, a successor's lines included: the successor writes to
 * the stdout it inherits. A watched file can miss a line written the moment its watch begins.
 */
function startPipedDaemon(home: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(home, 'pc-agent.js')],
    cwd: home,
    env: { ...process.env, KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight'), ...extraEnv },
    stdout: 'pipe',
    stderr: Bun.file(join(home, 'pc-agent.log')),
    stdin: 'ignore',
  });

  daemons.push(proc);
  const output = readProcessOutput(proc.stdout);

  return { proc, log: output.output, waitForLog: output.waitFor };
}

const pidfile = (home: string) => Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim());

/** The Bun the launcher installs, read from the resolution it ships. */
const APPROVED_BUN = present(/KINU_BUN_VERSION="([^"]+)"/.exec(bunResolutionShell())?.[1], 'the approved Bun');

/**
 * A machine whose own Bun is 1.4.0, the launcher's Bun before the pin moved. Today's code stands in for the field's
 * older daemon, which never looked at its runtime, so only the process that daemon's updater starts (it names its
 * predecessor) reads 1.4.0; the Bun installed under $KINU_HOME/runtime reads as itself. bun.sh's installer is a
 * stand-in on PATH that puts this suite's own Bun there, or fails as curl does without a network. No other Bun is on
 * PATH or under $HOME, so the launcher's resolution finds none.
 */
function olderBunMachine(home: string, bunSh: 'installs' | 'unreachable') {
  const standIns = join(home, 'stand-ins');
  const userHome = join(home, 'user-home');
  mkdirSync(standIns);
  mkdirSync(userHome);

  const olderBun = join(home, 'older-bun.js');
  writeFileSync(olderBun, [
    `if (process.env.KINU_DAEMON_PREDECESSOR !== undefined && process.execPath !== ${JSON.stringify(join(home, 'runtime/bin/bun'))}) {`,
    "  process.versions.bun = '1.4.0';",
    '}',
    '',
  ].join('\n'));

  const curl = bunSh === 'installs'
    ? [
      '#!/bin/sh',
      "cat <<'INSTALLER'",
      `[ "$1" = "bun-v${APPROVED_BUN}" ] || { echo "asked for $1" >&2; exit 1; }`,
      `mkdir -p "$BUN_INSTALL/bin" && cp ${JSON.stringify(process.execPath)} "$BUN_INSTALL/bin/bun"`,
      'INSTALLER',
    ]
    : ['#!/bin/sh', 'echo "curl: (6) Could not resolve host: bun.sh" >&2', 'exit 6'];

  writeFileSync(join(standIns, 'curl'), `${curl.join('\n')}\n`, { mode: 0o755 });

  const path = (process.env.PATH ?? '').split(':').filter((dir) => dir !== '' && !existsSync(join(dir, 'bun')));

  return { PATH: [standIns, ...path].join(':'), HOME: userHome, BUN_OPTIONS: `--preload ${olderBun}` };
}

const installed = (home: string, name: string) => readFileSync(join(home, name), 'utf-8');


describe('the daemon updates itself on the hub\'s UPDATE frame', () => {
  test('HELLO names the build, the platform, the runtime and the opt-out state; a current build gets no UPDATE', async () => {
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());

    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    expect(socket.hello).toMatchObject({
      type: 'HELLO', version: OLD, os: process.platform, arch: process.arch, runtime: `Bun ${Bun.version}`, updateCheck: true,
    });
    await socket.settle();
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(daemon.log()).not.toContain('device.update_started');
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
  });

  test('a behind build is landed, selftested, started as a successor; the old daemon stays until replaced', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startPipedDaemon(home, await releaseSigningEnv());
    const oldPid = await waitForDaemonPid(home);

    await served.sockets.until((hellos) => hellos[1] !== undefined);
    const successor = present(served.sockets.items[1], 'the successor HELLO');
    expect(successor.hello).toMatchObject({ version: NEW, updateCheck: true });
    expect(served.sockets.items[0]?.closed).toBe('hub');
    expect(await daemon.proc.exited).toBe(0);
    expect(daemon.log()).toContain('device.update_handed_over');

    // The successor learns of that exit from its stdin, the lifeline the OS closes when the old daemon ends, and
    // not from a clock: its line follows the old daemon's last one.
    await daemon.waitForLog(`device.predecessor_exited pid ${String(oldPid)}`);
    expect(daemon.log().indexOf('device.update_handed_over')).toBeLessThan(daemon.log().indexOf('device.predecessor_exited'));

    const newPid = pidfile(home);
    expect(newPid).not.toBe(oldPid);
    expect(alive(newPid)).toBe(true);
    expect(alive(oldPid)).toBe(false);

    expect(installed(home, 'pc-agent.js')).toBe(NEW_DAEMON);
    expect(installed(home, 'pc-agent.js.prev')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'sandbox.js.prev')).toBe(DAEMON_FILES['sandbox.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(NEW);
    expect(installed(home, 'pc-agent.version.prev').trim()).toBe(OLD);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([PLATFORM_ARTIFACT, `${PLATFORM_ARTIFACT}.sha256`]);
    await successor.settle();
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toHaveLength(2);
  });


  test('THE TROJAN PROBE: a hub-chosen checksum with no Kinu signature downloads nothing', async () => {
    // SECURITY-devices C1: an unsigned frame naming a trojaned tarball is refused before any byte is fetched.
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW), signing: 'none' });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    await socket.settle();
    await daemon.waitForLog('device.update_ignored reason=malformed_frame detail=no signature');

    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(served.sockets.items).toHaveLength(1);
  });

  test('a release signed by a key that is not the pinned one is refused the same way', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW), signing: 'foreign' });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    await socket.settle();
    await daemon.waitForLog('device.update_ignored reason=bad_signature');

    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
  });

  test('a daemon on the production pin refuses the test key: the pin is the build\'s, not the environment\'s', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home);
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    await socket.settle();
    await daemon.waitForLog('device.update_ignored reason=bad_signature');

    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
  });

  test('a corrupt archive (checksum mismatch) lands nothing; the old daemon keeps the machine', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW), corrupt: true });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());

    await daemon.waitForLog('device.update_failed');
    expect(daemon.log()).toContain(`checksum mismatch for ${PLATFORM_ARTIFACT}`);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.js.new'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(served.sockets.items).toHaveLength(1);
    expect(served.sockets.items[0]?.closed).toBeNull();
    expect(alive(pidfile(home))).toBe(true);
  });

  test('a landed daemon that fails its selftest is rolled back to .prev; no successor starts', async () => {
    const broken = { ...DAEMON_FILES, 'pc-agent.js': 'process.exit(7);\n' };
    const served = hub({ served: NEW, archive: await daemonArchive(broken, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());

    await daemon.waitForLog('device.update_failed');
    expect(daemon.log()).toContain('failed its selftest; the previous build was restored');
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    expect(served.sockets.items).toHaveLength(1);
    expect(alive(pidfile(home))).toBe(true);
  });

  test('updateCheck: false — HELLO says so, and an UPDATE pushed anyway is refused', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW), pushAlways: true });
    const home = installedMachine(served.origin, OLD, { updateCheck: false });
    const daemon = startDaemon(home, await releaseSigningEnv());

    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    expect(socket.hello).toMatchObject({ version: OLD, updateCheck: false });
    await daemon.waitForLog('device.update_ignored reason=updateCheck_false');
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
  });

  test('HELLO names the build this process IS, not the stamp on disk now', async () => {
    // Re-reading the stamp at each HELLO would report the new build from old code after a failed successor.
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const first = present(served.sockets.items[0], 'the HELLO');
    expect(first.hello.version).toBe(OLD);

    writeFileSync(join(home, 'pc-agent.version'), `${NEW}\n`, { mode: 0o600 });
    first.drop();
    await served.sockets.until((hellos) => hellos[1] !== undefined);
    const again = present(served.sockets.items[1], 'the second HELLO');

    expect(again.hello.version).toBe(OLD);
  });

  test('a hostile frame — an off-origin url, or a checksum that is not one — lands nothing', async () => {
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    const sha256 = 'a'.repeat(64);

    socket.send({ type: 'UPDATE', version: NEW, urls: { tarball: 'https://evil.invalid/cli.tar.gz', checksum: `${PLATFORM_ARTIFACT}.sha256` }, sha256 });
    socket.send({ type: 'UPDATE', version: NEW, urls: { tarball: PLATFORM_ARTIFACT, checksum: `${PLATFORM_ARTIFACT}.sha256` }, sha256: 'not-a-digest' });
    await socket.settle();

    expect(daemon.log().match(/device\.update_ignored reason=malformed_frame/g)).toHaveLength(2);
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
  });

  test('a daemon without a stamp sends no version and is left alone', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, null);
    startDaemon(home, await releaseSigningEnv());

    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    expect('version' in socket.hello).toBe(false);
    await socket.settle();
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
  });
});

/** What a daemon reports in HELLO beyond its build: where it keeps agent homes, and what it proved it can sandbox. */
const ProvedHelloSchema = v.looseObject({
  agentRoot: v.string(),
  sandbox: v.looseObject({ capability: v.string() }),
});

const ExecResultSchema = v.object({ stdout: v.string(), stderr: v.string(), exitCode: v.number() });

const ReplySchema = v.object({ id: v.string(), result: v.optional(JsonValueSchema), error: v.optional(v.object({ code: v.string(), message: v.string() })) });

type FrameSandbox = NonNullable<Extract<HubPush, { method: string }>['sandbox']>;

/** Core's device transport over the fake hub's socket: every call carries the block, and its answer is the daemon's own. */
function tunnelOver(socket: HubSocket, sandbox: FrameSandbox): DeviceTransport {
  const connected: DeviceStatus = { connected: true, registered: true, toolchain: null };
  let next = 0;

  return {
    status: () => connected,
    refreshStatus: async () => connected,
    rpc: async (method, params, opts) => {
      const id = opts?.requestId ?? `rpc-spillfile0-${String(next += 1)}`;
      socket.send({ id, method, params, sandbox });
      const reply = v.parse(ReplySchema, await socket.waitForReply(id));

      if (reply.error !== undefined) throw new Error(reply.error.message);

      return reply.result;
    },
  };
}

// The daemon is one dependency-free file and cannot import core's frame names or its file client;
// driven by a hub that speaks them, it must answer in them.
describe('the daemon answers the hub in core\'s frames', () => {
  test('a rotated token is on disk when the daemon acknowledges it', async () => {
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    startDaemon(home, await releaseSigningEnv());

    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    await socket.frames.until((frames) => frames.some((frame) => frame.type === DEVICE_TOKEN_ROTATION_ACK));;

    expect(parseJsonObject(installed(home, 'device.json')).token).toBe(ROTATED_TOKEN);
  });

  test('a sandboxed command\'s whole output reads back through core\'s file client at the /tmp path it printed', async () => {
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');
    const proved = v.parse(ProvedHelloSchema, socket.hello);

    // What the machine proved at start: one that cannot sandbox runs no sandboxed command at all.
    if (proved.sandbox.capability !== 'sandboxed') return;
    const project = scratchDir('daemon-spill-project');
    // As the hub composes it for a workspace: `<agentRoot>/<workspace>/home`, plus the directory named at `kinu connect`.
    const block = { tier: 'sandboxed' as const, agentHome: join(proved.agentRoot, 'ws-spill', 'home'), roots: [project] };
    const tunnel = tunnelOver(socket, block);

    const files = deviceFiles(tunnel, {
      consentedRoot: async () => project,
      deviceHome: async () => null,
      scope: async () => 'sandboxed',
    });

    const requestId = 'rpc-spillread0-1';
    // System tools only: the runtime that runs this suite lives in a home the sandbox hides.
    const noisy = "head -c 600000 /dev/zero | tr '\\0' x; printf END";
    const ran = v.parse(ExecResultSchema, await tunnel.rpc('exec', [noisy], { requestId }));
    const shown = '/tmp/kinu-tool-output/device-rpc-spillread0-1.stdout.log';

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(`the full stdout is at ${shown}]`);
    expect(await readText(files, shown)).toBe(`${'x'.repeat(600_000)}END`);
    await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [requestId]);
  });
});

// What a dropped socket left running could answer no one, and nothing could name, stop or observe it again.
describe('a socket the hub drops', () => {
  test('ends the command it left unanswered, the process group the command started included', async () => {
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);
    const socket = present(served.sockets.items[0], 'the HELLO');

    // Both FIFOs are open for reading before the command runs. `started` ends once a descendant of the command holds
    // `life` open; `life` ends only once no process holds it, so a group left running is a read that never ends.
    const dir = scratchDir('daemon-dropped-socket');
    const [started, life] = [join(dir, 'started'), join(dir, 'life')];
    execFileSync('mkfifo', [started, life]);
    const begun = readFile(started, 'utf8');
    const ended = readFile(life, 'utf8');

    socket.send({
      id: 'rpc-dropsocket-1',
      method: 'exec',
      params: [`(exec 3>'${life}'; echo up >'${started}'; exec sleep 600) & sleep 600`],
      sandbox: { tier: 'raw', agentHome: '', roots: [] },
    });

    expect(await begun).toBe('up\n');
    socket.drop();
    expect(await ended).toBe('');
  });
});

describe('a release that needs a newer Bun than the machine runs', () => {
  test('a 1.4.0 daemon given this release ends up serving on the approved Bun, not rolled back', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startPipedDaemon(home, { ...(await releaseSigningEnv()), ...olderBunMachine(home, 'installs') });
    const oldPid = await waitForDaemonPid(home);

    await served.sockets.until((hellos) => hellos[1] !== undefined);
    const successor = present(served.sockets.items[1], 'the successor HELLO');
    expect(successor.hello).toMatchObject({ version: NEW, runtime: `Bun ${Bun.version}` });
    expect(await daemon.proc.exited).toBe(0);
    expect(daemon.log()).toContain('device.update_handed_over');
    expect(daemon.log()).not.toContain('device.update_rolled_back');

    // The process the old updater started is the one serving, gone on as the Bun the launcher's install put in place.
    const started = Number(present(/device\.update_successor_started pid=(\d+)/.exec(daemon.log())?.[1], 'the successor pid'));
    expect(pidfile(home)).toBe(started);
    expect(started).not.toBe(oldPid);
    expect(realpathSync(`/proc/${String(started)}/exe`)).toBe(join(realpathSync(home), 'runtime/bin/bun'));
    expect(installed(home, 'pc-agent.js')).toBe(NEW_DAEMON);
    expect(installed(home, 'pc-agent.version').trim()).toBe(NEW);
    await successor.settle();
  });

  test('a runtime install that fails reaches the hub with its reason, and the old daemon rolls back and serves', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startPipedDaemon(home, { ...(await releaseSigningEnv()), ...olderBunMachine(home, 'unreachable') });
    const oldPid = await waitForDaemonPid(home);

    // The attempt ends at the hub either way: the successor's refusal, or its own HELLO.
    await Promise.race([served.refusals.until((posted) => posted.length > 0), served.sockets.until((hellos) => hellos.length > 1)]);
    expect(served.refusals.items).toEqual([{
      user: 'user_1',
      token: ROTATED_TOKEN,
      version: NEW,
      runtime: 'Bun 1.4.0',
      reason: `this machine runs Bun 1.4.0, and Bun ${APPROVED_BUN} could not be provided: curl: (6) Could not resolve host: bun.sh`,
    }]);

    await daemon.waitForLog('device.update_rolled_back');
    expect(pidfile(home)).toBe(oldPid);
    expect(alive(oldPid)).toBe(true);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(served.sockets.items).toHaveLength(1);
    expect(served.sockets.items[0]?.closed).toBeNull();
  });
});

const DYING_DAEMON = [
  "const fs = require('fs'); const path = require('path');",
  "if (process.argv.includes('--selftest')) {",
  "  console.log(fs.readFileSync(path.join(process.env.KINU_HOME, 'pc-agent.version'), 'utf8').trim());",
  '} else {',
  '  process.exit(9);',
  '}',
  '',
].join('\n');

describe('a successor that dies before connecting is the old daemon\'s to undo', () => {
  test('the old daemon re-takes the pidfile, rolls the files back, clears the marker and keeps serving', async () => {
    const served = hub({ served: NEW, archive: await daemonArchive({ ...NEW_FILES, 'pc-agent.js': DYING_DAEMON }, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const oldPid = await waitForDaemonPid(home);

    await daemon.waitForLog('device.update_rolled_back');

    expect(pidfile(home)).toBe(oldPid);
    expect(alive(oldPid)).toBe(true);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    expect(served.sockets.items[0]?.closed).toBeNull();
    expect(served.sockets.items).toHaveLength(1);

    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', `
        import { daemonStatus } from './packages/cli/src/device-connect.ts';
        console.log(JSON.stringify(daemonStatus()));
      `],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ daemonPid: oldPid });
    expect(pidfile(home)).toBe(oldPid);
  });

  test('a live pidfile means nothing to recover, marker or not', async () => {
    const served = hub({ served: OLD, archive: await daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    await served.sockets.until((hellos) => hellos[0] !== undefined);;
    writeFileSync(join(home, 'pc-agent.js.prev'), 'process.exit(9);\n', { mode: 0o700 });
    writeFileSync(join(home, 'pc-agent.update-pending'), `${NEW}\n`, { mode: 0o600 });

    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', `
        import { daemonStatus } from './packages/cli/src/device-connect.ts';
        console.log(JSON.stringify(daemonStatus()));
      `],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ daemonPid: daemon.proc.pid });
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(true);
  });
});
