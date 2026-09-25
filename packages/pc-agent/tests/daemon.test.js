/**
 * PC-agent daemon — protocol round-trips through handle() with REAL git
 * (no mocks on the checkpoint path): the pre-mutation snapshot hint on
 * exec/writeFile frames, the checkpoint RPC methods, and the honest
 * degraded mode when git is missing.
 */
'use strict';

const { scratchDir } = require('../../test-utils/src/scratch');

const { afterAll, afterEach, describe, expect, spyOn, test } = require('bun:test');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { tolerate } = require('@kinu.run/core/obs');

/**
 * The daemon reads its config and in-flight root once at module load. Set both
 * before require so this suite cannot inspect or modify the developer's home.
 */
const INFLIGHT_ROOT = scratchDir('daemon-inflight');

const DEVICE_HOME = scratchDir('daemon-home');

const previousKinuHome = process.env.KINU_HOME;

process.env.KINU_INFLIGHT_ROOT = INFLIGHT_ROOT;

process.env.KINU_HOME = DEVICE_HOME;

afterAll(() => {

  if (previousKinuHome === undefined) delete process.env.KINU_HOME;
  else process.env.KINU_HOME = previousKinuHome;
});

const {
  CONFIG_PATH,
  handle,
  createCheckpoints,
  getConnectTicket,
  handleTokenRotation,
  inFlight,
  persistRotatedToken,
  readDeviceConfig,
  startConnectLoop,
  supervisionSupported,
} = require('../src/index.js');

/** The hub ACKs every result it records, and the ACK is what ends a command's supervisor (about 30 MB).
 *  A test that read an answer and stopped there left 22 supervisors running until the run ended. */
afterEach(async () => {
  for (const requestId of fs.readdirSync(INFLIGHT_ROOT)) {
    if (fs.existsSync(path.join(INFLIGHT_ROOT, requestId, 'result'))) await inFlight.acknowledge(requestId);
  }
});

/** The block a hub with the owner's Sandbox switch OFF sends. Every frame that
 *  reaches the machine carries a tier, so an unscoped frame is a refusal. */
const RAW = { tier: 'raw', agentHome: '', roots: [] };

function fakeWs() {
  const frames = [];

  return {
    frames,
    send(data) { frames.push(JSON.parse(data)); },
    /** Await the correlated response for an id (exec resolves async). */
    async response(id, timeoutMs = 5000) {
      const t0 = Date.now();

      for (;;) {
        const frame = this.frames.find((f) => f.id === id);

        if (frame) return frame;

        if (Date.now() - t0 > timeoutMs) throw new Error(`no response for ${id}`);
        await new Promise((r) => setTimeout(r, 10));
      }
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

// A sub-millisecond red of the two fixture-first tests below identifies the
// box's tmpdir. Each test's first syscall is mkdtempSync, and a refusal there
// fails the test before any product code runs: two 0.1-0.3 ms rows appeared
// once under a 711-file parallel run at dec792391 while the identical
// syscalls one test later passed. persist is synchronous and atomic, its temp
// file never survives a call, and files cannot pollute each other. Bun runs
// each file in a fresh context with fresh builtins (bun 1.4.0). Check
// `df /tmp` first when these rows go red that fast.
describe('daemon token rotation', () => {
  test('the next ticket exchange uses the atomically persisted token', async () => {
    const root = scratchDir('daemon-token');
    const configPath = path.join(root, 'device.json');
    const cfg = { user: 'user-1', token: 'T0' };
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    const seen = [];

    const fetchTicket = async (_url, init) => {
      seen.push(JSON.parse(init.body));

      return new Response(JSON.stringify({ ticket: `pct_${'a'.repeat(32)}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await getConnectTicket(cfg, 'https://kinu.run', fetchTicket);
    persistRotatedToken(cfg, 'T1', configPath);
    await getConnectTicket(cfg, 'https://kinu.run', fetchTicket);

    expect(seen.map((body) => body.token)).toEqual(['T0', 'T1']);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).token).toBe('T1');
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(['device.json']);
  });

  test('a failed persist leaves memory and the old file unchanged', () => {
    const root = scratchDir('daemon-token');
    const configPath = path.join(root, 'missing', 'device.json');
    const cfg = { user: 'user-1', token: 'T0' };

    expect(() => persistRotatedToken(cfg, 'T1', configPath))
      .toThrow('persist rotated device token');
    expect(cfg.token).toBe('T0');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('a failed atomic rename preserves config and reports rotation failure', () => {
    const root = scratchDir('daemon-token');
    const configPath = path.join(root, 'device.json');
    const cfg = { user: 'user-1', token: `pdt_${'0'.repeat(32)}` };
    const messages = [];
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });

    const rename = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    try {
      expect(handleTokenRotation(
        cfg,
        { type: 'ROTATE', token: `pdt_${'1'.repeat(32)}` },
        configPath,
        (...args) => messages.push(args),
      )).toBe(true);
      expect(cfg.token).toBe(`pdt_${'0'.repeat(32)}`);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).token).toBe(`pdt_${'0'.repeat(32)}`);
      expect(fs.readdirSync(root)).toEqual(['device.json']);
      expect(messages[0]?.[0]).toBe('Device token rotation failed:');
    } finally {
      rename.mockRestore();
    }
  });

  test('a rotation carrying anything but a device token is neither stored nor taken', () => {
    const root = scratchDir('daemon-token');
    const configPath = path.join(root, 'device.json');
    const held = `pdt_${'0'.repeat(32)}`;
    const messages = [];

    for (const token of [{ weird: 'object' }, 42, 'pdt_short', `ptc_${'1'.repeat(32)}`]) {
      const cfg = { user: 'user-1', token: held };
      fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });

      expect(handleTokenRotation(cfg, { type: 'ROTATE', token }, configPath, (...args) => messages.push(args))).toBe(true);
      // The daemon acknowledges only when its held token equals the frame's,
      // so an untaken token is also an unacknowledged one.
      expect(cfg.token).toBe(held);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).token).toBe(held);
    }

    expect(messages.map((message) => message[0])).toEqual(Array(4).fill('Device token rotation refused:'));
  });
});

describe('daemon startup hardening', () => {
  test('uses the configured home and never reflects a corrupt config token', () => {
    const configPath = path.join(DEVICE_HOME, 'corrupt-device.json');
    const secret = 'pdt_secret_that_must_not_appear';
    fs.writeFileSync(configPath, `{"user":"user-1","token":"${secret}",`);

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

  test('a device config naming a plaintext origin off this machine is refused before any token is sent', () => {
    const configPath = path.join(DEVICE_HOME, 'origin-device.json');
    const config = (origin) => JSON.stringify({ user: 'user-1', token: `pdt_${'a'.repeat(32)}`, origin });

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

  test('redacts rejected device credentials from ticket exchange failures', async () => {
    const secret = 'pdt_secret_that_must_not_appear';
    let failure;

    try {
      await getConnectTicket(
        { user: 'user-1', token: secret },
        'https://kinu.run',
        async () => Response.json({ error: `rejected ${secret}` }, { status: 401 }),
      );
    } catch (err) {
      failure = err;
    }

    if (!(failure instanceof Error) || !(failure.cause instanceof Error)) {
      throw new Error('expected ticket exchange to reject with a caused Error');
    }

    expect(failure.message).toContain('device credentials were rejected');
    expect(failure.message).not.toContain(secret);
    expect(failure.cause.message).not.toContain(secret);
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
      secret: () => 'pdt_device_secret',
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
  test('a refused device token stops the loop loudly instead of dialling forever', async () => {
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
        ['untiered-read', 'readFile', [planted]],
        ['untiered-range', 'readRange', [planted, 0, 6]],
        ['untiered-write', 'writeFile', [planted, 'planted']],
        ['untiered-list', 'listFiles', [path.dirname(planted)]],
        ['untiered-stat', 'statPath', [planted]],
        ['untiered-exists', 'exists', [planted]],
        ['untiered-unlink', 'unlinkPath', [planted]],
        ['untiered-mkdir', 'mkdirPath', [`${planted}-dir`]],
        ['rpc-untiered00-1', 'exec', [`cat ${JSON.stringify(planted)}`]],
      ];

      for (const [id, method, params] of frames) handle({ id, method, params }, ws, {});

      for (const [id] of frames) {
        const frame = await ws.response(id);
        expect(frame.result).toBeUndefined();
        expect(frame.error).toContain('names no sandbox tier');
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
        ['traversal', 'readFile', [climb]],
        ['symlink', 'readFile', [path.join(project, 'link')]],
        ['traversal-range', 'readRange', [climb, 0, 6]],
        ['traversal-write', 'writeFile', [climb, 'planted']],
        ['symlink-write', 'writeFile', [path.join(project, 'link'), 'planted']],
      ]) {
        handle({ id, method, sandbox: scoped([project]), params }, ws, {});
        const frame = await ws.response(id);
        expect(frame.result).toBeUndefined();
        expect(frame.error).toContain('does not expose');
      }

      expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
    } finally {
      fs.rmSync(outside, { force: true });
    }

    // The system trees a program needs stay readable and refuse a write,
    // which is what the kernel does to the shell for the same paths.
    handle({ id: 'read-system', method: 'readFile', sandbox: scoped([project]), params: ['/etc/hostname'] }, ws, {});
    expect((await ws.response('read-system')).error).toBeUndefined();
    handle({
      id: 'write-system',
      method: 'writeFile',
      sandbox: scoped([project]),
      params: ['/usr/local/kinu-planted.txt', 'x'],
    }, ws, {});
    expect((await ws.response('write-system')).error).toContain('read-only in this device');
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
    handle({ id: 'kinu-link', method: 'readFile', sandbox: scoped([project]), params: [bait] }, ws, {});
    expect((await ws.response('kinu-link')).error).toContain("inside Kinu's own directory");
    expect((await ws.response('kinu-link')).result).toBeUndefined();
    expect(fs.readFileSync(baited, 'utf8')).toContain('machine-secret');
    fs.rmSync(baited, { force: true });
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
        method: 'readFile',
        sandbox: { tier: 'sandboxed', agentHome, roots: [] },
        params: [path.join(sibling, 'notes.txt')],
      }, ws, {});
      const frame = await ws.response(id);
      expect(frame.result).toBeUndefined();
      expect(frame.error).toContain('agent home must be');
    }
  });

  test('a consented root of / is the whole machine, as with the Sandbox switch off', async () => {
    const outside = plantOutside('whole-machine');
    fs.writeFileSync(path.join(DEVICE_HOME, 'whole-machine-device.json'), '{"token":"machine-secret"}', { mode: 0o600 });
    const whole = { tier: 'sandboxed', agentHome: path.join(DEVICE_HOME, 'agents', 'ws-1', 'home'), roots: ['/'] };
    const ws = fakeWs();

    try {
      handle({ id: 'rpc-wholemach0-1', method: 'exec', sandbox: whole, params: [`cat ${JSON.stringify(outside)}`] }, ws, {});
      handle({ id: 'whole-read', method: 'readFile', sandbox: whole, params: [outside] }, ws, {});
      handle({
        id: 'whole-kinu', method: 'readFile', sandbox: whole, params: [path.join(DEVICE_HOME, 'whole-machine-device.json')],
      }, ws, {});

      expect((await ws.response('rpc-wholemach0-1')).result.stdout).toBe('secret');
      expect((await ws.response('whole-read')).result).toBe('secret');
      // Kinu's own directory is the one thing no tier serves.
      expect((await ws.response('whole-kinu')).error).toContain("inside Kinu's own directory");
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
    handle({ id: 'mkdir', method: 'mkdirPath', sandbox: scoped([project]), params: [dir, { recursive: true }] }, ws, {});
    expect((await ws.response('mkdir')).result).toEqual({ success: true });
    handle({ id: 'write', method: 'writeFile', sandbox: scoped([project]), params: [file, 'ok', {}] }, ws, {});
    expect((await ws.response('write')).result).toEqual({ success: true });
    handle({ id: 'stat', method: 'statPath', sandbox: scoped([project]), params: [file] }, ws, {});
    expect((await ws.response('stat')).result).toMatchObject({ size: 2, isDir: false });
    handle({ id: 'unlink', method: 'unlinkPath', sandbox: scoped([project]), params: [file] }, ws, {});
    expect((await ws.response('unlink')).result).toEqual({ success: true });
    const target = path.join(project, 'target.txt');
    const link = path.join(project, 'target-link');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, link);
    handle({ id: 'unlink-link', method: 'unlinkPath', sandbox: scoped([project]), params: [link] }, ws, {});
    expect((await ws.response('unlink-link')).result).toEqual({ success: true });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
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

  test('frames without a checkpoint hint behave exactly as before (no snapshot)', async () => {
    const { work, ctx } = setup();

    const ws = fakeWs();
    handle({ id: 'rpc-nosnapexe0-1', method: 'exec', sandbox: RAW, params: [`echo hi > ${work}/x.txt`] }, ws, ctx);
    expect((await ws.response('rpc-nosnapexe0-1')).result.exitCode).toBe(0);
    handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
    expect((await ws.response('l')).result).toEqual([]);
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
    expect((await ws.response('r')).error).toBe('checkpoints unavailable: git not found');
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
    fs.writeFileSync(path.join(DEVICE_HOME, 'device.json'), '{"token":"pdt_never_in_a_store"}', { mode: 0o600 });
    const ws = fakeWs();

    // A daemon that updated itself runs from its own directory, and a hint
    // with no directory once fell back to that working directory.
    handle({
      id: 'rpc-kinuckpt00-1', method: 'exec', sandbox: RAW, params: ['true'],
      checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: DEVICE_HOME },
    }, ws, ctx);
    expect((await ws.response('rpc-kinuckpt00-1')).result.exitCode).toBe(0);
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
      expect((await ws.response('w-outside')).result).toEqual({ success: true });
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
      expect((await ws.response('r')).error).toContain('does not expose');
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
    withPath(dir, () => handle({ id: 1, method: 'which', params: [['node', 'bun', 'git', 'python3']] }, ws, {}));

    // `bun` and `python3` are not there. Reported as absent, which is a
    // measurement — distinct from the hub never getting an answer at all.
    expect((await ws.response(1)).result).toEqual({ present: ['node', 'git'] });
  });

  test('a non-executable file of the right name is not a binary on PATH', async () => {
    const dir = scratchDir('which');
    fs.writeFileSync(path.join(dir, 'python3'), 'not a program', { mode: 0o644 });

    const ws = fakeWs();
    withPath(dir, () => handle({ id: 1, method: 'which', params: [['python3']] }, ws, {}));

    // The capability reads "Runs Python". A file nobody can execute does not.
    expect((await ws.response(1)).result).toEqual({ present: [] });
  });

  test('refuses to answer for anything but a bare binary name', async () => {
    const dir = pathWith(['node']);

    const ws = fakeWs();
    // The probe must not become a way to ask whether paths on the user's
    // machine exist. Names carrying a separator are dropped, not resolved —
    // even one that would obviously succeed.
    withPath(dir, () => handle({
      id: 1,
      method: 'which',
      params: [['../etc/passwd', '/bin/sh', 'node/../node', 'node']],
    }, ws, {}));

    expect((await ws.response(1)).result).toEqual({ present: ['node'] });
  });

  test('a malformed question is an error frame, never a confident empty answer', async () => {
    const ws = fakeWs();
    handle({ id: 1, method: 'which', params: ['node'] }, ws, {});

    // `{present: []}` here would tell the hub this machine has no toolchain.
    expect((await ws.response(1)).error).toMatch(/array of binary names/);
  });
});

// ── The daemon as a process, under its one runtime ─────────────────────
//
// The suites above exercise handle() in this process. This one runs the REAL
// daemon as a child — spawned with process.execPath (Bun) the same way
// device-connect's daemonRuntime does — against a local fake hub speaking the
// /pc/connect-ticket + /pc/connect upgrade protocol. It proves the daemon's
// CommonJS source, node: builtins, child_process supervision, fs.watch
// in-flight waits and the global WebSocket all work under Bun, by running
// them: HELLO on connect, ROTATE persistence, an exec round-trip, execCancel,
// a file op, and reconnect after the socket drops.

describe('daemon process under Bun against a local hub', () => {
  const DAEMON_PATH = path.join(__dirname, '..', 'src', 'index.js');

  function makeConfig(root, origin) {
    const config = { user: 'user-1', token: `pdt_${'a'.repeat(32)}`, origin };
    const configPath = path.join(root, 'device.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    return { config, configPath };
  }

  /**
   * A local hub: ticket exchange over HTTP, the connect upgrade over
   * WebSocket, and one captured frame stream with a JSON-frame reply helper.
   * The daemon treats it exactly as it treats production — no test hooks
   * inside the daemon.
   */
  function startFakeHub() {
    const frames = [];
    const sockets = [];

    const hub = Bun.serve({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === '/pc/connect-ticket') {
          return Response.json({ ticket: `pct_${'b'.repeat(32)}`, expiresAt: Date.now() + 60_000 });
        }

        if (url.pathname === '/pc/connect') {
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
      env: { ...process.env, KINU_HOME: root, KINU_INFLIGHT_ROOT: path.join(root, 'inflight'), ...extraEnv },
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
   *  process group, and ESRCH is that group already being gone, which is the
   *  teardown's goal. Killing by the daemon child's group is not possible —
   *  `Bun.spawn` above is not detached. */
  function killInflightSupervisors(root) {
    const inflight = path.join(root, 'inflight');

    if (!fs.existsSync(inflight)) return;

    for (const entry of fs.readdirSync(inflight)) {
      const state = path.join(inflight, entry, 'state');

      if (!fs.existsSync(state)) continue;
      const pid = Number(/^pid=(\d+)$/m.exec(fs.readFileSync(state, 'utf-8'))?.[1]);

      if (Number.isInteger(pid) && pid > 0) tolerate(() => process.kill(-pid, 'SIGKILL'), 'esrch');
    }
  }

  test('HELLO on connect, rotation, exec, cancel, file op, and reconnect — all under Bun', async () => {
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
        expect(hello).toBeDefined();
        expect(hello.user).toBe('user-1');
        expect(hello.pid).toBeGreaterThan(0);
        const daemonLog = () => fs.readFileSync(logPath, 'utf-8');
        expect(daemonLog()).toContain('Connected');

        // ROTATE: the hub rotates the long-lived token; the daemon persists
        // it and ACKNOWLEDGES. The hub holds the superseded token valid until
        // that frame, so this is what ends its grace.
        const rotated = `pdt_${'c'.repeat(32)}`;
        hub.socket().send(JSON.stringify({ type: 'ROTATE', token: rotated }));
        await untilHub(() => JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).token === rotated);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).token).toBe(rotated);
        expect(daemonLog()).toContain('Device token rotated');
        // `untilHub` answers null on timeout, and `toBeDefined` accepts null — so
        // the absent direction has to be spelled as "not null" to be able to fail.
        expect(await untilHub(() => hub.frames.find((f) => f.type === 'ROTATE_ACK'))).not.toBeNull();

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
        hub.socket().send(JSON.stringify({ id: 'rpc-e2ecanclX-1', method: 'execCancel', params: ['rpc-e2ecancelf-1', 1] }));
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
        expect(hello2).toBeDefined();
      } finally {
        // Teardown owns three things the runner's exit depends on: the daemon
        // child (SIGTERM, then reaped through .exited), the in-flight root,
        // and the hub.
        child.kill('SIGTERM');
        await child.exited;
        killInflightSupervisors(root);
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
  async function withDaemon(extraEnv, body) {
    const root = scratchDir('daemon-case');

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
        killInflightSupervisors(root);
      }
    } finally {
      await hub.close();
    }
  }

  /** Whether `pid` names a process this user can still signal. */
  function processAlive(pid) {
    try {
      process.kill(pid, 0);

      return true;
    } catch (err) {
      if (err && err.code === 'ESRCH') return false;
      throw err;
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

  // F2. ~/.kinu holds device.json (this machine's long-lived token) and
  // config.json (the owner's interactive CLI bearer). Reading either one turns
  // a file grant into the tier that granted it, so the fence does not depend
  // on which root the call carries: these frames are the raw tier, with the
  // owner's Sandbox switch off — the strongest thing a workspace can hold.
  test('Kinu\'s own directory is never served through the tunnel, at any tier', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    await withDaemon(undefined, async ({ hub, root, reply }) => {
      fs.writeFileSync(path.join(root, 'config.json'), '{"accessToken":"ptc_owner_bearer"}', { mode: 0o600 });

      const refused = [
        ['rpc-fence00rd-1', 'readFile', [path.join(root, 'config.json')]],
        ['rpc-fence00dv-1', 'readFile', [path.join(root, 'device.json')]],
        ['rpc-fence00ls-1', 'listFiles', [root]],
        ['rpc-fence00st-1', 'statPath', [path.join(root, 'device.json')]],
        ['rpc-fence00wr-1', 'writeFile', [path.join(root, 'device.json'), '{"token":"attacker"}']],
        ['rpc-fence00un-1', 'unlinkPath', [path.join(root, 'device.json')]],
        ['rpc-fence00mk-1', 'mkdirPath', [path.join(root, 'planted')]],
      ];

      for (const [id, method, params] of refused) {
        hub.socket().send(JSON.stringify({ id, method, sandbox: RAW, params }));
        const frame = await reply(id);
        // Result first: an un-fenced daemon answers with the credential
        // itself, and that is the sentence the failure should print.
        expect(frame.result).toBeUndefined();
        expect(frame.error).toContain("inside Kinu's own directory");
      }

      // The credentials are intact and the plant did not land.
      expect(fs.readFileSync(path.join(root, 'config.json'), 'utf-8')).toContain('ptc_owner_bearer');
      expect(fs.existsSync(path.join(root, 'device.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'planted'))).toBe(false);

      // A symlink is refused by where it LANDS, not by how it is spelled.
      const bait = path.join(os.tmpdir(), `kinu-fence-bait-${process.pid}`);
      fs.symlinkSync(path.join(root, 'device.json'), bait);

      try {
        hub.socket().send(JSON.stringify({ id: 'rpc-fence00sy-1', method: 'readFile', sandbox: RAW, params: [bait] }));
        expect((await reply('rpc-fence00sy-1')).error).toContain("inside Kinu's own directory");
      } finally {
        fs.rmSync(bait, { force: true });
      }
    });
  });

  // F3. Acknowledgement is what ends the hub's grace on the superseded token,
  // so a rotation this daemon could NOT store must not be acknowledged: the
  // secret still on its disk is the only one it has, and the hub has to keep
  // honouring it or the machine is locked out.
  test('a rotation it could not store is not acknowledged', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    await withDaemon(undefined, async ({ hub, root, daemonLog }) => {
      // The store is the directory, so making it unwritable is what makes the
      // atomic rename fail — the same way a full or read-only disk would.
      fs.chmodSync(root, 0o500);

      try {
        hub.socket().send(JSON.stringify({ type: 'ROTATE', token: `pdt_${'d'.repeat(32)}` }));
        await untilHub(() => daemonLog().includes('Device token rotation failed:'));
        expect(daemonLog()).toContain('Device token rotation failed:');
        // The old secret is still the one on disk, and nothing told the hub
        // otherwise.
        expect(JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).token)
          .toBe(`pdt_${'a'.repeat(32)}`);
        expect(hub.frames.filter((frame) => frame.type === 'ROTATE_ACK')).toEqual([]);
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

    if (sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
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

  test('a sandboxed command spills into its own tmp, named as its shell and the file methods name it', async () => {
    if (process.platform !== 'linux') return;
    const sandbox = require('../src/sandbox.js');

    if (sandbox.probe().status !== sandbox.SANDBOX_STATUS.OK) return;
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
      expect(refused.error).toContain('agent home must be');
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
    let supervisorPid = 0;

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
        supervisorPid = Number(/^pid=(\d+)$/m.exec(fs.readFileSync(path.join(requestDir, 'state'), 'utf-8'))[1]);
        expect(processAlive(supervisorPid)).toBe(true);
        expect(fs.existsSync(path.join(requestDir, 'result'))).toBe(true);

        // The one writer of that FIFO dies without acknowledging.
        first.child.kill('SIGKILL');
        await first.child.exited;
        expect(await until(() => !processAlive(supervisorPid), 20_000)).toBe(true);

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
      if (supervisorPid > 0) tolerate(() => process.kill(-supervisorPid, 'SIGKILL'), 'esrch');
    }
  // Two daemon spawns, one exec, and the supervisor's 1 s orphan poll, each
  // with its own named wait inside.
  });

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
          hub.socket().send(JSON.stringify({ id: 'rpc-ptysignal0-1', method: 'ptyOpen', sandbox: RAW, params: ['sig', 80, 24] }));
          const opened = await untilHub(() => hub.frames.find((f) => f.id === 'rpc-ptysignal0-1'));

          if (!opened) throw new Error(`no ptyOpen reply: log says ${daemonLog()}`);
          expect(opened.result.pid).toBeGreaterThan(0);

          const output = () => hub.frames
            .filter((f) => f.type === 'PTY_OUT' && f.session === 'sig')
            .map((f) => Buffer.from(f.data, 'base64').toString('utf-8'))
            .join('');

          hub.socket().send(JSON.stringify({
            type: 'PTY_IN',
            session: 'sig',
            data: Buffer.from('sleep 600 & job=$!; disown $job; echo started $job\r').toString('base64'),
          }));
          const started = await untilHub(() => /started (\d+)/.exec(output()));

          if (!started) throw new Error(`the shell never started the job: log says ${daemonLog()}`);
          job = Number(started[1]);
          expect(processAlive(job)).toBe(true);

          child.kill('SIGTERM');
          await child.exited;
          expect(await until(() => !processAlive(job), 10_000)).toBe(true);
          expect(daemonLog()).toContain('device.terminals_closed_with_daemon sig');
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
