/**
 * PC-agent daemon — protocol round-trips through handle() with REAL git
 * (no mocks on the checkpoint path): the pre-mutation snapshot hint on
 * exec/writeFile frames, the checkpoint RPC methods, and the honest
 * degraded mode when git is missing.
 */
'use strict';

const { scratchDir } = require('../../test-utils/src/scratch');

const { isRunning, killAndAwaitExit, recordedIn, runToExit } = require('../../test-utils/src/spawn');

const { AwaitedList } = require('@kinu.run/test-utils');

const { afterAll, afterEach, describe, expect, spyOn, test } = require('bun:test');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { tolerate } = require('@kinu.run/core/obs');

/** The daemon snapshots these paths at load. Reload its module after this fixture declares them: another suite
 * can have required it first, with the runner's throwaway home and a different in-flight root. */
const INFLIGHT_ROOT = scratchDir('daemon-inflight');

const DEVICE_HOME = scratchDir('daemon-home');

const previousKinuHome = process.env.KINU_HOME;

const previousInFlightRoot = process.env.KINU_INFLIGHT_ROOT;

process.env.KINU_INFLIGHT_ROOT = INFLIGHT_ROOT;

process.env.KINU_HOME = DEVICE_HOME;

afterAll(() => {

  if (previousKinuHome === undefined) delete process.env.KINU_HOME;
  else process.env.KINU_HOME = previousKinuHome;

  if (previousInFlightRoot === undefined) delete process.env.KINU_INFLIGHT_ROOT;
  else process.env.KINU_INFLIGHT_ROOT = previousInFlightRoot;
});

delete require.cache[require.resolve('../src/index.js')];

const {
  CONFIG_PATH,
  handle,
  createCheckpoints,
  getConnectTicket,
  persistGeneration,
  readDeviceConfig,
  startConnectLoop,
  storeGeneration,
  supervision,
} = require('../src/index.js');

const crypto = require('node:crypto');

/** A machine's key as `kinu connect` writes device.key: Ed25519, its private half PKCS#8 PEM. */
function deviceKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

/** device.json as `kinu connect` writes it on protocol 5: no secret in it. */
function deviceConfig(fields = {}) {
  return { user: 'user-1', device: 'dev-1', origin: 'https://kinu.run', root: '/home/u/project', generation: 0, ...fields };
}

/** A hub's challenge and ticket answers, recording each request's path and body. */
function ticketHub(seen, ticketAnswer = () => Response.json({ ticket: `pct_${'a'.repeat(32)}` })) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ path: new URL(url).pathname, body });

    return new URL(url).pathname === '/pc/connect-challenge' ? Response.json({ nonce: `pcc_${'n'.repeat(43)}`, expiresAt: Date.now() + 60_000 }) : ticketAnswer(body);
  };
}

const { supervisionSupported } = require('../src/daemon/supervisor.js');

/** The hub ACKs every result it records, and the ACK is what ends a command's supervisor (about 30 MB).
 *  A test that read an answer and stopped there left 22 supervisors running until the run ended. */
afterEach(async () => {
  for (const requestId of fs.readdirSync(INFLIGHT_ROOT)) {
    if (fs.existsSync(path.join(INFLIGHT_ROOT, requestId, 'result'))) await supervision.acknowledge(requestId);
  }
});

/** The block a hub with the owner's Sandbox switch OFF sends. Every frame that
 *  reaches the machine carries a tier, so an unscoped frame is a refusal. */
const RAW = { tier: 'raw', agentHome: '', roots: [] };

function fakeWs() {
  const recorded = new AwaitedList();
  const frames = recorded.items;

  return {
    frames,
    send(data) { recorded.push(JSON.parse(data)); },
    /** Await the correlated response for an id (exec resolves async). */
    async response(id) {
      await recorded.until((items) => items.some((frame) => frame.id === id));

      return frames.find((frame) => frame.id === id);
    },
  };
}

function setup(opts = {}) {
  const root = scratchDir('daemon');
  const work = path.join(root, 'project');
  fs.mkdirSync(work, { recursive: true });
  const ctx = { checkpoints: createCheckpoints({ base: path.join(root, 'shadow'), keep: opts.keep, gitBin: opts.gitBin }) };

  return { root, work, ctx };
}

/**
 * A git that holds the first staging it is asked for, a snapshot's `add`, until the test lets it go. The hold and
 * the release are each a FIFO, so each side waits on the other's act: the held git writes `held`, which a `cat` the
 * test started reads and exits on, then reads `release`. Never a file-change event: Bun's fs.watch dropped one in
 * 40 runs under load (2026-10-20, linux-screen.test.js), and a wait on it hangs the suite.
 */
async function heldGit() {
  const dir = scratchDir('held-git');
  const marker = path.join(dir, 'first');
  const held = path.join(dir, 'held');
  const release = path.join(dir, 'release');
  const made = await runToExit(['mkfifo', held, release]);

  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
  const bin = path.join(dir, 'git');
  fs.writeFileSync(bin, [
    '#!/bin/bash',
    `if [ "$1" = add ] && mkdir '${marker}' 2>/dev/null; then echo held > '${held}'; read -r _ < '${release}'; fi`,
    'exec git "$@"',
    '',
  ].join('\n'), { mode: 0o755 });

  // Unreferenced: a test that never reaches the hold leaves no reader keeping the suite alive.
  const reader = Bun.spawn(['cat', held], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });

  reader.unref();

  return {
    bin,
    held: reader.exited,
    release: () => fs.promises.writeFile(release, 'go\n'),
  };
}

/** A write no queue holds lands within microtasks of its frame, since nothing in it waits on I/O: one turn of
 *  the event loop later it is on disk. */
async function oneTurn() {
  await new Promise((resolve) => { setImmediate(resolve); });
}

// A sub-millisecond red of the two fixture-first tests below identifies the
// box's tmpdir. Each test's first syscall is mkdtempSync, and a refusal there
// fails the test before any product code runs: two 0.1-0.3 ms rows appeared
// once under a 711-file parallel run at dec792391 while the identical
// syscalls one test later passed. persist is synchronous and atomic, its temp
// file never survives a call, and files cannot pollute each other. Bun runs
// each file in a fresh context with fresh builtins (bun 1.4.0). Check
// `df /tmp` first when these rows go red that fast.
describe('daemon connect generation', () => {
  test('the next ticket exchange signs the generation on disk, with the machine\'s key, for the hub it dials', async () => {
    const root = scratchDir('daemon-generation');
    const configPath = path.join(root, 'device.json');
    const keyPath = path.join(root, 'device.key');
    const key = deviceKey();
    const cfg = deviceConfig();
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    fs.writeFileSync(keyPath, key.pem, { mode: 0o600 });
    const seen = [];

    await getConnectTicket(cfg, 'https://kinu.run', ticketHub(seen), { configPath, keyPath });
    persistGeneration(cfg, 1, configPath);
    await getConnectTicket(cfg, 'https://kinu.run', ticketHub(seen), { configPath, keyPath });

    const tickets = seen.filter((request) => request.path === '/pc/connect-ticket').map((request) => request.body);
    expect(seen.map((request) => request.path)).toEqual(['/pc/connect-challenge', '/pc/connect-ticket', '/pc/connect-challenge', '/pc/connect-ticket']);
    expect(tickets.map((body) => body.generation)).toEqual([0, 1]);

    // Each signs exactly the message the hub checks: protocol, hub origin, device, generation, nonce.
    for (const body of tickets) {
      const message = Buffer.from(`kinu-device-connect:5:https://kinu.run:dev-1:${String(body.generation)}:${body.nonce}`);
      expect(crypto.verify(null, message, key.publicKey, Buffer.from(body.signature, 'base64url'))).toBe(true);
      expect(Object.keys(body).sort()).toEqual(['device', 'generation', 'nonce', 'signature', 'user']);
    }

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).generation).toBe(1);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).sort()).toEqual(['device.json', 'device.key']);
  });

  test('a device.json with no key beside it buys no ticket: the machine stops as a dead credential', async () => {
    const root = scratchDir('daemon-generation');
    const configPath = path.join(root, 'device.json');
    const cfg = deviceConfig();
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    const seen = [];
    let failure;

    try {
      await getConnectTicket(cfg, 'https://kinu.run', ticketHub(seen), { configPath, keyPath: path.join(root, 'device.key') });
    } catch (err) {
      failure = err;
    }

    if (!(failure instanceof Error) || !(failure.cause instanceof Error)) throw new Error('expected the exchange to refuse with a caused Error');
    expect(failure.message).toBe('device credentials were rejected; re-run: kinu connect');
    expect(failure.cause.message).toContain('no device key');
    expect(seen.map((request) => request.path)).toEqual(['/pc/connect-challenge']);
  });

  test('a failed persist leaves memory and the old file unchanged', () => {
    const root = scratchDir('daemon-generation');
    const configPath = path.join(root, 'missing', 'device.json');
    const cfg = deviceConfig();

    expect(() => persistGeneration(cfg, 1, configPath)).toThrow('persist connect generation');
    expect(cfg.generation).toBe(0);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('a failed atomic rename preserves the config and is not acknowledged', () => {
    const root = scratchDir('daemon-generation');
    const configPath = path.join(root, 'device.json');
    const cfg = deviceConfig();
    const messages = [];
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });

    const rename = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    try {
      expect(storeGeneration(cfg, { type: 'GENERATION', generation: 1 }, configPath, (...args) => messages.push(args))).toBe(false);
      expect(cfg.generation).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).generation).toBe(0);
      expect(fs.readdirSync(root)).toEqual(['device.json']);
      expect(messages[0]?.[0]).toBe('Connect generation could not be stored:');
    } finally {
      rename.mockRestore();
    }
  });

  test('a generation frame carrying anything but a whole number above 0 is neither stored nor taken', () => {
    const root = scratchDir('daemon-generation');
    const configPath = path.join(root, 'device.json');
    const messages = [];

    for (const generation of [{ weird: 'object' }, '2', 0, -1, 1.5, undefined]) {
      const cfg = deviceConfig();
      fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });

      expect(storeGeneration(cfg, { type: 'GENERATION', generation }, configPath, (...args) => messages.push(args))).toBe(false);
      expect(cfg.generation).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).generation).toBe(0);
    }

    expect(messages.map((message) => message[0])).toEqual(Array(6).fill('Connect generation refused:'));
  });
});

describe('daemon startup hardening', () => {
  test('uses the configured home and never reflects a corrupt config', () => {
    const configPath = path.join(DEVICE_HOME, 'corrupt-device.json');
    const secret = 'dev-content_that_must_not_appear';
    fs.writeFileSync(configPath, `{"user":"user-1","device":"${secret}",`);

    let failure;

    try {
      readDeviceConfig(configPath);
    } catch (err) {
      failure = err;
    }

    if (!(failure instanceof Error)) throw new Error('expected corrupt config to be refused');
    expect(CONFIG_PATH).toBe(path.join(DEVICE_HOME, 'device.json'));
    expect(failure.message).toContain('corrupt');
    expect(failure.message).not.toContain(secret);
    expect(() => readDeviceConfig(path.join(DEVICE_HOME, 'missing-device.json')))
      .toThrow('run: kinu connect');
  });

  test('a device config naming a plaintext origin off this machine is refused before anything is sent', () => {
    const configPath = path.join(DEVICE_HOME, 'origin-device.json');
    const config = (origin) => JSON.stringify(deviceConfig({ origin }));

    for (const origin of ['http://kinu.example', 'ftp://kinu.example', 'http://192.0.2.10:8787', 'not a url']) {
      fs.writeFileSync(configPath, config(origin), { mode: 0o600 });
      expect(() => readDeviceConfig(configPath)).toThrow('https');
    }

    // The owner's own machine may serve a development hub over plain http.
    for (const origin of ['https://kinu.run', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      fs.writeFileSync(configPath, config(origin), { mode: 0o600 });
      expect(readDeviceConfig(configPath).origin).toBe(origin);
    }
  });

  test('a device config is read whole or refused: every field the daemon runs on, nonempty, and an absolute directory', () => {
    const configPath = path.join(DEVICE_HOME, 'partial-device.json');
    const whole = deviceConfig();

    fs.writeFileSync(configPath, JSON.stringify(whole), { mode: 0o600 });
    expect(readDeviceConfig(configPath)).toEqual(whole);

    for (const field of Object.keys(whole)) {
      for (const partial of [{ ...whole, [field]: undefined }, { ...whole, [field]: '' }]) {
        fs.writeFileSync(configPath, JSON.stringify(partial), { mode: 0o600 });
        expect(() => readDeviceConfig(configPath)).toThrow();
      }
    }

    for (const malformed of [{ ...whole, device: 1 }, { ...whole, root: 'project' }, { ...whole, generation: -1 }, { ...whole, generation: 1.5 }, { ...whole, generation: '1' }]) {
      fs.writeFileSync(configPath, JSON.stringify(malformed), { mode: 0o600 });
      expect(() => readDeviceConfig(configPath)).toThrow();
    }
  });

  // An earlier protocol's link holds a bearer no hub takes: the daemon runs nothing on it, and names what mends it.
  test('a device config an earlier protocol wrote, with its bearer, is refused in words that name kinu update', () => {
    const configPath = path.join(DEVICE_HOME, 'earlier-device.json');
    const bearer = `pdt_${'a'.repeat(32)}`;

    fs.writeFileSync(configPath, JSON.stringify({ user: 'user-1', device: 'dev-1', token: bearer, origin: 'https://kinu.run', root: '/home/u/project' }), { mode: 0o600 });
    expect(() => readDeviceConfig(configPath)).toThrow('run: kinu update');
    expect(() => readDeviceConfig(configPath)).not.toThrow(bearer);
  });

  test('a ticket exchange the hub refuses is a dead credential, in the hub\'s own words', async () => {
    const root = scratchDir('daemon-refused');
    const configPath = path.join(root, 'device.json');
    const keyPath = path.join(root, 'device.key');
    fs.writeFileSync(configPath, JSON.stringify(deviceConfig()), { mode: 0o600 });
    fs.writeFileSync(keyPath, deviceKey().pem, { mode: 0o600 });
    const said = 'Kinu revoked this device because two machines used its key.';
    let failure;

    try {
      await getConnectTicket(deviceConfig(), 'https://kinu.run', ticketHub([], () => Response.json({ error: said }, { status: 401 })), { configPath, keyPath });
    } catch (err) {
      failure = err;
    }

    if (!(failure instanceof Error) || !(failure.cause instanceof Error)) {
      throw new Error('expected ticket exchange to reject with a caused Error');
    }

    expect(failure.message).toBe('device credentials were rejected; re-run: kinu connect');
    expect(failure.cause.message).toBe(said);
  });

  test('mints a fresh ticket after a refusal and never logs either ticket', async () => {
    const first = `pct_${'a'.repeat(32)}`;
    const second = `pct_${'b'.repeat(32)}`;
    const issued = [first, second];
    const dialed = [];
    const sockets = [];
    const scheduled = [];
    const logs = [];

    const loop = startConnectLoop({
      getTicket: async () => issued.shift(),
      dial(ticket) {
        const socket = fakeSocket();
        dialed.push(ticket);
        sockets.push(socket);

        return socket;
      },
      logger(...parts) {
        logs.push(parts.join(' '));
      },
      schedule(next) {
        scheduled.push(next);
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(dialed).toEqual([first]);
    sockets[0].emit('error', { message: `Unexpected server response: 401 for ${first}` });
    sockets[0].emit('close');
    expect(logs.join('\n')).toContain('refused by the server');
    expect(logs.join('\n')).not.toContain(first);
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    await Promise.resolve();
    await Promise.resolve();
    loop.stop();
    expect(dialed).toEqual([first, second]);
  });

  /** The fake socket the loop tests drive, with the listener map they share. */
  function fakeSocket() {
    const listeners = new Map();

    return {
      sent: [],
      closed: 0,
      readyState: 1,
      send(data) { this.sent.push(data); },
      close() { this.closed += 1; this.emit('close', { code: 1000 }); },
      addEventListener(type, listener) {
        const callbacks = listeners.get(type) ?? [];
        callbacks.push(listener);
        listeners.set(type, callbacks);
      },
      emit(type, event = {}) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
  }

  // A rejected credential is the one outcome retrying cannot fix. Dialling on it
  // anyway fills the log with a failure nobody reads.
  test('a refused device credential stops the loop loudly instead of dialling forever', async () => {
    const scheduled = [];
    const logs = [];
    let rejected = 0;

    const loop = startConnectLoop({
      getTicket: async () => { throw new Error('device credentials were rejected; re-run: kinu connect'); },
      dial() { throw new Error('must not dial after a refusal'); },
      logger(...parts) { logs.push(parts.join(' ')); },
      schedule(next) { scheduled.push(next); },
      onRejected() { rejected += 1; },
    });

    await Promise.resolve();
    await Promise.resolve();
    loop.stop();

    expect(rejected).toBe(1);
    // Nothing queued: the absence of a retry IS the fix.
    expect(scheduled).toEqual([]);
    expect(logs.join('\n')).toContain('re-run: kinu connect');
  });

  test('the hub closing with 4401 stops the loop the same way', async () => {
    const scheduled = [];
    const logs = [];
    let rejected = 0;
    const socket = fakeSocket();

    const loop = startConnectLoop({
      getTicket: async () => 'pct_' + 'a'.repeat(32),
      dial: () => socket,
      logger(...parts) { logs.push(parts.join(' ')); },
      schedule(next) { scheduled.push(next); },
      onRejected() { rejected += 1; },
    });

    await Promise.resolve();
    await Promise.resolve();
    socket.emit('close', { code: 4401 });
    loop.stop();

    expect(rejected).toBe(1);
    expect(scheduled).toEqual([]);
    expect(logs.join('\n')).toContain('4401');

    // An ordinary close still redials, or a dropped socket would end the daemon.
    const second = fakeSocket();

    const ordinary = startConnectLoop({
      getTicket: async () => 'pct_' + 'b'.repeat(32),
      dial: () => second,
      logger() {},
      schedule(next) { scheduled.push(next); },
    });

    await Promise.resolve();
    await Promise.resolve();
    second.emit('close', { code: 1000 });
    ordinary.stop();
    expect(scheduled).toHaveLength(1);
  });

  // A half-open socket answers no close event, so the daemon asks. Without
  // this, a dead tunnel is discovered by the owner at the next command.
  test('an unanswered keepalive closes the socket and redials', async () => {
    const scheduled = [];
    const cancelled = [];
    const socket = fakeSocket();

    const loop = startConnectLoop({
      getTicket: async () => 'pct_' + 'c'.repeat(32),
      dial: () => socket,
      logger() {},
      schedule(next) {
        scheduled.push(next);

        return scheduled.length;
      },
      cancel(scheduleId) { cancelled.push(scheduleId); },
    });

    await Promise.resolve();
    await Promise.resolve();
    socket.emit('open');

    // The open event queues the first beat; running it pings and arms both
    // the pong deadline and the next beat.
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(socket.sent).toEqual(['ping']);
    expect(scheduled).toHaveLength(3);

    // The answer arrives: the deadline is cancelled and the socket survives.
    socket.emit('message', { data: 'pong' });
    expect(cancelled).toContain(2);
    expect(socket.closed).toBe(0);

    // The next beat goes unanswered, and the deadline closes the socket.
    scheduled[2]();
    expect(socket.sent).toEqual(['ping', 'ping']);
    scheduled[3]();
    expect(socket.closed).toBe(1);
    loop.stop();
  });

  test('does not claim command supervision on unsupported platforms', () => {
    expect(supervisionSupported('linux')).toBe(true);
    expect(supervisionSupported('darwin')).toBe(true);
    expect(supervisionSupported('win32')).toBe(false);
    expect(supervisionSupported('sunos')).toBe(false);
  });
});

describe('daemon exec output bound', () => {
  const noisy = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(600000) + 'END')"`;

  test('a noisy command keeps its head and tail, and its whole output is saved where the model can read it', async () => {
    const ws = fakeWs();
    handle({ id: 'rpc-noisyexec0-1', method: 'exec', sandbox: RAW, params: [noisy] }, ws, {});

    const result = (await ws.response('rpc-noisyexec0-1')).result;
    const spill = path.join(os.tmpdir(), 'kinu-tool-output', 'device-rpc-noisyexec0-1.stdout.log');

    try {
      expect(result.exitCode).toBe(0);
      expect(result.stdout.startsWith('x'.repeat(1000))).toBe(true);
      expect(result.stdout).toContain(`${'x'.repeat(1000)}END\n[stdout: 600003 bytes, `);
      expect(result.stdout).toContain(`the full stdout is at ${spill}]`);
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(530_000);
      expect(fs.statSync(spill).size).toBe(600_003);
    } finally {
      fs.rmSync(spill, { force: true });
    }
  });
});

describe('a command a signal ended', () => {
  // Each one kills the shell that runs it, so no exit code exists, only the
  // signal. `ulimit -c 0`: nothing leaves a core file behind.
  for (const [signal, id] of [['SIGSEGV', 'rpc-sigsegv000-1'], ['SIGABRT', 'rpc-sigabrt000-1'], ['SIGBUS', 'rpc-sigbus0000-1']]) {
    test(`reports ${signal} by its own number, and says so`, async () => {
      const ws = fakeWs();
      handle({ id, method: 'exec', sandbox: RAW, params: [`ulimit -c 0; kill -${signal.slice(3)} $$`] }, ws, {});

      const { result } = await ws.response(id);

      expect(result.exitCode).toBe(128 + os.constants.signals[signal]);
      expect(result.stderr).toBe(`Command terminated by ${signal}.`);
    });
  }

  test('an exit code, even one above 128, is the command\'s own and names no signal', async () => {
    const ws = fakeWs();
    handle({ id: 'rpc-exit139000-1', method: 'exec', sandbox: RAW, params: ['echo failing >&2; exit 139'] }, ws, {});

    const { result } = await ws.response('rpc-exit139000-1');

    expect(result).toMatchObject({ exitCode: 139, stderr: 'failing\n' });
  });
});

describe('daemon device path confinement', () => {
  /** The frame a hub with the Sandbox switch on sends: the consented
   *  directories ride the sandbox block, which is the SAME policy object the
   *  kernel is built from, rather than a per-call `root` only the file methods
   *  ever read. */
  function scoped(roots) {
    return {
      tier: 'sandboxed',
      agentHome: path.join(DEVICE_HOME, 'agents', 'ws-1', 'home'),
      roots,
    };
  }

  /** A file outside every home, every temp root and every system tree:
   *  /dev/shm is writable on every Linux and nothing in the sandbox names it. */
  function plantOutside(label) {
    const planted = path.join('/dev/shm', `kinu-daemon-${label}-${process.pid}`);
    fs.writeFileSync(planted, 'secret', { mode: 0o600 });

    return planted;
  }

  test('a frame that names no sandbox tier is refused by every method that reaches the machine', async () => {
    const planted = plantOutside('untiered');
    const ws = fakeWs();

    try {
      const frames = [
        ['untiered-range', 'readRange', [planted, 0, 6]],
        ['untiered-write', 'writeFile', [planted, 'planted']],
        ['untiered-list', 'listFiles', [path.dirname(planted)]],
        ['untiered-stat', 'statPath', [planted]],
        ['untiered-unlink', 'unlinkPath', [planted]],
        ['untiered-rmdir', 'rmdirPath', [path.dirname(planted)]],
        ['untiered-mkdir', 'mkdirPath', [`${planted}-dir`]],
        ['rpc-untiered00-1', 'exec', [`cat ${JSON.stringify(planted)}`]],
      ];

      for (const [id, method, params] of frames) handle({ id, method, params }, ws, {});

      for (const [id] of frames) {
        const frame = await ws.response(id);
        expect(frame.result).toBeUndefined();
        expect(frame.error?.message).toContain('names no sandbox tier');
      }

      expect(fs.readFileSync(planted, 'utf8')).toBe('secret');
      expect(fs.existsSync(`${planted}-dir`)).toBe(false);
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  test('dot-dot and symlink paths outside the consented root are refused, never served', async () => {
    // Each path is judged by where it LANDS: a `..` spelling and a symlink both
    // reach a file no home and no consented directory holds, and neither
    // spelling reads or writes it.
    const root = scratchDir("daemon-root");
    const project = path.join(root, 'project');
    const outside = plantOutside('escape');
    const climb = `${project}/${'../'.repeat(project.split('/').filter(Boolean).length)}${outside.slice(1)}`;
    fs.mkdirSync(project);
    fs.symlinkSync(outside, path.join(project, 'link'));
    const ws = fakeWs();

    try {
      for (const [id, method, params] of [
        ['symlink', 'readRange', [path.join(project, 'link'), 0, 6]],
        ['traversal-range', 'readRange', [climb, 0, 6]],
        ['traversal-write', 'writeFile', [climb, 'planted']],
        ['symlink-write', 'writeFile', [path.join(project, 'link'), 'planted']],
      ]) {
        handle({ id, method, sandbox: scoped([project]), params }, ws, {});
        const frame = await ws.response(id);
        expect(frame.result).toBeUndefined();
        expect(frame.error?.message).toContain('does not expose');
      }

      expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
    } finally {
      fs.rmSync(outside, { force: true });
    }

    // The system trees a program needs stay readable and refuse a write,
    // which is what the kernel does to the shell for the same paths.
    handle({ id: 'read-system', method: 'readRange', sandbox: scoped([project]), params: ['/etc/hostname', 0, 64] }, ws, {});
    expect((await ws.response('read-system')).error).toBeUndefined();
    handle({
      id: 'write-system',
      method: 'writeFile',
      sandbox: scoped([project]),
      params: ['/usr/local/kinu-planted.txt', 'x'],
    }, ws, {});
    expect((await ws.response('write-system')).error?.message).toContain('read-only in this device');
    expect(fs.existsSync('/usr/local/kinu-planted.txt')).toBe(false);

    // And a symlink is judged by where it LANDS: one pointing into Kinu's own
    // directory is refused however it is spelled.
    // The bait must point at a file that EXISTS: a dangling link cannot be
    // followed, so the read would fail on the link rather than reach the
    // fence, and the test would pass while proving nothing.
    const bait = path.join(project, 'kinu-link');
    const baited = path.join(DEVICE_HOME, 'baited-device.json');
    fs.writeFileSync(baited, '{"token":"machine-secret"}', { mode: 0o600 });
    fs.symlinkSync(baited, bait);
    handle({ id: 'kinu-link', method: 'readRange', sandbox: scoped([project]), params: [bait, 0, 64] }, ws, {});
    expect((await ws.response('kinu-link')).error?.message).toContain("inside Kinu's own directory");
    expect((await ws.response('kinu-link')).result).toBeUndefined();
    expect(fs.readFileSync(baited, 'utf8')).toContain('machine-secret');
    fs.rmSync(baited, { force: true });
  });

  test('a write through a dangling link out of the consented folder is refused and creates nothing', async () => {
    // The sandboxed shell can plant `link -> <outside>/new.txt` with the target absent; a write that follows it
    // would create the target outside every folder the owner shared.
    const project = path.join(scratchDir('daemon-dangling'), 'project');
    const outside = path.join('/dev/shm', `kinu-daemon-dangling-${process.pid}`);
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(outside, 'new.txt'), path.join(project, 'link'));
    fs.symlinkSync(path.join(outside, 'sub'), path.join(project, 'dir-link'));
    const ws = fakeWs();

    try {
      for (const [id, method, params] of [
        ['dangling-write', 'writeFile', [path.join(project, 'link'), 'escaped']],
        ['dangling-dir-write', 'writeFile', [path.join(project, 'dir-link', 'new.txt'), 'escaped']],
        ['dangling-mkdir', 'mkdirPath', [path.join(project, 'dir-link', 'inner'), { recursive: true }]],
      ]) {
        handle({ id, method, sandbox: scoped([project]), params }, ws, {});
        const frame = await ws.response(id);
        expect(frame.result).toBeUndefined();
        expect(frame.error?.message).toContain('does not expose');
      }

      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('an agent home that is not one workspace under the daemon\'s own root is refused', async () => {
    // A workspace name carrying `a/../b` composes a home that resolves under
    // the root yet belongs to workspace b.
    const agents = path.join(DEVICE_HOME, 'agents');
    const sibling = path.join(agents, 'ws-b', 'home');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'notes.txt'), 'ws-b-private');
    const ws = fakeWs();

    for (const [id, agentHome] of [
      ['home-climb', path.join(agents, 'ws-a') + '/../ws-b/home'],
      ['home-deep', path.join(agents, 'ws-a', 'nested', 'home')],
      ['home-not-home', path.join(agents, 'ws-b', 'elsewhere')],
    ]) {
      handle({
        id,
        method: 'readRange',
        sandbox: { tier: 'sandboxed', agentHome, roots: [] },
        params: [path.join(sibling, 'notes.txt'), 0, 64],
      }, ws, {});
      const frame = await ws.response(id);
      expect(frame.result).toBeUndefined();
      expect(frame.error?.message).toContain('agent home must be');
    }
  });

  test('a consented root of / is the whole machine, as with the Sandbox switch off', async () => {
    const outside = plantOutside('whole-machine');
    fs.writeFileSync(path.join(DEVICE_HOME, 'whole-machine-device.json'), '{"token":"machine-secret"}', { mode: 0o600 });
    const whole = { tier: 'sandboxed', agentHome: path.join(DEVICE_HOME, 'agents', 'ws-1', 'home'), roots: ['/'] };
    const ws = fakeWs();

    try {
      handle({ id: 'rpc-wholemach0-1', method: 'exec', sandbox: whole, params: [`cat ${JSON.stringify(outside)}`] }, ws, {});
      handle({ id: 'whole-read', method: 'readRange', sandbox: whole, params: [outside, 0, 64] }, ws, {});
      handle({
        id: 'whole-kinu', method: 'readRange', sandbox: whole, params: [path.join(DEVICE_HOME, 'whole-machine-device.json'), 0, 64],
      }, ws, {});

      expect((await ws.response('rpc-wholemach0-1')).result.stdout).toBe('secret');
      expect(Buffer.from((await ws.response('whole-read')).result.content, 'base64').toString()).toBe('secret');
      // Kinu's own directory is the one thing no tier serves.
      expect((await ws.response('whole-kinu')).error?.message).toContain("inside Kinu's own directory");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('a range answers what the file holds, however long a range was asked for', async () => {
    const root = scratchDir('daemon-range');
    const small = path.join(root, 'small.txt');
    fs.writeFileSync(small, 'twelve bytes');
    const ws = fakeWs();

    // Allocating the asked length would be a terabyte before the first byte is read.
    handle({ id: 'long-range', method: 'readRange', sandbox: scoped([root]), params: [small, 7, 2 ** 40] }, ws, {});
    const frame = await ws.response('long-range');

    expect(frame.error).toBeUndefined();
    expect(Buffer.from(frame.result.content, 'base64').toString('utf8')).toBe('bytes');
  });

  test('a directory lists completely, one page at a time', async () => {
    const root = scratchDir('daemon-pages');
    const names = Array.from({ length: 25 }, (_, index) => `f${String(index)}`);

    for (const name of names) fs.writeFileSync(path.join(root, name), '');
    const ws = fakeWs();
    const listed = [];
    let offset = 0;

    for (let page = 0; offset !== null; page += 1) {
      handle({ id: `page-${String(page)}`, method: 'listFiles', sandbox: scoped([root]), params: [root, { offset, limit: 10 }] }, ws, {});
      const frame = await ws.response(`page-${String(page)}`);
      expect(frame.result.entries.length).toBeLessThanOrEqual(10);
      listed.push(...frame.result.entries.map((entry) => entry.name));
      offset = frame.result.next;
    }

    const byName = (left, right) => left.localeCompare(right);
    expect(listed.sort(byName)).toEqual(names.sort(byName));

    // A hub from before paging names no page and still gets every entry.
    handle({ id: 'unpaged', method: 'listFiles', sandbox: scoped([root]), params: [root] }, ws, {});
    expect((await ws.response('unpaged')).result.map((entry) => entry.name).sort(byName)).toEqual(names.sort(byName));
  });

  // 2026-10-14, the owner's machine: a device root of 56,762 entries cost a statPath round trip per entry, and the
  // listing never loaded. Each entry answers what that stat would; one gone since the read answers its name alone.
  test('a listed entry carries its size and modification time, as a stat of it answers them', async () => {
    const root = scratchDir('daemon-listed-stats');
    fs.writeFileSync(path.join(root, 'twelve.txt'), 'twelve bytes');
    fs.mkdirSync(path.join(root, 'inner'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));

    const ws = fakeWs();

    handle({ id: 'listed', method: 'listFiles', sandbox: scoped([root]), params: [root, { offset: 0, limit: 10 }] }, ws, {});
    const { entries } = (await ws.response('listed')).result;

    const stated = (name) => {
      const stat = fs.statSync(path.join(root, name));

      return { size: stat.size, mtimeMs: stat.mtimeMs };
    };

    expect(Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest]))).toEqual({
      'twelve.txt': { type: 'file', ...stated('twelve.txt') },
      inner: { type: 'dir', ...stated('inner') },
      dangling: { type: 'file' },
    });
  });

  // 2026-10-12 security review: a mutation was judged when its frame arrived and run on the path string after the
  // checkpoint queue, so a command that swapped a judged directory for a link meanwhile moved it out of the root.
  const SWAPPED = [
    ['writeFile', (at) => ['writeFile', [at('inner/target.txt'), 'written', {}]]],
    ['writeFileIfDigest', (at) => ['writeFileIfDigest', [at('inner/target.txt'), 'written', require('node:crypto').createHash('sha256').update('inside').digest('hex'), {}]]],
    ['unlinkPath', (at) => ['unlinkPath', [at('inner/target.txt')]]],
    ['rmdirPath', (at) => ['rmdirPath', [at('inner/empty')]]],
    ['mkdirPath', (at) => ['mkdirPath', [at('inner/made/deeper'), { recursive: true }]]],
  ];

  /** Every entry under a tree, with a file's bytes: what a mutation outside the root would change. */
  const snapshotTree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort((a, b) => a.localeCompare(b)).map((name) => {
    const full = path.join(dir, String(name));

    return [String(name), fs.lstatSync(full).isFile() ? fs.readFileSync(full, 'utf8') : 'dir'];
  });

  /** What every frame in SWAPPED would change: a file reading 'inside' and an empty directory. */
  function plantTree(dir) {
    fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'target.txt'), 'inside');
  }

  /** `project/inner` and an `outside` beside the project, planted alike. */
  function swapFixture() {
    const root = scratchDir('daemon-swap');
    const project = path.join(root, 'project');
    const fixture = { project, inner: path.join(project, 'inner'), outside: path.join(root, 'outside') };

    plantTree(fixture.inner);
    plantTree(fixture.outside);

    return fixture;
  }

  test.each(SWAPPED)('%s that waits in the queue acts where it was checked, never through a link swapped in meanwhile', async (_name, frame) => {
    const { project, inner, outside } = swapFixture();
    const before = snapshotTree(outside);
    let release;
    const queued = new Promise((resolve) => { release = resolve; });

    // The checkpoint queue, held until the swap is made: a frame's mutation runs only once released.
    const ctx = {
      checkpoints: {
        mutate: async (_view, _request, _covered, apply) => {
          await queued;

          return apply(null);
        },
      },
    };

    const ws = fakeWs();
    const [method, params] = frame((relative) => path.join(project, relative));

    handle({ id: 'swap', method, sandbox: scoped([project]), params }, ws, ctx);
    fs.renameSync(inner, path.join(project, 'inner-old'));
    fs.symlinkSync(outside, inner);
    release();

    expect((await ws.response('swap')).error?.code).toBe('EACCES');
    expect(snapshotTree(outside)).toEqual(before);
  });

  /**
   * A command that swaps `inner` for a link to `outside` and back, as fast as it can, until it is killed. The daemon
   * may make a directory of its own where the swapper puts one next: a write or a recursive mkdir makes the missing
   * parents of a path judged while `inner` was away, or judged at the name the real one had while aside (seen on
   * macOS, 2026-10-18). The swapper removes that one and goes on. It says so on its stdout once it has swapped both ways.
   */
  const SWAPPER = `
    const fs = require('node:fs');
    const [inner, outside] = JSON.parse(process.env.KINU_SWAP);
    const aside = inner + '-aside';
    const taken = (cause) => cause.code === 'EEXIST' || cause.code === 'ENOTEMPTY';
    const over = (place, made) => {
      for (;;) {
        try {
          return place();
        } catch (cause) {
          if (!taken(cause)) throw cause;
        }
        try {
          fs.rmSync(made, { recursive: true, force: true });
        } catch (cause) {
          if (!taken(cause)) throw cause;
        }
      }
    };
    for (let swaps = 0; ; swaps += 1) {
      over(() => fs.renameSync(inner, aside), aside);
      over(() => fs.symlinkSync(outside, inner), inner);
      fs.unlinkSync(inner);
      over(() => fs.renameSync(aside, inner), inner);
      if (swaps === 0) fs.writeSync(1, 'swapping\\n');
    }`;

  // The same swap made while frames run rather than while one waits, each method in turn: no instant between the
  // check and the act lets a mutation through the link. `outside` is planted again after each frame that changed it.
  test('a mutation acts where it was checked while a command swaps a link in and out of its path', async () => {
    const { project, inner, outside } = swapFixture();
    const before = snapshotTree(outside);
    const frames = SWAPPED.map(([name, frame]) => [name, ...frame((relative) => path.join(project, relative))]);
    const escaped = {};
    let refused = 0;

    const swapper = Bun.spawn({
      cmd: [process.execPath, '-e', SWAPPER],
      env: { ...process.env, KINU_SWAP: JSON.stringify([inner, outside]) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });

    try {
      await swapper.stdout.getReader().read();

      for (let attempt = 0; attempt < 2000; attempt += 1) {
        const [name, method, params] = frames[attempt % frames.length];
        const ws = fakeWs();

        handle({ id: 'race', method, sandbox: scoped([project]), params }, ws, {});

        if ((await ws.response('race')).error?.code === 'EACCES') refused += 1;

        if (!Bun.deepEquals(snapshotTree(outside), before)) {
          escaped[name] = (escaped[name] ?? 0) + 1;
          fs.rmSync(outside, { recursive: true });
          plantTree(outside);
        }
      }
    } finally {
      swapper.kill();
      await swapper.exited;
    }

    expect(escaped).toEqual({});
    // The swap ran from the first frame to the last, and the daemon met the link after a frame was checked.
    expect(swapper.signalCode).toBe('SIGTERM');
    expect(refused).toBeGreaterThan(0);
  });

  // L111 #2: a read was judged, then opened by its name again; a command swapping a directory of it for a link in that
  // instant had the unsandboxed daemon read, stat or list what the link led to, outside the consented root.
  test('a read, a stat and a listing answer from where they were checked while a command swaps a link into the path', async () => {
    const { project, inner, outside } = swapFixture();
    fs.writeFileSync(path.join(outside, 'target.txt'), 'outside the root');
    fs.writeFileSync(path.join(outside, 'private.md'), 'the owner\'s');
    const target = path.join(inner, 'target.txt');

    const frames = [
      ['readRange', [target, 0, 64], (result) => Buffer.from(result.content, 'base64').toString('utf8') === 'outside the root'],
      ['statPath', [target], (result) => result?.size === 'outside the root'.length],
      ['listFiles', [inner, { offset: 0, limit: 50 }], (result) => result.entries.some((entry) => entry.name === 'private.md')],
    ];

    const escaped = {};
    let refused = 0;

    const swapper = Bun.spawn({
      cmd: [process.execPath, '-e', SWAPPER],
      env: { ...process.env, KINU_SWAP: JSON.stringify([inner, outside]) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });

    try {
      await swapper.stdout.getReader().read();

      for (let attempt = 0; attempt < 3000; attempt += 1) {
        const [method, params, outsideRead] = frames[attempt % frames.length];
        const ws = fakeWs();

        handle({ id: 'read-race', method, sandbox: scoped([project]), params }, ws, {});
        const answer = await ws.response('read-race');

        if (answer.error !== undefined) refused += 1;
        else if (outsideRead(answer.result)) escaped[method] = (escaped[method] ?? 0) + 1;
      }
    } finally {
      swapper.kill();
      await swapper.exited;
    }

    expect(escaped).toEqual({});
    expect(swapper.signalCode).toBe('SIGTERM');
    expect(refused).toBeGreaterThan(0);
  });

  // L111 #2, the macOS half: a listing that held the directory but read its names by its path again, keeping those the
  // held directory also has, told a command which of the names it planted a swapped-in private directory shares: a
  // listing showing only some of them. Every listing shows all the planted names or none of them, and no private one.
  // (That a listing mid-rename is of the directory named, never a sibling, is the next test's.)
  test('a listing tells a command nothing of a private directory it swaps in for the checked one', async () => {
    const root = scratchDir('daemon-list-planted');
    const project = path.join(root, 'project');
    const inner = path.join(project, 'inner');
    const outside = path.join(root, 'private');
    const planted = ['guess-1.md', 'guess-2.md', 'guess-3.md', 'guess-4.md'];

    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(outside);

    for (const name of planted) fs.writeFileSync(path.join(inner, name), 'planted');
    // The private directory holds one of the guesses, and a name of its own.
    fs.writeFileSync(path.join(outside, 'guess-3.md'), 'private');
    fs.writeFileSync(path.join(outside, 'payroll.xlsx'), 'private');
    const shown = {};
    let refused = 0;

    const swapper = Bun.spawn({
      cmd: [process.execPath, '-e', SWAPPER],
      env: { ...process.env, KINU_SWAP: JSON.stringify([inner, outside]) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });

    try {
      await swapper.stdout.getReader().read();

      for (let attempt = 0; attempt < 2000; attempt += 1) {
        const ws = fakeWs();

        handle({ id: 'list-race', method: 'listFiles', sandbox: scoped([project]), params: [inner] }, ws, {});
        const answer = await ws.response('list-race');

        if (answer.error !== undefined) refused += 1;
        else {
          const names = answer.result.map((entry) => entry.name).sort((a, b) => a.localeCompare(b)).join(' ');

          shown[names] = (shown[names] ?? 0) + 1;
        }
      }
    } finally {
      swapper.kill();
      await swapper.exited;
    }

    const whole = planted.join(' ');

    const told = Object.keys(shown).filter((names) => names.includes('payroll.xlsx')
      || (names !== whole && planted.some((name) => names.split(' ').includes(name))));

    expect({ told, whole: (shown[whole] ?? 0) > 0 }).toEqual({ told: [], whole: true });
    expect(swapper.signalCode).toBe('SIGTERM');
    expect(refused).toBeGreaterThan(0);
  });

  // LEDGER-L111's open defect (2026-10-19): mid-rename, the view judged `project/inner` with Bun 1.4.3's realpathSync,
  // which answered the project itself or the folder set aside, so a frame naming `inner` acted beside it. A decoy of the
  // same name in the project tells the two apart: a frame reads and lists `inner`, or answers an error, and never the
  // project. Before the fix, reads answered the decoy and listings the project's own names.
  test('a frame acts on the path it named while a command moves a folder of it aside, a link in its place, and back', async () => {
    const root = scratchDir('daemon-rename-race');
    const project = path.join(root, 'project');
    const inner = path.join(project, 'inner');

    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'planted.md'), 'planted');
    fs.writeFileSync(path.join(project, 'planted.md'), 'the project\'s decoy');
    const answered = {};
    let refused = 0;

    const outside = path.join(root, 'private');

    fs.mkdirSync(outside);

    const renamer = Bun.spawn({
      cmd: [process.execPath, '-e', SWAPPER],
      env: { ...process.env, KINU_SWAP: JSON.stringify([inner, outside]) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });

    try {
      await renamer.stdout.getReader().read();

      for (let attempt = 0; attempt < 2000; attempt += 1) {
        const ws = fakeWs();
        const reading = attempt % 2 === 1;
        const params = reading ? [path.join(inner, 'planted.md'), 0, 64] : [inner];

        handle({ id: 'rename-race', method: reading ? 'readRange' : 'listFiles', sandbox: scoped([project]), params }, ws, {});
        const answer = await ws.response('rename-race');

        if (answer.error !== undefined) {
          refused += 1;
          continue;
        }

        const seen = reading ? Buffer.from(answer.result.content, 'base64').toString('utf8') : answer.result.map((entry) => entry.name).sort().join(' ');

        answered[seen] = (answered[seen] ?? 0) + 1;
      }
    } finally {
      renamer.kill();
      await renamer.exited;
    }

    expect(Object.keys(answered).sort()).toEqual(['planted', 'planted.md']);
    expect({ renaming: renamer.signalCode, raced: refused > 0 }).toEqual({ renaming: 'SIGTERM', raced: true });
  });

  // A libc that cannot be bound lists nothing another way: the listing is refused, saying why.
  test('a listing is refused, not read by its path, when the descriptor cannot be enumerated', async () => {
    const project = scratchDir('daemon-list-unbound');
    const ws = fakeWs();
    const held = require('../src/daemon/held.js');

    const failing = held.heldModule((name) => {
      if (name === 'bun:ffi') throw new Error('no libc binding here');

      return require(name);
    });

    fs.writeFileSync(path.join(project, 'a.txt'), 'a');

    const refusal = (() => {
      try {
        failing.atJudged({ raw: false }, project, {}, (at) => at.list((entries) => entries));

        return null;
      } catch (cause) {
        return { code: cause.code, said: cause.message.includes('cannot list') };
      }
    })();

    handle({ id: 'listed', method: 'listFiles', sandbox: scoped([project]), params: [project] }, ws, {});
    expect({ refusal, listed: (await ws.response('listed')).result.map((entry) => entry.name) }).toEqual({ refusal: { code: 'ENOTSUP', said: true }, listed: ['a.txt'] });
  });

  // L111 #2's review: a stat walked from / threw when a directory of its path was missing, where an absent path is null.
  test('a stat of a path whose directory is not there yet answers null, followed or not', async () => {
    const project = scratchDir('daemon-stat-missing');
    const answers = [];

    for (const follow of [true, false]) {
      const ws = fakeWs();

      handle({ id: 'absent', method: 'statPath', sandbox: scoped([project]), params: [path.join(project, 'not-made', 'file.txt'), { follow }] }, ws, {});
      answers.push(await ws.response('absent'));
    }

    expect(answers).toEqual([{ id: 'absent', result: null }, { id: 'absent', result: null }]);
  });

  // L111 #2: a listing showed a link's target's size and time, though the link led out of the root.
  test("a listed link out of the root shows its name alone, and one inside shows its target's size", async () => {
    const root = scratchDir('daemon-listed-links');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside the root');
    fs.writeFileSync(path.join(project, 'inside.txt'), 'inside');
    fs.symlinkSync(path.join(root, 'outside.txt'), path.join(project, 'out-link'));
    fs.symlinkSync(path.join(project, 'inside.txt'), path.join(project, 'in-link'));
    const ws = fakeWs();

    handle({ id: 'links', method: 'listFiles', sandbox: scoped([project]), params: [project, { offset: 0, limit: 10 }] }, ws, {});
    const { entries } = (await ws.response('links')).result;
    const byName = Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest]));

    expect({ out: byName['out-link'], in: byName['in-link']?.size }).toEqual({ out: { type: 'file' }, in: 'inside'.length });
  });

  test('scoped native mutations stay inside the resolved root', async () => {
    // Under /tmp rather than TMPDIR: this suite's TMPDIR is inside the real
    // home, which the agent home is mounted over, and a consented directory
    // the owner names is a directory they can still see.
    const root = scratchDir('daemon-root');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const ws = fakeWs();

    const dir = path.join(project, 'nested');
    const file = path.join(dir, 'data.txt');
    const was = process.umask(0o022);

    try {
      handle({ id: 'mkdir', method: 'mkdirPath', sandbox: scoped([project]), params: [dir, { recursive: true }] }, ws, {});
      expect((await ws.response('mkdir')).result).toEqual({ success: true });
      handle({ id: 'write', method: 'writeFile', sandbox: scoped([project]), params: [file, 'ok', {}] }, ws, {});
      expect((await ws.response('write')).result).toEqual({ success: true });
    } finally {
      process.umask(was);
    }

    // Made with the modes a plain mkdir and write give, less the umask.
    expect([fs.statSync(dir).mode & 0o777, fs.statSync(file).mode & 0o777]).toEqual([0o755, 0o644]);
    handle({ id: 'stat', method: 'statPath', sandbox: scoped([project]), params: [file] }, ws, {});
    expect((await ws.response('stat')).result).toMatchObject({ size: 2, type: 'file' });
    handle({ id: 'unlink', method: 'unlinkPath', sandbox: scoped([project]), params: [file] }, ws, {});
    expect((await ws.response('unlink')).result).toEqual({ success: true });
    const target = path.join(project, 'target.txt');
    const link = path.join(project, 'target-link');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, link);
    handle({ id: 'unlink-link', method: 'unlinkPath', sandbox: scoped([project]), params: [link] }, ws, {});
    expect((await ws.response('unlink-link')).result).toEqual({ success: true });
    // A name is the whole name: one holding a NUL is refused, never cut short to the entry before it.
    handle({ id: 'unlink-nul', method: 'unlinkPath', sandbox: scoped([project]), params: [`${target}\0.bak`] }, ws, {});
    expect((await ws.response('unlink-nul')).result).toBeUndefined();
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    // A link to a directory is the link to lstat and no directory to rmdir; the emptied directory itself goes.
    const dirLink = path.join(project, 'nested-link');
    fs.symlinkSync(dir, dirLink);
    handle({ id: 'lstat-link', method: 'statPath', sandbox: scoped([project]), params: [dirLink, { follow: false }] }, ws, {});
    expect((await ws.response('lstat-link')).result).toMatchObject({ type: 'symlink' });
    handle({ id: 'rmdir-link', method: 'rmdirPath', sandbox: scoped([project]), params: [dirLink] }, ws, {});
    expect((await ws.response('rmdir-link')).error?.code).toBe('ENOTDIR');
    expect(fs.existsSync(dir)).toBe(true);
    handle({ id: 'rmdir', method: 'rmdirPath', sandbox: scoped([project]), params: [dir] }, ws, {});
    expect((await ws.response('rmdir')).result).toEqual({ success: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('a write that names the bytes it replaces', () => {
  const sha256 = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');
  // A hub with the Sandbox switch on: the consented directories ride the frame.
  const scoped = (roots) => ({ tier: 'sandboxed', agentHome: path.join(DEVICE_HOME, 'agents', 'ws-1', 'home'), roots });

  test('lands only over those bytes, and a write between the read and it is refused with what is there now', async () => {
    const root = scratchDir('daemon-digest');
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, 'read by the agent');
    const ws = fakeWs();

    // The owner saved over it after the agent read it.
    fs.writeFileSync(file, 'saved by the owner');
    handle({ id: 'stale', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'the agent\'s rewrite', sha256('read by the agent'), {}] }, ws, {});

    expect((await ws.response('stale')).result).toEqual({ ok: false, sha256: sha256('saved by the owner') });
    expect(fs.readFileSync(file, 'utf8')).toBe('saved by the owner');

    handle({ id: 'fresh', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'the agent\'s rewrite', sha256('saved by the owner'), {}] }, ws, {});

    expect((await ws.response('fresh')).result).toEqual({ ok: true, sha256: sha256('the agent\'s rewrite') });
    expect(fs.readFileSync(file, 'utf8')).toBe('the agent\'s rewrite');
  });

  test('a replaced file keeps every mode bit, the ones a umask would cut too', async () => {
    const root = scratchDir('daemon-digest-mode');
    const file = path.join(root, 'shared.sh');
    fs.writeFileSync(file, 'v1');
    fs.chmodSync(file, 0o775);
    const ws = fakeWs();
    const was = process.umask(0o022);

    try {
      handle({ id: 'mode', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'v2', sha256('v1'), {}] }, ws, {});
      expect((await ws.response('mode')).result).toMatchObject({ ok: true });
    } finally {
      process.umask(was);
    }

    expect(fs.statSync(file).mode & 0o777).toBe(0o775);
  });

  test('a private file\'s replacement bytes are never written into a file anyone else may read', async () => {
    const root = scratchDir('daemon-digest-private');
    const file = path.join(root, 'secret.env');
    fs.writeFileSync(file, 'v1');
    fs.chmodSync(file, 0o600);
    const ws = fakeWs();
    const was = process.umask(0o022);

    try {
      handle({ id: 'private', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'v2', sha256('v1'), {}] }, ws, {});
      expect((await ws.response('private')).result).toMatchObject({ ok: true });
    } finally {
      process.umask(was);
    }

    // The bytes are in the private file itself, still private, and in no other file beside it.
    expect({ bytes: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 }).toEqual({ bytes: 'v2', mode: 0o600 });
    expect(fs.readdirSync(root).filter((name) => fs.readFileSync(path.join(root, name), 'utf8').includes('v2'))).toEqual(['secret.env']);
  });

  // 2026-10-12 security review: a temp file and a rename replaced a file its owner had made read-only, and dropped its
  // owner, group and ACLs; a plain write refuses the first and keeps the rest.
  test('replaces a file in place, as a plain write does: a read-only one is refused, and every other name keeps it', async () => {
    const root = scratchDir('daemon-digest-in-place');
    const file = path.join(root, 'shared.md');
    const other = path.join(root, 'also-shared.md');
    fs.writeFileSync(file, 'v1');
    fs.linkSync(file, other);

    // Another user's file where this test may give one (as root): a replacement made by the daemon must not take it over.
    if (process.getuid?.() === 0) fs.chownSync(file, 65534, 65534);
    const before = fs.statSync(file);
    const ws = fakeWs();

    handle({ id: 'replace', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'v2', sha256('v1'), {}] }, ws, {});
    expect((await ws.response('replace')).result).toEqual({ ok: true, sha256: sha256('v2') });
    // The same file, so its owner, group, mode and ACLs are its own still, and its other name reads the new bytes.
    expect(fs.statSync(file)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode });
    expect(fs.readFileSync(other, 'utf8')).toBe('v2');

    fs.chmodSync(file, 0o444);

    try {
      handle({ id: 'read-only', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'v3', sha256('v2'), {}] }, ws, {});

      // Root writes any file, as a plain write does; anyone else is refused.
      if (process.getuid?.() === 0) expect((await ws.response('read-only')).result).toMatchObject({ ok: true });
      else {
        expect((await ws.response('read-only')).error?.code).toBe('EACCES');
        expect(fs.readFileSync(file, 'utf8')).toBe('v2');
      }
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  test('with no digest, creates the file only where none is', async () => {
    const root = scratchDir('daemon-digest-create');
    const file = path.join(root, 'new.md');
    const ws = fakeWs();

    handle({ id: 'create', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'first', null, {}] }, ws, {});
    expect((await ws.response('create')).result).toEqual({ ok: true, sha256: sha256('first') });

    handle({ id: 'again', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [file, 'second', null, {}] }, ws, {});
    expect((await ws.response('again')).result).toEqual({ ok: false, sha256: sha256('first') });
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
  });

  test('stays inside the consented directory', async () => {
    const root = scratchDir('daemon-digest-scope');
    // Outside every home, temp root and system tree the sandbox names, as the confinement tests plant.
    const outside = path.join('/dev/shm', `kinu-daemon-digest-${process.pid}.md`);
    const ws = fakeWs();

    handle({ id: 'escape', method: 'writeFileIfDigest', sandbox: scoped([root]), params: [outside, 'planted', null, {}] }, ws, {});

    expect((await ws.response('escape')).error).toBeTruthy();
    expect(fs.existsSync(outside)).toBe(false);
  });
});

describe('daemon checkpoint protocol', () => {
  test('an exec frame with a checkpoint hint snapshots before running; restore round-trips', async () => {
    const { work, ctx } = setup();

    fs.writeFileSync(path.join(work, 'data.txt'), 'original');
    const ws = fakeWs();

    handle({
      id: 'rpc-checkprex0-1', method: 'exec', sandbox: RAW, params: [`echo CLOBBERED > ${work}/data.txt && rm -f ${work}/data.txt && echo gone > ${work}/extra.txt`],
      checkpoint: { agent: 'cloud-agent', turnId: 'turn-1', sessionId: 'default', dir: work },
    }, ws, ctx);
    const exec = await ws.response('rpc-checkprex0-1');
    expect(exec.result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(work, 'data.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(work, 'extra.txt'), 'utf8').trim()).toBe('gone');

    handle({ id: 'r2', method: 'checkpointList', params: ['cloud-agent', 50] }, ws, ctx);
    const list = (await ws.response('r2')).result;
    expect(list).toHaveLength(1);
    expect(list[0].turnId).toBe('turn-1');
    expect(list[0].sessionId).toBe('default');
    expect(list[0].dir).toBe(work);

    handle({ id: 'r3', method: 'checkpointPlan', sandbox: RAW, params: ['cloud-agent', work, list[0].id] }, ws, ctx);
    const plan = (await ws.response('r3')).result;
    const kinds = Object.fromEntries(plan.files.map((f) => [f.path, f.kind]));
    expect(kinds['data.txt']).toBe('create');
    expect(kinds['extra.txt']).toBe('delete');

    handle({ id: 'r4', method: 'checkpointRestore', sandbox: RAW, params: ['cloud-agent', work, list[0].id] }, ws, ctx);
    const restore = (await ws.response('r4')).result;
    expect(restore.preRestoreId).toBeTruthy();
    expect(fs.readFileSync(path.join(work, 'data.txt'), 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(work, 'extra.txt'))).toBe(false);
  });

  test('snapshots dedupe on the turn id; a new turn snapshots again', async () => {
    const { work, ctx } = setup();

    const ws = fakeWs();
    const hint = (turnId) => ({ agent: 'a', turnId, sessionId: 's', dir: work });

    fs.writeFileSync(path.join(work, 'f.txt'), 'v1');
    handle({ id: 'rpc-ckptdedupe-1', method: 'exec', sandbox: RAW, params: ['true'], checkpoint: hint('t1') }, ws, ctx);
    await ws.response('rpc-ckptdedupe-1');
    fs.writeFileSync(path.join(work, 'f.txt'), 'v2');
    handle({ id: 'rpc-ckptdedupe-2', method: 'exec', sandbox: RAW, params: ['true'], checkpoint: hint('t1') }, ws, ctx);
    await ws.response('rpc-ckptdedupe-2');
    handle({ id: 'l1', method: 'checkpointList', params: ['a'] }, ws, ctx);
    expect((await ws.response('l1')).result).toHaveLength(1); // deduped within turn

    handle({ id: 'rpc-ckptdedupe-3', method: 'exec', sandbox: RAW, params: ['true'], checkpoint: hint('t2') }, ws, ctx);
    await ws.response('rpc-ckptdedupe-3');
    handle({ id: 'l2', method: 'checkpointList', params: ['a'] }, ws, ctx);
    expect((await ws.response('l2')).result).toHaveLength(2);
  });

  test('writeFile derives the project dir from the path when the hint has no dir', async () => {
    const { work, ctx } = setup();

    fs.writeFileSync(path.join(work, 'package.json'), '{}'); // project marker
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'a.txt'), 'original');
    const ws = fakeWs();

    handle({
      id: 'w1', method: 'writeFile', sandbox: RAW, params: [path.join(work, 'src', 'a.txt'), 'CLOBBERED'],
      checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: null },
    }, ws, ctx);
    expect((await ws.response('w1')).result).toEqual({ success: true });
    expect(fs.readFileSync(path.join(work, 'src', 'a.txt'), 'utf8')).toBe('CLOBBERED');

    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    const list = (await ws.response('l')).result;
    expect(list).toHaveLength(1);
    expect(list[0].dir).toBe(work); // walked up to the package.json marker

    handle({ id: 'r', method: 'checkpointRestore', sandbox: RAW, params: ['a', work, list[0].id] }, ws, ctx);
    await ws.response('r');
    expect(fs.readFileSync(path.join(work, 'src', 'a.txt'), 'utf8')).toBe('original');
  });

  test('a digest-checked replace under a hint is snapshotted first, and undo restores what it replaced', async () => {
    const digest = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');
    const { work, ctx } = setup();
    const file = path.join(work, 'a.txt');

    fs.writeFileSync(file, 'original');
    const ws = fakeWs();

    handle({
      id: 'w1', method: 'writeFileIfDigest', sandbox: RAW, params: [file, 'REPLACED', digest('original'), {}],
      checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: work },
    }, ws, ctx);
    expect((await ws.response('w1')).result).toEqual({ ok: true, sha256: digest('REPLACED') });

    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    const list = (await ws.response('l')).result;

    handle({ id: 'r', method: 'checkpointRestore', sandbox: RAW, params: ['a', work, list[0].id] }, ws, ctx);
    await ws.response('r');
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });

  test('frames without a checkpoint hint behave exactly as before (no snapshot)', async () => {
    const { work, ctx } = setup();

    const ws = fakeWs();
    handle({ id: 'rpc-nosnapexe0-1', method: 'exec', sandbox: RAW, params: [`echo hi > ${work}/x.txt`] }, ws, ctx);
    expect((await ws.response('rpc-nosnapexe0-1')).result.exitCode).toBe(0);
    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    expect((await ws.response('l')).result).toEqual([]);
  });

  test('a write waits for the snapshot taken before it, which holds neither it nor a frame after it', async () => {
    const git = await heldGit();
    const { work, ctx } = setup({ gitBin: git.bin });
    const target = path.join(work, 'data.txt');
    const later = path.join(work, 'later.txt');
    fs.writeFileSync(target, 'original');
    const ws = fakeWs();

    handle({
      id: 'w-hinted', method: 'writeFile', sandbox: RAW, params: [target, 'written'],
      checkpoint: { agent: 'a', turnId: 't1', sessionId: 's', dir: work },
    }, ws, ctx);
    await git.held;
    // No hint, so it asks for no snapshot of its own, and it still lands in store order.
    handle({ id: 'w-later', method: 'writeFile', sandbox: RAW, params: [later, 'later'] }, ws, ctx);

    try {
      await oneTurn();
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      expect(fs.existsSync(later)).toBe(false);
    } finally {
      await git.release();
    }

    expect((await ws.response('w-hinted')).result).toEqual({ success: true });
    expect((await ws.response('w-later')).result).toEqual({ success: true });
    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    const [checkpoint] = (await ws.response('l')).result;
    handle({ id: 'p', method: 'checkpointPlan', sandbox: RAW, params: ['a', work, checkpoint.id] }, ws, ctx);
    const kinds = Object.fromEntries((await ws.response('p')).result.files.map((f) => [f.path, f.kind]));
    expect(kinds).toEqual({ 'data.txt': 'modify', 'later.txt': 'delete' });
  });

  test('the checkpoint store runs one operation at a time, in the order they arrived', async () => {
    const git = await heldGit();
    const { work, ctx } = setup({ gitBin: git.bin });
    const order = [];

    // A raw view's store, as the owner's own machine with its Sandbox switch off: its git runs as the daemon's own.
    const raw = { raw: true };

    const snapshot = ctx.checkpoints.ensure(raw, { agent: 'a', turnId: 't1', sessionId: 's', dir: work }, work)
      .then(() => { order.push('snapshot'); });

    await git.held;
    const listed = ctx.checkpoints.list('a', 50).then(() => { order.push('list'); });
    const mutated = ctx.checkpoints.mutate(raw, null, work, () => { order.push('mutation'); });

    try {
      await oneTurn();
      expect(order).toEqual([]);
    } finally {
      await git.release();
    }

    await Promise.all([snapshot, listed, mutated]);
    expect(order).toEqual(['snapshot', 'list', 'mutation']);
  });

  test('degrades honestly when git is missing — operations still run, status says why', async () => {
    const { work, ctx } = setup({ gitBin: '/nonexistent/definitely-not-git' });

    const ws = fakeWs();
    // The mutation is never blocked by the unavailable engine.
    handle({
      id: 'rpc-degexe1120-1', method: 'exec', sandbox: RAW, params: [`echo ok > ${work}/y.txt`],
      checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: work },
    }, ws, ctx);
    expect((await ws.response('rpc-degexe1120-1')).result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(work, 'y.txt'), 'utf8').trim()).toBe('ok');

    handle({ id: 's', method: 'checkpointStatus', params: [] }, ws, ctx);
    expect((await ws.response('s')).result).toEqual({
      available: false, reason: 'checkpoints unavailable: git not found',
    });
    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    expect((await ws.response('l')).result).toEqual([]);
    handle({ id: 'r', method: 'checkpointRestore', sandbox: RAW, params: ['a', work, 'abcdef0'] }, ws, ctx);
    expect((await ws.response('r')).error).toEqual({ code: 'io', message: 'checkpoints unavailable: git not found' });
  });

  test('retention prunes to the configured keep', async () => {
    const { work, ctx } = setup({ keep: 2 });

    const ws = fakeWs();

    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(work, 'n.txt'), `v${i}`);
      handle({ id: `rpc-ckptretain-${i + 1}`, method: 'exec', sandbox: RAW, params: ['true'], checkpoint: { agent: 'a', turnId: `t${i}`, sessionId: 's', dir: work } }, ws, ctx);
      await ws.response(`rpc-ckptretain-${i + 1}`);
    }

    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    const list = (await ws.response('l')).result;
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.turnId)).toEqual(['t3', 't2']);
  });

  /**
   * The cloud path's store answers "what did THIS turn change", so a limit
   * cannot bury a checkpoint that exists. `listFileCheckpoints` forwards the
   * turn id here as the third param; before it did, the DO read a global window
   * and the web client filtered it itself, which is how a turn that had written
   * plenty was reported as "It changed no device files."
   */
  test('checkpointList narrows by turn in the store, so a limit cannot bury a turn', async () => {
    const { work, ctx } = setup();

    const ws = fakeWs();

    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(work, 'n.txt'), `v${i}`);
      handle({
        id: `rpc-ckptnarrow-${i + 1}`, method: 'exec', sandbox: RAW, params: ['true'],
        checkpoint: { agent: 'a', turnId: `t${i}`, sessionId: 's', dir: work },
      }, ws, ctx);
      await ws.response(`rpc-ckptnarrow-${i + 1}`);
    }

    // A limit of 1 keeps only the newest, so the oldest turn is outside it.
    handle({ id: 'w', method: 'checkpointList', params: ['a', 1] }, ws, ctx);
    const windowed = (await ws.response('w')).result;
    expect(windowed.map((e) => e.turnId)).toEqual(['t2']);

    // Keyed on that buried turn, the same limit returns it.
    handle({ id: 'k', method: 'checkpointList', params: ['a', 1, 't0'] }, ws, ctx);
    const keyed = (await ws.response('k')).result;
    expect(keyed).toHaveLength(1);
    expect(keyed[0].turnId).toBe('t0');

    // A turn with no checkpoint still reads empty, so the narrowing did not
    // make every turn look restorable.
    handle({ id: 'n', method: 'checkpointList', params: ['a', 50, 'never-ran'] }, ws, ctx);
    expect((await ws.response('n')).result).toEqual([]);
  });

  test('a checkpoint never covers Kinu\'s own directory', async () => {
    const { ctx } = setup();
    fs.writeFileSync(path.join(DEVICE_HOME, 'device.key'), 'the machine key, never in a store\n', { mode: 0o600 });
    const ws = fakeWs();

    // A daemon that updated itself runs from its own directory, and a hint
    // with no directory once fell back to that working directory.
    handle({
      id: 'rpc-kinuckpt00-1', method: 'exec', sandbox: RAW, params: ['true'],
      checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: DEVICE_HOME },
    }, ws, ctx);
    const { result } = await ws.response('rpc-kinuckpt00-1');
    expect(result.exitCode).toBe(0);
    expect(result.uncheckpointed).toEqual({ dir: fs.realpathSync(DEVICE_HOME), why: expect.stringContaining('Kinu\'s own directory') });
    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    expect((await ws.response('l')).result).toEqual([]);
  });

  test('a sandboxed frame snapshots and restores only what it may write', async () => {
    const { work, ctx } = setup();
    const outside = path.join('/dev/shm', `kinu-ckpt-outside-${process.pid}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'kept.txt'), 'owner-bytes');
    const scoped = { tier: 'sandboxed', agentHome: path.join(DEVICE_HOME, 'agents', 'ws-1', 'home'), roots: [work] };
    const ws = fakeWs();

    try {
      handle({
        id: 'w-outside', method: 'writeFile', sandbox: scoped, params: [path.join(work, 'a.txt'), 'x'],
        checkpoint: { agent: 'a', turnId: 't1', sessionId: 's', dir: outside },
      }, ws, ctx);
      // The write lands, and says that no checkpoint covers it.
      expect((await ws.response('w-outside')).result).toEqual({
        success: true,
        uncheckpointed: { dir: outside, why: expect.stringContaining('outside what this device\'s sandbox exposes') },
      });
      handle({ id: 'l1', method: 'checkpointList', params: ['a'] }, ws, ctx);
      expect((await ws.response('l1')).result.map((entry) => entry.dir)).not.toContain(outside);

      // A store for that directory from a raw frame exists; a sandboxed frame
      // still cannot restore into it.
      handle({
        id: 'rpc-rawckpt000-1', method: 'exec', sandbox: RAW, params: ['true'],
        checkpoint: { agent: 'a', turnId: 't2', sessionId: 's', dir: outside },
      }, ws, ctx);
      await ws.response('rpc-rawckpt000-1');
      handle({ id: 'l2', method: 'checkpointList', params: ['a', 50, 't2'] }, ws, ctx);
      const [taken] = (await ws.response('l2')).result;
      fs.writeFileSync(path.join(outside, 'kept.txt'), 'owner-edited');
      handle({ id: 'r', method: 'checkpointRestore', sandbox: scoped, params: ['a', outside, taken.id] }, ws, ctx);
      expect((await ws.response('r')).error?.message).toContain('does not expose');
      expect(fs.readFileSync(path.join(outside, 'kept.txt'), 'utf8')).toBe('owner-edited');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('an unsandboxed command with no directory runs in the consented one, never the daemon\'s own', async () => {
    const { work } = setup();
    const ws = fakeWs();

    handle({ id: 'rpc-rawcwd0000-1', method: 'exec', sandbox: { ...RAW, roots: [work] }, params: ['pwd'] }, ws, {});
    expect((await ws.response('rpc-rawcwd0000-1')).result.stdout.trim()).toBe(fs.realpathSync(work));
  });
});

/**
 * The device half of the toolchain probe. The hub sends the binary names from
 * core's single table and this answers which of THOSE the machine has; the
 * answer becomes the `device` capability row the model routes work by.
 */
describe('daemon toolchain probe', () => {
  function withPath(dir, fn) {
    const previous = process.env.PATH;
    process.env.PATH = dir;

    try {
      return fn();
    } finally {
      process.env.PATH = previous;
    }
  }

  /** A PATH directory holding executables named `names`. */
  function pathWith(names) {
    const dir = scratchDir('which');

    for (const name of names) {
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
    }

    return dir;
  }

  test('answers only about the names it was asked, and only those that resolve', async () => {
    const dir = pathWith(['node', 'git']);

    const ws = fakeWs();
    withPath(dir, () => handle({ id: 'which-1', method: 'which', params: [['node', 'bun', 'git', 'python3']] }, ws, {}));

    // `bun` and `python3` are not there. Reported as absent, which is a
    // measurement — distinct from the hub never getting an answer at all.
    expect((await ws.response('which-1')).result).toEqual({ present: ['node', 'git'] });
  });

  test('a non-executable file of the right name is not a binary on PATH', async () => {
    const dir = scratchDir('which');
    fs.writeFileSync(path.join(dir, 'python3'), 'not a program', { mode: 0o644 });

    const ws = fakeWs();
    withPath(dir, () => handle({ id: 'which-1', method: 'which', params: [['python3']] }, ws, {}));

    // The capability reads "Runs Python". A file nobody can execute does not.
    expect((await ws.response('which-1')).result).toEqual({ present: [] });
  });

  test('refuses to answer for anything but a bare binary name', async () => {
    const dir = pathWith(['node']);

    const ws = fakeWs();
    // The probe must not become a way to ask whether paths on the user's
    // machine exist. Names carrying a separator are dropped, not resolved —
    // even one that would obviously succeed.
    withPath(dir, () => handle({
      id: 'which-1',
      method: 'which',
      params: [['../etc/passwd', '/bin/sh', 'node/../node', 'node']],
    }, ws, {}));

    expect((await ws.response('which-1')).result).toEqual({ present: ['node'] });
  });

  test('a malformed question is an error frame, never a confident empty answer', async () => {
    const ws = fakeWs();
    handle({ id: 'which-1', method: 'which', params: ['node'] }, ws, {});

    // `{present: []}` here would tell the hub this machine has no toolchain.
    expect((await ws.response('which-1')).error?.message).toMatch(/array of binary names/);
  });
});

// ── The daemon as a process, under its one runtime ─────────────────────
//
// The suites above exercise handle() in this process. This one runs the REAL
// daemon as a child — spawned with process.execPath (Bun) the same way
// device-connect's daemonRuntime does — against a local fake hub speaking the
// /pc/connect-challenge + /pc/connect-ticket + /pc/connect upgrade protocol. It
// proves the daemon's CommonJS source, node: builtins, child_process
// supervision, fs.watch in-flight waits and the global WebSocket all work
// under Bun, by running them: AUTH and HELLO on connect, the connect
// generation stored, an exec round-trip, execCancel, a file op, and reconnect
// after the socket drops.

describe('daemon process under Bun against a local hub', () => {
  const DAEMON_PATH = path.join(__dirname, '..', 'src', 'index.js');

  function makeConfig(root, origin) {
    const config = deviceConfig({ device: 'device-1', origin, root });
    const configPath = path.join(root, 'device.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'device.key'), deviceKey().pem, { mode: 0o600 });

    return { config, configPath };
  }

  /**
   * A local hub: the challenge and the ticket exchange over HTTP, the connect
   * upgrade over WebSocket, and one captured frame stream with a JSON-frame
   * reply helper. Each upgrade's URL and account header are kept. The daemon
   * treats it exactly as it treats production — no test hooks inside the
   * daemon.
   */
  function startFakeHub() {
    const frames = [];
    const sockets = [];
    const upgrades = [];

    const hub = Bun.serve({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === '/pc/connect-challenge') {
          return Response.json({ nonce: `pcc_${'n'.repeat(43)}`, expiresAt: Date.now() + 60_000 });
        }

        if (url.pathname === '/pc/connect-ticket') {
          return Response.json({ ticket: `pct_${'b'.repeat(32)}`, expiresAt: Date.now() + 60_000 });
        }

        if (url.pathname === '/pc/connect') {
          upgrades.push({ url: req.url, account: req.headers.get('x-kinu-auth-account') });

          if (server.upgrade(req)) return;

          return new Response('upgrade failed', { status: 400 });
        }

        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(socket) { sockets.push(socket); },
        message(socket, message) {
          const frame = JSON.parse(String(message));
          frames.push(frame);

          if (frame.type === 'HELLO') {
            // Echo the runtime the daemon is actually running on, so the
            // assertion reads what ran, not what was spawned.
            socket.send(JSON.stringify({ type: 'ping', runtime: process.versions.bun ? 'bun' : 'node' }));
          }
        },
      },
    });

    return {
      origin: `http://localhost:${hub.port}`,
      frames,
      upgrades,
      socket() { return sockets[sockets.length - 1]; },
      close() { return hub.stop(true); },
    };
  }

  /** Spawn the daemon as a real child process, the runtime device-connect uses. */
  function spawnDaemon(root, extraEnv) {
    const logPath = path.join(root, 'pc-agent.log');
    const logFd = fs.openSync(logPath, 'a');

    const child = Bun.spawn({
      cmd: [process.execPath, DAEMON_PATH],
      // A scratch HOME unless the case names one: a raw terminal's shell runs as the owner, so with the developer's
      // HOME every command typed into it landed in their ~/.bash_history.
      env: { ...process.env, HOME: scratchDir('daemon-home'), KINU_HOME: root, KINU_INFLIGHT_ROOT: path.join(root, 'inflight'), ...extraEnv },
      // Stdio to the log FILE, never pipes: bun's runner exits when the last
      // open handle closes, and a piped child holds its pipe open for as long
      // as it lives. The log is read from the file, so nothing needs the pipe.
      stdout: logFd,
      stderr: logFd,
      stdin: 'ignore',
    });

    fs.closeSync(logFd);

    return { child, logPath };
  }

  /** Poll the hub's frame list until a predicate holds, or fail with why. */
  async function untilHub(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const found = predicate();

      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return null;
  }

  /** Reads one reply frame by request id, or fails naming the daemon's log. */
  function replyReader(hub, daemonLog) {
    return async (id, timeoutMs = 15_000) => {
      const frame = await untilHub(() => hub.frames.find((f) => f.id === id), timeoutMs);

      if (!frame) throw new Error(`no reply for ${id}: log says ${daemonLog()}`);

      return frame;
    };
  }

  /** Any supervisor the body left un-acked: each in-flight record names its
   *  process group, which writes into the request's directory until it exits.
   *  Killing by the daemon child's group is not possible — `Bun.spawn` above
   *  is not detached. */
  async function killInflightSupervisors(root) {
    const inflight = path.join(root, 'inflight');

    if (!fs.existsSync(inflight)) return;

    for (const entry of fs.readdirSync(inflight)) {
      const supervisor = recordedIn(path.join(inflight, entry, 'state'), inflight, /^pid=(\d+)$/m);

      if (supervisor !== null) await killAndAwaitExit(supervisor, { group: true });
    }
  }

  test('a daemon whose first reconciliation fails refuses to start in its own words', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = scratchDir('daemon-unreconciled');
    makeConfig(root, 'http://127.0.0.1:9');
    const notADirectory = path.join(root, 'inflight-is-a-file');
    fs.writeFileSync(notADirectory, '');
    const { child, logPath } = spawnDaemon(root, { KINU_INFLIGHT_ROOT: notADirectory });

    // Startup awaits the reconciliation only after claiming the machine and
    // probing the sandbox; a rejection nobody handled by then ends Bun first.
    expect(await child.exited).toBe(1);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(`Kinu PC agent: ENOTDIR: not a directory, scandir '${notADirectory}'`);
  });

  test('AUTH then HELLO on connect, the connect generation, exec, cancel, file op, and reconnect — all under Bun', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = scratchDir('daemon-e2e');
    // Outside KINU_HOME on purpose: Kinu's own directory is never served
    // through the tunnel (see the credential-fence test below), so a file op
    // that proves the socket works must target a consented directory instead.
    const files = scratchDir('daemon-e2e-files');

    const hub = startFakeHub();

    try {
      // The daemon reads its origin from device.json, so the config lands
      // after the hub exists and names the hub's real port.
      makeConfig(root, hub.origin);
      const { child, logPath } = spawnDaemon(root);

      try {
        // HELLO arrives with the runtime identity only a real Bun carries.
        const hello = await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'));
        expect(hello).not.toBeNull();
        expect(hello.user).toBe('user-1');
        expect(hello.pid).toBeGreaterThan(0);
        const daemonLog = () => fs.readFileSync(logPath, 'utf-8');

        // AUTH is the socket's first frame, the ticket in it; the URL carries
        // neither the ticket nor the account, which rides in its header.
        expect(hub.frames[0]).toEqual({ type: 'AUTH', user: 'user-1', ticket: `pct_${'b'.repeat(32)}` });
        expect(hub.upgrades).toEqual([{ url: `${hub.origin}/pc/connect`, account: 'user-1' }]);

        // GENERATION: the hub hands the next connect generation; the daemon
        // stores it and answers, and the hub commits it on that answer.
        hub.socket().send(JSON.stringify({ type: 'GENERATION', generation: 1 }));
        expect(await untilHub(() => hub.frames.find((f) => f.type === 'GENERATION_ACK'))).toEqual({ type: 'GENERATION_ACK', generation: 1 });
        expect(JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).generation).toBe(1);

        const reply = replyReader(hub, daemonLog);

        // exec round-trip through the real supervisor under Bun. The result
        // frame is then ACKED — the supervisor publishes its ack FIFO before
        // the result and exits only once the cloud confirms receipt, so an
        // un-acked exec leaves a detached grandchild holding this runner's
        // process table open after the test ends.
        hub.socket().send(JSON.stringify({ id: 'rpc-e2eexec00A-1', method: 'exec', sandbox: RAW, params: ['echo hello-from-daemon'] }));
        const execResult = await reply('rpc-e2eexec00A-1');
        expect(execResult.result.exitCode).toBe(0);
        expect(execResult.result.stdout).toContain('hello-from-daemon');
        hub.socket().send(JSON.stringify({ id: 'rpc-e2eack00A-1', method: 'execAck', params: ['rpc-e2eexec00A-1', 1] }));
        await reply('rpc-e2eack00A-1');

        // execCancel: a command that outlives its cancellation window.
        hub.socket().send(JSON.stringify({ id: 'rpc-e2ecancelf-1', method: 'exec', sandbox: RAW, params: ['sleep 30'] }));
        await untilHub(() => fs.existsSync(path.join(root, 'inflight', 'rpc-e2ecancelf-1', 'state')));
        hub.socket().send(JSON.stringify({ id: 'rpc-e2ecanclX-1', method: 'cancel', params: ['rpc-e2ecancelf-1', 1] }));
        const cancelResult = await reply('rpc-e2ecanclX-1');
        expect(cancelResult.result).toEqual({ requestId: 'rpc-e2ecancelf-1', cancelled: 'terminated' });
        // A cancelled command's request directory is removed by the cancel
        // itself; nothing waits on an ack. Confirm the tree is gone so the
        // teardown below cannot race a live supervisor.
        await untilHub(() => !fs.existsSync(path.join(root, 'inflight', 'rpc-e2ecancelf-1')));

        // file op: an absolute path the owner could have consented to.
        const note = path.join(files, 'note.txt');
        hub.socket().send(JSON.stringify({ id: 'rpc-e2efile0-1', method: 'writeFile', sandbox: RAW, params: [note, 'bun wrote this'] }));
        const writeResult = await reply('rpc-e2efile0-1');
        expect(writeResult.result).toEqual({ success: true });
        expect(fs.readFileSync(note, 'utf-8')).toBe('bun wrote this');

        // Reconnect after a socket drop: the hub closes; the daemon redials.
        hub.socket().close();
        const hello2 = await untilHub(() => hub.frames.filter((f) => f.type === 'HELLO')[1]);
        expect(hello2).not.toBeNull();
      } finally {
        // Teardown owns three things the runner's exit depends on: the daemon
        // child (SIGTERM, then reaped through .exited), the in-flight root,
        // and the hub.
        child.kill('SIGTERM');
        await child.exited;
        await killInflightSupervisors(root);
      }
    } finally {
      await hub.close();
    }
  });

  /**
   * One connected daemon, torn down. Composed from the four helpers above so
   * each hardening case below is its own named failure rather than another
   * phase inside the sequence test.
   */
  /** `root` is the daemon's KINU_HOME. */
  async function withDaemon(extraEnv, body, root = scratchDir('daemon-case')) {
    const hub = startFakeHub();

    try {
      makeConfig(root, hub.origin);
      const { child, logPath } = spawnDaemon(root, extraEnv);
      const daemonLog = () => fs.readFileSync(logPath, 'utf-8');

      try {
        const hello = await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'));

        if (!hello) throw new Error(`daemon never connected: log says ${daemonLog()}`);

        const reply = replyReader(hub, daemonLog);

        await body({ hub, root, child, reply, daemonLog });
      } finally {
        child.kill('SIGTERM');
        await child.exited;
        await killInflightSupervisors(root);
      }
    } finally {
      await hub.close();
    }
  }

  async function until(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (predicate()) return true;

      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // F2. ~/.kinu holds device.key (this machine's private key) and config.json
  // (the owner's interactive CLI bearer). Reading either one turns a file
  // grant into the tier that granted it, so the fence does not depend on
  // which root the call carries: these frames are the raw tier, with the
  // owner's Sandbox switch off — the strongest thing a workspace can hold.
  test('Kinu\'s own directory is never served through the tunnel, at any tier', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    await withDaemon(undefined, async ({ hub, root, reply }) => {
      fs.writeFileSync(path.join(root, 'config.json'), '{"accessToken":"ptc_owner_bearer"}', { mode: 0o600 });

      const refused = [
        ['rpc-fence00rd-1', 'readRange', [path.join(root, 'config.json'), 0, 64]],
        ['rpc-fence00dv-1', 'readRange', [path.join(root, 'device.json'), 0, 64]],
        ['rpc-fence00ky-1', 'readRange', [path.join(root, 'device.key'), 0, 64]],
        ['rpc-fence00ls-1', 'listFiles', [root]],
        ['rpc-fence00st-1', 'statPath', [path.join(root, 'device.json')]],
        ['rpc-fence00wr-1', 'writeFile', [path.join(root, 'device.json'), '{"token":"attacker"}']],
        ['rpc-fence00un-1', 'unlinkPath', [path.join(root, 'device.json')]],
        ['rpc-fence00rm-1', 'rmdirPath', [root]],
        ['rpc-fence00mk-1', 'mkdirPath', [path.join(root, 'planted')]],
      ];

      for (const [id, method, params] of refused) {
        hub.socket().send(JSON.stringify({ id, method, sandbox: RAW, params }));
        const frame = await reply(id);
        // Result first: an un-fenced daemon answers with the credential
        // itself, and that is the sentence the failure should print.
        expect(frame.result).toBeUndefined();
        expect(frame.error?.message).toContain("inside Kinu's own directory");
      }

      // The credentials are intact and the plant did not land.
      expect(fs.readFileSync(path.join(root, 'config.json'), 'utf-8')).toContain('ptc_owner_bearer');
      expect(fs.existsSync(path.join(root, 'device.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'planted'))).toBe(false);

      // A symlink is refused by where it LANDS, not by how it is spelled.
      const bait = path.join(os.tmpdir(), `kinu-fence-bait-${process.pid}`);
      fs.symlinkSync(path.join(root, 'device.json'), bait);

      try {
        hub.socket().send(JSON.stringify({ id: 'rpc-fence00sy-1', method: 'readRange', sandbox: RAW, params: [bait, 0, 64] }));
        expect((await reply('rpc-fence00sy-1')).error?.message).toContain("inside Kinu's own directory");
      } finally {
        fs.rmSync(bait, { force: true });
      }
    });
  });

  // F3. The answer is what the hub commits, so a generation this daemon could
  // NOT store must not be answered: the one still on its disk is what its next
  // connect signs, and the hub has to still hold it, or the machine reads as a
  // second holder of its key.
  test('a generation it could not store is not acknowledged', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    await withDaemon(undefined, async ({ hub, root, daemonLog }) => {
      // The store is the directory, so making it unwritable is what makes the
      // atomic rename fail — the same way a full or read-only disk would.
      fs.chmodSync(root, 0o500);

      try {
        hub.socket().send(JSON.stringify({ type: 'GENERATION', generation: 1 }));
        await untilHub(() => daemonLog().includes('Connect generation could not be stored:'));
        expect(daemonLog()).toContain('Connect generation could not be stored:');
        // The old generation is still the one on disk, and nothing told the
        // hub otherwise.
        expect(JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).generation).toBe(0);
        expect(hub.frames.filter((frame) => frame.type === 'GENERATION_ACK')).toEqual([]);
      } finally {
        fs.chmodSync(root, 0o700);
      }
    });
  });

  // The owner's direction: one shell, bash, resolved on the machine's PATH.
  // `/bin/sh` is dash on Debian and Ubuntu, so a command the model wrote with
  // `[[ `, `set -o pipefail` or an array ran on some machines and failed on
  // others. There is no sh fallback: two shells is two behaviours.
  test('a command runs under bash, so bash-only syntax is not a machine lottery', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    await withDaemon(undefined, async ({ hub, reply }) => {
      hub.socket().send(JSON.stringify({
        id: 'rpc-bashsyntax-1',
        method: 'exec',
        sandbox: RAW,
        params: ['set -o pipefail; [[ 1 == 1 ]] && printf %s "bash=${BASH_VERSION%%.*}"'],
      }));
      const ran = await reply('rpc-bashsyntax-1');
      expect(ran.error).toBeUndefined();
      expect(ran.result.exitCode).toBe(0);
      // The version is bash's own answer, so this cannot pass under a shell
      // that merely tolerated the syntax.
      expect(ran.result.stdout).toMatch(/^bash=\d+$/);
      hub.socket().send(JSON.stringify({ id: 'rpc-bashack00-1', method: 'execAck', params: ['rpc-bashsyntax-1', 1] }));
      await reply('rpc-bashack00-1');
    });
  });

  // The sandbox, through the socket: the hub DECIDES the tier and the daemon
  // enforces it, so this is the frame a hub with the switch on sends.
  test('a sandboxed exec runs in the agent home and cannot reach the machine', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    await withDaemon(undefined, async ({ hub, root, reply }) => {
      const agentHome = path.join(root, 'agents', 'ws-1', 'home');
      const consented = scratchDir('daemon-consented');

      hub.socket().send(JSON.stringify({
        id: 'rpc-sandboxrun-1',
        method: 'exec',
        // The hub computes the agent home per (device, workspace) beneath the
        // agentRoot the daemon reported on HELLO; the daemon creates it 0700
        // on first use, which is what this asserts by not creating it here.
        sandbox: { tier: 'sandboxed', agentHome, roots: [consented] },
        params: [[
          'echo HOME=$HOME',
          'printf agent > "$HOME/mine" && echo home-write-ok',
          `printf root > ${JSON.stringify(path.join(consented, 'mine'))} && echo root-write-ok`,
          'touch /usr/local/nope 2>&1 | head -1',
          'echo KINU_SANDBOX=$KINU_SANDBOX',
        ].join('; ')],
      }));
      const ran = await reply('rpc-sandboxrun-1');
      expect(ran.error).toBeUndefined();
      expect(ran.result.stdout).toContain('home-write-ok');
      expect(ran.result.stdout).toContain('root-write-ok');
      expect(ran.result.stdout).toContain('Read-only file system');
      expect(ran.result.stdout).toContain('KINU_SANDBOX=1');
      // The bytes landed where the model was told they would, on the
      // machine's own filesystem, and the agent home was created 0700.
      expect(fs.readFileSync(path.join(agentHome, 'mine'), 'utf-8')).toBe('agent');
      expect(fs.readFileSync(path.join(consented, 'mine'), 'utf-8')).toBe('root');
      expect(fs.statSync(agentHome).mode & 0o777).toBe(0o700);
      hub.socket().send(JSON.stringify({ id: 'rpc-sandboxack-1', method: 'execAck', params: ['rpc-sandboxrun-1', 1] }));
      await reply('rpc-sandboxack-1');
    });
  });

  /** A machine whose owner ran `kinu connect` from ~, consenting the home that holds Kinu's own directory. */
  function homeRootedMachine() {
    const machine = fs.realpathSync(scratchDir('daemon-machine'));
    const root = path.join(machine, '.kinu');
    const agentHome = path.join(root, 'agents', 'ws-1', 'home');
    fs.mkdirSync(agentHome, { recursive: true, mode: 0o700 });

    return { machine, root, agentHome, block: { tier: 'sandboxed', agentHome, roots: [machine] } };
  }

  test('a consented home never shadows the agent home, and undo restores what a command wrote there', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const { machine, root, agentHome, block } = homeRootedMachine();
    fs.writeFileSync(path.join(agentHome, 'x'), 'before');

    await withDaemon({ HOME: machine }, async ({ hub, reply }) => {
      hub.socket().send(JSON.stringify({
        id: 'rpc-homeroot00-1', method: 'exec', sandbox: block, params: ['printf changed > "$HOME/x"'],
        checkpoint: { agent: 'ws-1', turnId: 't1', sessionId: 's', dir: null },
      }));
      const ran = await reply('rpc-homeroot00-1');
      expect(ran.error).toBeUndefined();
      expect(fs.existsSync(path.join(machine, 'x'))).toBe(false);
      expect(fs.readFileSync(path.join(agentHome, 'x'), 'utf8')).toBe('changed');
      expect(ran.result.uncheckpointed).toBeUndefined();
      hub.socket().send(JSON.stringify({ id: 'rpc-homeack000-1', method: 'execAck', params: ['rpc-homeroot00-1', 1] }));
      await reply('rpc-homeack000-1');

      hub.socket().send(JSON.stringify({ id: 'home-list', method: 'checkpointList', params: ['ws-1', 50, 't1'] }));
      const [taken] = (await reply('home-list')).result;
      expect(taken.dir).toBe(agentHome);
      hub.socket().send(JSON.stringify({ id: 'home-plan', method: 'checkpointPlan', sandbox: block, params: ['ws-1', agentHome, taken.id] }));
      expect((await reply('home-plan')).result.files).toEqual([{ path: 'x', kind: 'modify' }]);
      hub.socket().send(JSON.stringify({ id: 'home-restore', method: 'checkpointRestore', sandbox: block, params: ['ws-1', agentHome, taken.id] }));
      expect((await reply('home-restore')).error).toBeUndefined();
      expect(fs.readFileSync(path.join(agentHome, 'x'), 'utf8')).toBe('before');
    }, root);
  });

  test("a sandboxed session keeps its history in the agent's home, never the machine's, and its close deletes it", async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const { machine, root, agentHome, block } = homeRootedMachine();

    await withDaemon({ HOME: machine }, async ({ hub, reply }) => {
      hub.socket().send(JSON.stringify({ id: 'rpc-boxhist00-1', method: 'ptyOpen', workspace: 'ws-1', sandbox: block, params: [80, 24] }));
      const { session } = (await reply('rpc-boxhist00-1')).result;
      const history = path.join(agentHome, '.terminals', `${session}.history`);

      hub.socket().send(JSON.stringify({ type: 'PTY_IN', session, data: Buffer.from('echo boxed-$((2 * 3)); exit\r').toString('base64') }));
      expect(await untilHub(() => hub.frames.find((f) => f.type === 'PTY_EXIT' && f.session === session))).not.toBeNull();
      const kept = fs.readFileSync(history, 'utf8');

      hub.socket().send(JSON.stringify({ id: 'rpc-boxhist00-2', method: 'ptyClose', workspace: 'ws-1', params: [session] }));
      await reply('rpc-boxhist00-2');

      expect({ kept: kept.includes('echo boxed-$((2 * 3))'), machine: fs.existsSync(path.join(machine, '.bash_history')), closed: fs.existsSync(history) })
        .toEqual({ kept: true, machine: false, closed: false });
    }, root);
  });

  test('a command\'s checkpoint covers its working tree, and one run from the home itself says undo cannot', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const { machine, root, block } = homeRootedMachine();
    const project = path.join(machine, 'shop');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(project, 'src'));
    fs.writeFileSync(path.join(project, 'README.md'), 'shop');
    // The home takes no new entry directly in it while it lacks a run-later file (sandbox.js guardedPaths), so the
    // command run from it changes a file already there.
    fs.writeFileSync(path.join(machine, 'notes.txt'), 'owner');

    await withDaemon({ HOME: machine }, async ({ hub, reply }) => {
      hub.socket().send(JSON.stringify({
        id: 'rpc-worktree00-1', method: 'exec', sandbox: block, cwd: path.join(project, 'src'), params: ['printf a > a.txt'],
        checkpoint: { agent: 'ws-1', turnId: 't1', sessionId: 's', dir: null },
      }));
      expect((await reply('rpc-worktree00-1')).result.uncheckpointed).toBeUndefined();
      hub.socket().send(JSON.stringify({ id: 'tree-list', method: 'checkpointList', params: ['ws-1', 50, 't1'] }));
      expect((await reply('tree-list')).result.map((entry) => entry.dir)).toEqual([project]);

      hub.socket().send(JSON.stringify({
        id: 'rpc-homecwd000-1', method: 'exec', sandbox: block, cwd: machine, params: ['printf direct > notes.txt'],
        checkpoint: { agent: 'ws-1', turnId: 't2', sessionId: 's', dir: null },
      }));
      const direct = await reply('rpc-homecwd000-1');
      expect(fs.readFileSync(path.join(machine, 'notes.txt'), 'utf8')).toBe('direct');
      expect(direct.result.uncheckpointed).toEqual({ dir: machine, why: expect.stringContaining('home folder itself') });
      hub.socket().send(JSON.stringify({ id: 'home-cwd-list', method: 'checkpointList', params: ['ws-1', 50, 't2'] }));
      expect((await reply('home-cwd-list')).result).toEqual([]);

      for (const [ack, id] of [['rpc-treeack000-1', 'rpc-worktree00-1'], ['rpc-homeack001-1', 'rpc-homecwd000-1']]) {
        hub.socket().send(JSON.stringify({ id: ack, method: 'execAck', params: [id, 1] }));
        await reply(ack);
      }
    }, root);
  });

  test('a daemon whose KINU_HOME is elsewhere keeps its checkpoints and in-flight commands there', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const owner = fs.realpathSync(scratchDir('daemon-owner-home'));
    const project = path.join(owner, 'shop');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });

    await withDaemon({ HOME: owner, KINU_INFLIGHT_ROOT: '' }, async ({ hub, root, reply }) => {
      hub.socket().send(JSON.stringify({
        id: 'rpc-kinuhome00-1', method: 'exec', sandbox: RAW, cwd: project, params: ['printf a > a.txt'],
        checkpoint: { agent: 'ws-1', turnId: 't1', sessionId: 's', dir: null },
      }));
      await reply('rpc-kinuhome00-1');
      // Under the device home, which every sandbox masks, and never under a ~/.kinu a consented home would expose.
      expect(fs.existsSync(path.join(root, 'inflight', 'rpc-kinuhome00-1'))).toBe(true);
      expect(fs.readdirSync(path.join(root, 'checkpoints'))).toEqual(['ws-1']);
      expect(fs.existsSync(path.join(owner, '.kinu'))).toBe(false);
      hub.socket().send(JSON.stringify({ id: 'rpc-kinuhomeak-1', method: 'execAck', params: ['rpc-kinuhome00-1', 1] }));
      await reply('rpc-kinuhomeak-1');
    });
  });

  test('a sandboxed command spills into its own tmp, named as its shell and the file methods name it', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    await withDaemon(undefined, async ({ hub, root, reply }) => {
      const block = { tier: 'sandboxed', agentHome: path.join(root, 'agents', 'ws-spill', 'home'), roots: [] };
      // System tools only: the runtime that runs this suite lives in a home the sandbox hides.
      const noisy = "head -c 600000 /dev/zero | tr '\\0' x; printf END";

      hub.socket().send(JSON.stringify({ id: 'rpc-noisysbx00-1', method: 'exec', sandbox: block, params: [noisy] }));
      const ran = await reply('rpc-noisysbx00-1');
      const shown = '/tmp/kinu-tool-output/device-rpc-noisysbx00-1.stdout.log';
      expect(ran.result.stdout).toContain(`the full stdout is at ${shown}]`);

      hub.socket().send(JSON.stringify({ id: 'rpc-readspill0-1', method: 'readRange', sandbox: block, params: [shown, 599_990, 20] }));
      const tail = await reply('rpc-readspill0-1');
      expect(Buffer.from(tail.result.content, 'base64').toString('utf8')).toBe('xxxxxxxxxxEND');
      hub.socket().send(JSON.stringify({ id: 'rpc-noisyack00-1', method: 'execAck', params: ['rpc-noisysbx00-1', 1] }));
      await reply('rpc-noisyack00-1');
    });
  });

  // L111 #3: a checkpoint directory was judged when its frame arrived, then git ran there by path, unsandboxed, once
  // the queue reached it; a command swapping it for a link out of the root in between had the restore rewrite and
  // delete what the link led to. Its git now runs in the frame's sandbox, where such a link leads nowhere.
  test('a restore whose directory a command swaps for a link out of the root while it waits changes nothing there', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const shared = scratchDir('daemon-ckpt-swap');
    const project = path.join(shared, 'project');
    const inner = path.join(project, 'inner');
    const other = path.join(project, 'other');
    const outside = path.join(shared, 'outside');

    for (const dir of [inner, other, outside]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(inner, 'target.txt'), 'inside');
    fs.writeFileSync(path.join(outside, 'target.txt'), 'the owner\'s');
    fs.writeFileSync(path.join(outside, 'owner-only.txt'), 'the owner\'s alone');
    // A git first on the daemon's PATH that holds a staging once armed, inside the root so the frame's sandbox runs it too.
    const held = path.join(project, '.held-git');
    fs.mkdirSync(held);
    const fifo = await runToExit(['mkfifo', path.join(held, 'release')]);

    if (fifo.exitCode !== 0) throw new Error(`mkfifo failed: ${fifo.stderr}`);
    const realGit = (await runToExit(['bash', '-c', 'command -v git'])).stdout.trim();
    fs.writeFileSync(path.join(held, 'git'), [
      '#!/bin/bash',
      `if [ "$1" = add ] && [ -e '${held}/armed' ] && mkdir '${held}/holding' 2>/dev/null; then read -r _ < '${held}/release'; fi`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });

    const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort((a, b) => a.localeCompare(b))
      .map((name) => [name, fs.lstatSync(path.join(dir, name)).isFile() ? fs.readFileSync(path.join(dir, name), 'utf8') : 'dir']);

    await withDaemon({ PATH: `${held}:${process.env.PATH}` }, async ({ hub, root, reply }) => {
      const block = { tier: 'sandboxed', agentHome: path.join(root, 'agents', 'ws-swap', 'home'), roots: [project] };
      const hint = (turnId, dir) => ({ agent: 'a', turnId, sessionId: 's', dir });
      const send = (frame) => { hub.socket().send(JSON.stringify(frame)); };

      send({ id: 'w1', method: 'writeFile', sandbox: block, params: [path.join(inner, 'seed.txt'), 'seed'], checkpoint: hint('t1', inner) });
      expect((await reply('w1')).result?.success).toBe(true);
      send({ id: 'l1', method: 'checkpointList', params: ['a', 50, 't1'] });
      const [taken] = (await reply('l1')).result;
      const outsideBefore = tree(outside);

      // A snapshot ahead of the restore is held, so the restore is judged now and runs after the swap.
      fs.writeFileSync(path.join(held, 'armed'), '');
      send({ id: 'w2', method: 'writeFile', sandbox: block, params: [path.join(other, 'x.txt'), 'x'], checkpoint: hint('t2', other) });
      expect(await until(() => fs.existsSync(path.join(held, 'holding')), 20_000)).toBe(true);
      send({ id: 'r', method: 'checkpointRestore', sandbox: block, params: ['a', inner, taken.id] });
      // Frames are handled in their order: a stat's answer means the restore before it was judged and queued.
      send({ id: 'judged', method: 'statPath', sandbox: block, params: [inner] });
      await reply('judged');
      fs.renameSync(inner, path.join(project, 'inner-old'));
      fs.symlinkSync(outside, inner);
      await fs.promises.writeFile(path.join(held, 'release'), 'go\n');

      const restored = await reply('r');
      await reply('w2');
      expect({ refused: restored.error?.message, outside: tree(outside) }).toEqual({
        refused: `checkpoint directory '${inner}' is no longer inside ${project}, which this workspace was given on this device: something in its path now leads out of it, so no checkpoint reads or restores it`,
        outside: outsideBefore,
      });
    });
  });

  // L111 #3: the same restore, confined, with nothing swapped: the tree comes back, and what was made since goes.
  test('a confined restore puts the tree back and removes what was made since it', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    const work = path.join(scratchDir('daemon-ckpt-confined'), 'project');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'kept.txt'), 'before');

    await withDaemon(undefined, async ({ hub, root, reply }) => {
      const block = { tier: 'sandboxed', agentHome: path.join(root, 'agents', 'ws-restore', 'home'), roots: [work] };
      const send = (frame) => { hub.socket().send(JSON.stringify(frame)); };

      send({ id: 'w', method: 'writeFile', sandbox: block, params: [path.join(work, 'seed.txt'), 'seed'], checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: work } });
      await reply('w');
      send({ id: 'l', method: 'checkpointList', params: ['a', 50, 't'] });
      const [taken] = (await reply('l')).result;
      fs.writeFileSync(path.join(work, 'kept.txt'), 'after');
      fs.mkdirSync(path.join(work, 'made'));
      fs.writeFileSync(path.join(work, 'made', 'since.txt'), 'new');

      send({ id: 'r', method: 'checkpointRestore', sandbox: block, params: ['a', work, taken.id] });
      const restored = await reply('r');

      expect({ error: restored.error, kept: fs.readFileSync(path.join(work, 'kept.txt'), 'utf8'), since: fs.existsSync(path.join(work, 'made', 'since.txt')), seed: fs.existsSync(path.join(work, 'seed.txt')) })
        .toEqual({ error: undefined, kept: 'before', since: false, seed: false });
    });
  });

  // L111 #1: a sandboxed command writes its own tmp, so it can put a link where a later command's output spills. The
  // supervisor, unsandboxed, followed it and wrote the output over whatever it named.
  test('a spill opens neither a link planted at its name nor one put in place of its directory', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if ((await sandbox.probe()).status !== sandbox.SANDBOX_STATUS.OK) return;
    await withDaemon(undefined, async ({ hub, root, reply }) => {
      const block = { tier: 'sandboxed', agentHome: path.join(root, 'agents', 'ws-plant', 'home'), roots: [] };
      const tmp = path.join(root, 'agents', 'ws-plant', 'tmp');
      const noisy = "head -c 600000 /dev/zero | tr '\\0' x; printf END";
      const ownerFile = path.join(root, 'owner-notes.md');
      const ownerDir = path.join(root, 'owner-dir');

      fs.writeFileSync(ownerFile, 'the owner\'s own notes');
      fs.mkdirSync(ownerDir);
      fs.mkdirSync(path.join(tmp, 'kinu-tool-output'), { recursive: true });
      fs.symlinkSync(ownerFile, path.join(tmp, 'kinu-tool-output', 'device-rpc-plantlnk00-1.stdout.log'));

      hub.socket().send(JSON.stringify({ id: 'rpc-plantlnk00-1', method: 'exec', sandbox: block, params: [noisy] }));
      const atName = await reply('rpc-plantlnk00-1');

      fs.rmSync(path.join(tmp, 'kinu-tool-output'), { recursive: true });
      fs.symlinkSync(ownerDir, path.join(tmp, 'kinu-tool-output'));
      hub.socket().send(JSON.stringify({ id: 'rpc-plantdir00-1', method: 'exec', sandbox: block, params: [noisy] }));
      const asDir = await reply('rpc-plantdir00-1');

      expect({
        owner: fs.readFileSync(ownerFile, 'utf8'),
        ownerDir: fs.readdirSync(ownerDir),
        atName: atName.result.stdout.includes('saving /tmp/kinu-tool-output/device-rpc-plantlnk00-1.stdout.log failed'),
        asDir: asDir.result.stdout.includes('saving /tmp/kinu-tool-output/device-rpc-plantdir00-1.stdout.log failed'),
      }).toEqual({ owner: 'the owner\'s own notes', ownerDir: [], atName: true, asDir: true });

      for (const id of ['rpc-plantlnk00-1', 'rpc-plantdir00-1']) {
        hub.socket().send(JSON.stringify({ id: `${id}ack`, method: 'execAck', params: [id, 1] }));
        await reply(`${id}ack`);
      }
    });
  });

  test('a sandboxed exec naming an agent home outside the daemon\'s own root is refused', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    await withDaemon(undefined, async ({ hub, reply }) => {
      // The hub computes this path, but the daemon owns the directory: a frame
      // naming somewhere else would bind-mount a directory the owner never
      // agreed to over the command's home.
      hub.socket().send(JSON.stringify({
        id: 'rpc-sandboxbad-1',
        method: 'exec',
        sandbox: { tier: 'sandboxed', agentHome: '/tmp/not-kinus', roots: [] },
        params: ['echo should-not-run'],
      }));
      const refused = await reply('rpc-sandboxbad-1');
      expect(refused.result).toBeUndefined();
      expect(refused.error?.message).toContain('agent home must be');
    });
  });

  // F8, as Main decided on 2026-09-23: with the Sandbox switch off a command is
  // the owner's own shell, so it keeps their environment; only what Kinu itself
  // holds is withheld. The sandboxed tier keeps its allow-list (sandbox.test.js).
  test('an unsandboxed command gets the owner\'s environment, never Kinu\'s own credentials', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const owner = { GITHUB_TOKEN: 'ghp_owner_pat', SSH_AUTH_SOCK: '/tmp/owner-agent.sock', TZ: 'Asia/Kolkata' };
    const kinu = Object.fromEntries(['KINU_TOKEN', 'KINU_AUTH', 'OPENAI_API_KEY'].map((name) => [name, `${name.toLowerCase()} from the shell`]));

    await withDaemon({ ...owner, ...kinu }, async ({ hub, reply }) => {
      hub.socket().send(JSON.stringify({ id: 'rpc-envdump000-1', method: 'exec', sandbox: RAW, params: ['env'] }));
      const dumped = await reply('rpc-envdump000-1');
      expect(dumped.error).toBeUndefined();
      expect(dumped.result.exitCode).toBe(0);

      const seen = Object.fromEntries(dumped.result.stdout.split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

      expect(Object.keys(seen)).toContain('PATH');
      expect(seen).toMatchObject(owner);
      // Asserted as a SET so the failure names what leaked.
      expect(Object.keys(seen).filter((name) => Object.hasOwn(kinu, name))).toEqual([]);

      hub.socket().send(JSON.stringify({ id: 'rpc-envdmpack-1', method: 'execAck', params: ['rpc-envdump000-1', 1] }));
      await reply('rpc-envdmpack-1');
    });
  });

  // The supervisor holds a terminal result until the cloud acknowledges it,
  // and the daemon is the FIFO's only writer. So a daemon that dies in that
  // window leaves nobody who can ack, and a supervisor that only waited would
  // wait forever; 156 such orphans were found on one machine in a day, each
  // from a test whose daemon exited.
  test('a supervisor whose daemon is gone stops waiting for an ack nobody can send', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = scratchDir('daemon-orphan');
    const requestId = 'rpc-orphanwait-1';
    const requestDir = path.join(root, 'inflight', requestId);
    let supervisor = null;

    try {
      const hub = startFakeHub();

      try {
        makeConfig(root, hub.origin);
        const first = spawnDaemon(root);
        const firstLog = () => fs.readFileSync(first.logPath, 'utf-8');
        expect(await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'))).not.toBeNull();
        hub.socket().send(JSON.stringify({ id: requestId, method: 'exec', sandbox: RAW, params: ['printf orphan-check'] }));
        const done = await untilHub(() => hub.frames.find((f) => f.id === requestId));

        if (!done) throw new Error(`no exec reply: log says ${firstLog()}`);
        expect(done.result.stdout).toContain('orphan-check');

        // Terminal, un-acknowledged: the supervisor is on its ack FIFO now.
        supervisor = recordedIn(path.join(requestDir, 'state'), requestDir, /^pid=(\d+)$/m);

        if (supervisor === null) throw new Error(`no supervisor state under ${requestDir}: log says ${firstLog()}`);
        const supervisorPid = supervisor.pid;
        expect(isRunning(supervisorPid)).toBe(true);
        expect(fs.existsSync(path.join(requestDir, 'result'))).toBe(true);

        // The one writer of that FIFO dies without acknowledging.
        first.child.kill('SIGKILL');
        await first.child.exited;
        expect(await until(() => !isRunning(supervisorPid), 20_000)).toBe(true);

        // The result outlives it, so a replacement daemon still delivers and
        // clears the request — writing the FIFO here would hang the daemon
        // instead of the supervisor, which is the same leak one process along.
        const second = spawnDaemon(root);

        try {
          expect(await untilHub(() => hub.frames.filter((f) => f.type === 'HELLO')[1])).not.toBeNull();
          hub.socket().send(JSON.stringify({ id: 'rpc-orphanack-1', method: 'execAck', params: [requestId, 1] }));
          const acked = await untilHub(() => hub.frames.find((f) => f.id === 'rpc-orphanack-1'), 15_000);

          if (!acked) throw new Error(`no ack reply: log says ${fs.readFileSync(second.logPath, 'utf-8')}`);
          expect(acked.result).toEqual({ requestId, acknowledged: true });
          expect(fs.existsSync(requestDir)).toBe(false);
        } finally {
          second.child.kill('SIGTERM');
          await second.child.exited;
        }
      } finally {
        await hub.close();
      }
    } finally {
      if (supervisor !== null) await killAndAwaitExit(supervisor, { group: true });
    }
  // Two daemon spawns, one exec, and the supervisor's 1 s orphan poll, each
  // with its own named wait inside.
  });

  /** What a terminal session drew, as the fake hub received it. */
  function terminalOutput(hub, session) {
    return hub.frames
      .filter((f) => f.type === 'PTY_OUT' && f.session === session)
      .map((f) => Buffer.from(f.data, 'base64').toString('utf-8'))
      .join('');
  }

  // A signal never reaches the socket's close handler, which is where the
  // terminals were hung up. When the daemon's pty master closes, the kernel
  // hangs up the shell, and the shell passes the hangup on to the jobs it
  // still owns. A job the shell has disowned sits in a process group of its
  // own with nobody left to pass it on, so a signalled restart left it
  // running with nothing left to reach it.
  test('a signalled daemon hangs up every job in its terminals before it exits', async () => {
    // `sessionGroups` sweeps the whole session on Linux only; a Mac signals the
    // shell's own group and says so.
    if (process.platform !== 'linux') return;
    const root = scratchDir('daemon-signal');
    let job = 0;

    try {
      const hub = startFakeHub();

      try {
        makeConfig(root, hub.origin);
        const { child, logPath } = spawnDaemon(root);

        try {
          const daemonLog = () => fs.readFileSync(logPath, 'utf-8');
          expect(await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'))).not.toBeNull();
          hub.socket().send(JSON.stringify({ id: 'rpc-ptysignal0-1', method: 'ptyOpen', workspace: 'ws-signal', sandbox: RAW, params: [80, 24] }));
          const opened = await untilHub(() => hub.frames.find((f) => f.id === 'rpc-ptysignal0-1'));

          if (!opened) throw new Error(`no ptyOpen reply: log says ${daemonLog()}`);
          expect(opened.result.pid).toBeGreaterThan(0);
          // The workspace's first session, named by the daemon.
          const session = opened.result.session;

          const output = () => terminalOutput(hub, session);

          hub.socket().send(JSON.stringify({
            type: 'PTY_IN',
            session,
            data: Buffer.from('sleep 600 & job=$!; disown $job; echo started $job\r').toString('base64'),
          }));
          const started = await untilHub(() => /started (\d+)/.exec(output()));

          if (!started) throw new Error(`the shell never started the job: log says ${daemonLog()}`);
          job = Number(started[1]);
          expect(isRunning(job)).toBe(true);

          child.kill('SIGTERM');
          await child.exited;
          expect(await until(() => !isRunning(job), 10_000)).toBe(true);
          expect(daemonLog()).toContain(`device.terminals_closed_with_daemon ${session}`);
        } finally {
          child.kill('SIGTERM');
          await child.exited;
        }
      } finally {
        await hub.close();
      }
    } finally {
      if (job > 0) tolerate(() => process.kill(job, 'SIGKILL'), 'esrch');
    }
  // One daemon spawn, one terminal, and the shell's own prompt inside it,
  // each with its own named wait.
  });

  // 1014-t: a terminal outlives its socket, detached, so a socket the hub
  // closed for good (the owner revoked the machine) is the one close that must
  // still end every shell: nothing may reach them again, and a live shell keeps
  // the rejected daemon running.
  test('a machine whose credential is rejected hangs up every job in its terminals', async () => {
    if (process.platform !== 'linux') return;
    const root = scratchDir('daemon-rejected-terminal');
    let job = 0;

    try {
      const hub = startFakeHub();

      try {
        makeConfig(root, hub.origin);
        const { child, logPath } = spawnDaemon(root);

        try {
          const daemonLog = () => fs.readFileSync(logPath, 'utf-8');
          expect(await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'))).not.toBeNull();
          hub.socket().send(JSON.stringify({ id: 'rpc-ptyreject0-1', method: 'ptyOpen', workspace: 'ws-rejected', sandbox: RAW, params: [80, 24] }));
          const opened = await untilHub(() => hub.frames.find((f) => f.id === 'rpc-ptyreject0-1'));

          if (!opened) throw new Error(`no ptyOpen reply: log says ${daemonLog()}`);
          const session = opened.result.session;

          const output = () => terminalOutput(hub, session);

          hub.socket().send(JSON.stringify({
            type: 'PTY_IN',
            session,
            data: Buffer.from('sleep 600 & job=$!; disown $job; echo started $job\r').toString('base64'),
          }));
          const started = await untilHub(() => /started (\d+)/.exec(output()));

          if (!started) throw new Error(`the shell never started the job: log says ${daemonLog()}`);
          job = Number(started[1]);
          hub.socket().close(4401, 'device credentials were rejected');

          expect(await until(() => !isRunning(job), 10_000)).toBe(true);
          expect(daemonLog()).toContain(`device.terminals_closed_with_credential ${session}`);
        } finally {
          child.kill('SIGTERM');
          await child.exited;
        }
      } finally {
        await hub.close();
      }
    } finally {
      if (job > 0) tolerate(() => process.kill(job, 'SIGKILL'), 'esrch');
    }
  // One daemon spawn, one terminal, and the shell's own prompt inside it,
  // each with its own named wait.
  });
});
