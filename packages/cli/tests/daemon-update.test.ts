/**
 * The device daemon updating itself on the hub's UPDATE frame, end to end:
 * the real installed daemon under this Bun against a hub faked at its two
 * seams (see helpers/update-hub.ts). Each case reads what landed on disk,
 * which process holds the machine, and what the daemon logged.
 *
 * Env-dependent paths (KINU_HOME) run in subprocesses like config.test.ts.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { scratchDir } from '@kinu.run/test-utils';
import { tolerate } from '@kinu.run/core/obs';
import type { JsonObject } from '@kinu.run/core';
import {
  DAEMON_FILES, daemonArchive, PLATFORM_ARTIFACT, releaseSigningEnv, startUpdateHub, until, type UpdateHub,
} from './helpers/update-hub';

const repoRoot = resolve(__dirname, '../../..');

const OLD = '1.0.0+old';

const NEW = '2.0.0+new';

/** The new build's daemon: the same program with a different comment, so
 *  its bytes differ from the installed ones and it still runs. */
const NEW_DAEMON = `${DAEMON_FILES['pc-agent.js']}\n// build ${NEW}\n`;

const NEW_FILES = { ...DAEMON_FILES, 'pc-agent.js': NEW_DAEMON };

const hubs: UpdateHub[] = [];

/** Homes this suite minted, so teardown can re-read the pidfile each one
 *  holds NOW — the pidfile, not the spawn handle, is what names the process
 *  currently owning the machine after a handover. */
const homes: string[] = [];

/** Every home minted, for the suite-end release check below. */
const mintedHomes: string[] = [];

const daemons: Subprocess[] = [];

/** Pids known by number only: spawned daemons (the handle does not outlive a
 *  handover), handover successors read off the pidfile, and the one
 *  `daemonStatus` starts. Every process this suite caused lands here — a pid
 *  nothing tracked is the process the scratch release met still writing. */
const ownedPids: number[] = [];

const alive = (pid: number) => tolerate(() => {
  process.kill(pid, 0);

  return true;
}, 'esrch') === true;

async function waitForPidExit(pid: number): Promise<void> {
  await until(() => !alive(pid) || null, `pid ${pid} to exit`);
}

afterAll(() => {
  // Every daemon the suite caused is dead by the time this runs — that is the
  // ownership this file now proves. The shared scratch release checks its own
  // removals, but the failure mode it names (a live process still writing
  // into the tree) is THIS suite's to produce, so the same survive-check runs
  // on each home here, while the suite can still answer for it.
  for (const home of mintedHomes) {
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
  }
});

afterEach(async () => {
  // The pidfile AFTER any handover names the daemon actually holding the
  // machine — which is not the pid the test spawned, and not necessarily the
  // one it recorded: a successor's own successor only exists in that file.
  for (const home of homes.splice(0)) {
    const pidPath = join(home, 'pc-agent.pid');

    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf-8').trim());

      if (alive(pid)) ownedPids.push(pid);
    }
  }

  for (const proc of daemons.splice(0)) tolerate(() => proc.kill('SIGTERM'), 'esrch');

  for (const pid of ownedPids.splice(0)) {
    tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');
    // A fired SIGTERM is a request, not a death: the release that follows the
    // suite removes the tree, and a daemon still exiting then is the live
    // process that held it. Wait for the exit the signal was meant to cause.
    await waitForPidExit(pid);
  }

  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

function hub(opts: Parameters<typeof startUpdateHub>[0]): UpdateHub {
  const started = startUpdateHub(opts);
  hubs.push(started);

  return started;
}

/** An installed machine: the daemon files this CLI ships, its stamp, the
 *  device config naming `origin`, and the CLI config. */
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

/** The daemon as the CLI starts it: the installed file under this Bun,
 *  output to the log file the CLI would give it. */
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
  ownedPids.push(proc.pid);

  return {
    proc,
    log: () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : ''),
  };
}

const pidfile = (home: string) => Number(readFileSync(join(home, 'pc-agent.pid'), 'utf-8').trim());

const installed = (home: string, name: string) => readFileSync(join(home, name), 'utf-8');

async function waitForExit(proc: Subprocess, timeoutMs = 15_000): Promise<number | 'still running'> {
  return Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => 'still running' as const)]);
}

describe('the daemon updates itself on the hub\'s UPDATE frame', () => {
  test('HELLO names the build, the platform and the opt-out state; a current build gets no UPDATE', async () => {
    const served = hub({ served: OLD, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());

    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    expect(socket.hello).toMatchObject({ type: 'HELLO', version: OLD, os: process.platform, arch: process.arch, updateCheck: true });
    // Nothing was pushed and nothing downloaded: the daemon keeps its files.
    await socket.settle();
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(daemon.log()).not.toContain('device.update_started');
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
  });

  test('a behind build is landed, selftested, started as a successor; the old daemon stays until replaced', async () => {
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const oldPid = await until(() => (existsSync(join(home, 'pc-agent.pid')) ? pidfile(home) : null), 'the pidfile', daemon.log);

    // The successor's HELLO names the new build.
    const successor = await until(() => served.sockets[1], 'the successor HELLO', daemon.log);
    expect(successor.hello).toMatchObject({ version: NEW, updateCheck: true });
    // The old daemon held its socket until the hub replaced it — it never
    // disconnected on its own — and then exited 0.
    expect(served.sockets[0]?.closed).toBe('hub');
    expect(await waitForExit(daemon.proc)).toBe(0);
    expect(daemon.log()).toContain('device.update_handed_over');

    // The machine is the successor's: the pidfile names a live process that
    // is not the old one, and the old pid is gone.
    const newPid = pidfile(home);
    expect(newPid).not.toBe(oldPid);
    expect(alive(newPid)).toBe(true);
    expect(alive(oldPid)).toBe(false);
    ownedPids.push(newPid);

    // What landed: the archive's files, each with its `.prev`, and the stamp.
    expect(installed(home, 'pc-agent.js')).toBe(NEW_DAEMON);
    expect(installed(home, 'pc-agent.js.prev')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'sandbox.js.prev')).toBe(DAEMON_FILES['sandbox.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(NEW);
    expect(installed(home, 'pc-agent.version.prev').trim()).toBe(OLD);
    // The successor connected, so the pending marker is cleared.
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    // The download went to the same origin, both halves, once.
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([PLATFORM_ARTIFACT, `${PLATFORM_ARTIFACT}.sha256`]);
    // The successor's own HELLO earned no second UPDATE: it is the served build.
    await successor.settle();
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toHaveLength(2);
  });

  test('THE TROJAN PROBE: a hub-chosen checksum with no Kinu signature downloads nothing', async () => {
    // SECURITY-devices C1, the audit's own probe: a fake hub serving a
    // trojaned tarball whose sha256 the frame names. Before, the daemon
    // downloaded it, ran its selftest (arbitrary code, as the user) and
    // started it as the successor. Now the frame is refused before any
    // byte is fetched, on the signature it does not carry.
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW), signing: 'none' });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    await socket.settle();
    await until(() => (daemon.log().includes('device.update_ignored reason=malformed_frame detail=no signature') ? true : null), 'the refusal', daemon.log);

    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(served.sockets).toHaveLength(1);
  });

  test('a release signed by a key that is not the pinned one is refused the same way', async () => {
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW), signing: 'foreign' });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    await socket.settle();
    await until(() => (daemon.log().includes('device.update_ignored reason=bad_signature') ? true : null), 'the refusal', daemon.log);

    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
  });

  test('a daemon on the production pin refuses the test key: the pin is the build\'s, not the environment\'s', async () => {
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home);
    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    await socket.settle();
    await until(() => (daemon.log().includes('device.update_ignored reason=bad_signature') ? true : null), 'the refusal', daemon.log);

    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
  });

  test('a corrupt archive (checksum mismatch) lands nothing; the old daemon keeps the machine', async () => {
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW), corrupt: true });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());

    await until(() => daemon.log().includes('device.update_failed'), 'the update to fail', daemon.log);
    expect(daemon.log()).toContain(`checksum mismatch for ${PLATFORM_ARTIFACT}`);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.js.new'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(served.sockets).toHaveLength(1);
    expect(served.sockets[0]?.closed).toBeNull();
    expect(alive(pidfile(home))).toBe(true);
  });

  test('a landed daemon that fails its selftest is rolled back to .prev; no successor starts', async () => {
    const broken = { ...DAEMON_FILES, 'pc-agent.js': 'process.exit(7);\n' };
    const served = hub({ served: NEW, archive: daemonArchive(broken, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());

    await until(() => daemon.log().includes('device.update_failed'), 'the update to fail', daemon.log);
    expect(daemon.log()).toContain('failed its selftest; the previous build was restored');
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    expect(served.sockets).toHaveLength(1);
    expect(alive(pidfile(home))).toBe(true);
  });

  test('updateCheck: false — HELLO says so, and an UPDATE pushed anyway is refused', async () => {
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW), pushAlways: true });
    const home = installedMachine(served.origin, OLD, { updateCheck: false });
    const daemon = startDaemon(home, await releaseSigningEnv());

    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    expect(socket.hello).toMatchObject({ version: OLD, updateCheck: false });
    await until(() => daemon.log().includes('device.update_ignored reason=updateCheck_false'), 'the refusal', daemon.log);
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
  });

  test('HELLO names the build this process IS, not the stamp on disk now', async () => {
    // An update lands its stamp before the successor connects; a daemon that
    // re-read the file at each HELLO would report the new build from old
    // code after a successor died, and the hub would never push that
    // version again.
    const served = hub({ served: OLD, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const first = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    expect(first.hello.version).toBe(OLD);

    writeFileSync(join(home, 'pc-agent.version'), `${NEW}\n`, { mode: 0o600 });
    first.drop();
    const again = await until(() => served.sockets[1], 'the second HELLO', daemon.log);

    expect(again.hello.version).toBe(OLD);
  });

  test('a hostile frame — an off-origin url, or a checksum that is not one — lands nothing', async () => {
    const served = hub({ served: OLD, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    const sha256 = 'a'.repeat(64);

    socket.send({ type: 'UPDATE', version: NEW, urls: { tarball: 'https://evil.invalid/cli.tar.gz', checksum: `${PLATFORM_ARTIFACT}.sha256` }, sha256 });
    socket.send({ type: 'UPDATE', version: NEW, urls: { tarball: PLATFORM_ARTIFACT, checksum: `${PLATFORM_ARTIFACT}.sha256` }, sha256: 'not-a-digest' });
    await socket.settle();

    expect(daemon.log().match(/device\.update_ignored reason=malformed_frame/g)).toHaveLength(2);
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
  });

  test('a daemon without a stamp sends no version and is left alone', async () => {
    const served = hub({ served: NEW, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, null);
    const daemon = startDaemon(home, await releaseSigningEnv());

    const socket = await until(() => served.sockets[0], 'the HELLO', daemon.log);
    expect('version' in socket.hello).toBe(false);
    await socket.settle();
    expect(served.hits.filter((hit) => hit.startsWith('/downloads/'))).toEqual([]);
  });
});

/** A build whose daemon passes its selftest and then dies as a daemon: the
 *  one failure a self-update used to leave for a human to notice. */
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
    // Before: the pidfile named the dead successor, the landed files stayed,
    // and the only recovery was `kinu desktop status` — which then started a
    // SECOND daemon beside the living old one.
    const served = hub({ served: NEW, archive: daemonArchive({ ...NEW_FILES, 'pc-agent.js': DYING_DAEMON }, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    const oldPid = await until(() => (existsSync(join(home, 'pc-agent.pid')) ? pidfile(home) : null), 'the pidfile', daemon.log);

    await until(() => (daemon.log().includes('device.update_rolled_back') ? true : null), 'the rollback', daemon.log);

    // The machine is still the old daemon's, by its own claim.
    expect(pidfile(home)).toBe(oldPid);
    expect(alive(oldPid)).toBe(true);
    // The files are the build that runs: no .prev, no marker, the old stamp.
    expect(installed(home, 'pc-agent.js')).toBe(DAEMON_FILES['pc-agent.js']);
    expect(installed(home, 'pc-agent.version').trim()).toBe(OLD);
    expect(existsSync(join(home, 'pc-agent.js.prev'))).toBe(false);
    expect(existsSync(join(home, 'pc-agent.update-pending'))).toBe(false);
    // The socket the hub gave this daemon was never replaced: the successor
    // never connected, and the old daemon never disconnected.
    expect(served.sockets[0]?.closed).toBeNull();
    expect(served.sockets).toHaveLength(1);

    // A status read is a read: it names the live daemon and starts nothing.
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
    const served = hub({ served: OLD, archive: daemonArchive(NEW_FILES, NEW) });
    const home = installedMachine(served.origin, OLD);
    const daemon = startDaemon(home, await releaseSigningEnv());
    await until(() => served.sockets[0], 'the HELLO', daemon.log);
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
