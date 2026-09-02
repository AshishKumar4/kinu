/**
 * PC-agent daemon — protocol round-trips through handle() with REAL git
 * (no mocks on the checkpoint path): the pre-mutation snapshot hint on
 * exec/writeFile frames, the checkpoint RPC methods, and the honest
 * degraded mode when git is missing.
 */
'use strict';
const { afterAll, describe, expect, spyOn, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tolerate } = require('@kinu.run/core/obs');

/**
 * The daemon reads its config and in-flight root once at module load. Set both
 * before require so this suite cannot inspect or modify the developer's home.
 */
const INFLIGHT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-inflight-'));
const DEVICE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-home-'));
const previousKinuHome = process.env.KINU_HOME;
process.env.KINU_INFLIGHT_ROOT = INFLIGHT_ROOT;
process.env.KINU_HOME = DEVICE_HOME;
afterAll(() => {
  fs.rmSync(INFLIGHT_ROOT, { recursive: true, force: true });
  fs.rmSync(DEVICE_HOME, { recursive: true, force: true });
  if (previousKinuHome === undefined) delete process.env.KINU_HOME;
  else process.env.KINU_HOME = previousKinuHome;
});

const {
  CONFIG_PATH,
  handle,
  createCheckpoints,
  getConnectTicket,
  handleTokenRotation,
  persistRotatedToken,
  readDeviceConfig,
  startConnectLoop,
  supervisionSupported,
} = require('../src/index.js');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-'));
  const work = path.join(root, 'project');
  fs.mkdirSync(work, { recursive: true });
  const ctx = { checkpoints: createCheckpoints({ base: path.join(root, 'shadow'), keep: opts.keep, gitBin: opts.gitBin }) };
  return { root, work, ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('daemon token rotation', () => {
  test('the next ticket exchange uses the atomically persisted token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-token-'));
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
    try {
      await getConnectTicket(cfg, 'https://kinu.run', fetchTicket);
      persistRotatedToken(cfg, 'T1', configPath);
      await getConnectTicket(cfg, 'https://kinu.run', fetchTicket);

      expect(seen.map((body) => body.token)).toEqual(['T0', 'T1']);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).token).toBe('T1');
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(root)).toEqual(['device.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed persist leaves memory and the old file unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-token-'));
    const configPath = path.join(root, 'missing', 'device.json');
    const cfg = { user: 'user-1', token: 'T0' };
    try {
      expect(() => persistRotatedToken(cfg, 'T1', configPath))
        .toThrow('persist rotated device token');
      expect(cfg.token).toBe('T0');
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed atomic rename preserves config and reports rotation failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-token-'));
    const configPath = path.join(root, 'device.json');
    const cfg = { user: 'user-1', token: 'T0' };
    const messages = [];
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    const rename = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });
    try {
      expect(handleTokenRotation(
        cfg,
        { type: 'ROTATE', token: 'T1' },
        configPath,
        (...args) => messages.push(args),
      )).toBe(true);
      expect(cfg.token).toBe('T0');
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).token).toBe('T0');
      expect(fs.readdirSync(root)).toEqual(['device.json']);
      expect(messages[0]?.[0]).toBe('Device token rotation failed:');
    } finally {
      rename.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
        const listeners = new Map();
        const socket = {
          addEventListener(type, listener) {
            const callbacks = listeners.get(type) ?? [];
            callbacks.push(listener);
            listeners.set(type, callbacks);
          },
          emit(type, event = {}) {
            for (const listener of listeners.get(type) ?? []) listener(event);
          },
        };
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

  test('does not claim command supervision on unsupported platforms', () => {
    expect(supervisionSupported('linux')).toBe(true);
    expect(supervisionSupported('darwin')).toBe(true);
    expect(supervisionSupported('win32')).toBe(false);
    expect(supervisionSupported('sunos')).toBe(false);
  });
});

describe('daemon exec output bound', () => {
  test('a noisy command drains after the retained response is truncated', async () => {
    const ws = fakeWs();
    handle({
      id: 'rpc-noisyexec0-1',
      method: 'exec',
      params: [`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(600000))"`],
    }, ws, {});

    const result = (await ws.response('rpc-noisyexec0-1')).result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[output truncated at 524288 bytes]');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(525_000);
  });
});

describe('daemon device path confinement', () => {
  test('dot-dot and symlink paths cannot escape the consented root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-root-'));
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside.txt');
    fs.mkdirSync(project);
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(project, 'link'));
    const ws = fakeWs();
    try {
      handle({
        id: 'traversal',
        method: 'readFile',
        params: [path.join(project, '..', 'outside.txt'), { root: project }],
      }, ws, {});
      handle({
        id: 'symlink',
        method: 'readFile',
        params: [path.join(project, 'link'), { root: project }],
      }, ws, {});

      expect((await ws.response('traversal')).error).toContain('resolves outside');
      expect((await ws.response('symlink')).error).toContain('resolves outside');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('scoped native mutations stay inside the resolved root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-root-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const ws = fakeWs();
    try {
      const dir = path.join(project, 'nested');
      const file = path.join(dir, 'data.txt');
      handle({ id: 'mkdir', method: 'mkdirPath', params: [dir, { root: project, recursive: true }] }, ws, {});
      expect((await ws.response('mkdir')).result).toEqual({ success: true });
      handle({ id: 'write', method: 'writeFile', params: [file, 'ok', { root: project }] }, ws, {});
      expect((await ws.response('write')).result).toEqual({ success: true });
      handle({ id: 'stat', method: 'statPath', params: [file, { root: project }] }, ws, {});
      expect((await ws.response('stat')).result).toMatchObject({ size: 2, isDir: false });
      handle({ id: 'unlink', method: 'unlinkPath', params: [file, { root: project }] }, ws, {});
      expect((await ws.response('unlink')).result).toEqual({ success: true });
      const target = path.join(project, 'target.txt');
      const link = path.join(project, 'target-link');
      fs.writeFileSync(target, 'keep');
      fs.symlinkSync(target, link);
      handle({ id: 'unlink-link', method: 'unlinkPath', params: [link, { root: project }] }, ws, {});
      expect((await ws.response('unlink-link')).result).toEqual({ success: true });
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('daemon checkpoint protocol', () => {
  test('an exec frame with a checkpoint hint snapshots before running; restore round-trips', async () => {
    const { work, ctx, cleanup } = setup();
    try {
      fs.writeFileSync(path.join(work, 'data.txt'), 'original');
      const ws = fakeWs();

      handle({
        id: 'rpc-checkprex0-1', method: 'exec', params: [`echo CLOBBERED > ${work}/data.txt && rm -f ${work}/data.txt && echo gone > ${work}/extra.txt`],
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

      handle({ id: 'r3', method: 'checkpointPlan', params: ['cloud-agent', work, list[0].id] }, ws, ctx);
      const plan = (await ws.response('r3')).result;
      const kinds = Object.fromEntries(plan.files.map((f) => [f.path, f.kind]));
      expect(kinds['data.txt']).toBe('create');
      expect(kinds['extra.txt']).toBe('delete');

      handle({ id: 'r4', method: 'checkpointRestore', params: ['cloud-agent', work, list[0].id] }, ws, ctx);
      const restore = (await ws.response('r4')).result;
      expect(restore.preRestoreId).toBeTruthy();
      expect(fs.readFileSync(path.join(work, 'data.txt'), 'utf8')).toBe('original');
      expect(fs.existsSync(path.join(work, 'extra.txt'))).toBe(false);
    } finally { cleanup(); }
  });

  test('snapshots dedupe on the turn id; a new turn snapshots again', async () => {
    const { work, ctx, cleanup } = setup();
    try {
      const ws = fakeWs();
      const hint = (turnId) => ({ agent: 'a', turnId, sessionId: 's', dir: work });

      fs.writeFileSync(path.join(work, 'f.txt'), 'v1');
      handle({ id: 'e1', method: 'exec', params: ['true'], checkpoint: hint('t1') }, ws, ctx);
      await ws.response('e1');
      fs.writeFileSync(path.join(work, 'f.txt'), 'v2');
      handle({ id: 'e2', method: 'exec', params: ['true'], checkpoint: hint('t1') }, ws, ctx);
      await ws.response('e2');
      handle({ id: 'l1', method: 'checkpointList', params: ['a'] }, ws, ctx);
      expect((await ws.response('l1')).result).toHaveLength(1); // deduped within turn

      handle({ id: 'e3', method: 'exec', params: ['true'], checkpoint: hint('t2') }, ws, ctx);
      await ws.response('e3');
      handle({ id: 'l2', method: 'checkpointList', params: ['a'] }, ws, ctx);
      expect((await ws.response('l2')).result).toHaveLength(2);
    } finally { cleanup(); }
  });

  test('writeFile derives the project dir from the path when the hint has no dir', async () => {
    const { work, ctx, cleanup } = setup();
    try {
      fs.writeFileSync(path.join(work, 'package.json'), '{}'); // project marker
      fs.mkdirSync(path.join(work, 'src'), { recursive: true });
      fs.writeFileSync(path.join(work, 'src', 'a.txt'), 'original');
      const ws = fakeWs();

      handle({
        id: 'w1', method: 'writeFile', params: [path.join(work, 'src', 'a.txt'), 'CLOBBERED'],
        checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: null },
      }, ws, ctx);
      expect((await ws.response('w1')).result).toEqual({ success: true });
      expect(fs.readFileSync(path.join(work, 'src', 'a.txt'), 'utf8')).toBe('CLOBBERED');

      handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
      const list = (await ws.response('l')).result;
      expect(list).toHaveLength(1);
      expect(list[0].dir).toBe(work); // walked up to the package.json marker

      handle({ id: 'r', method: 'checkpointRestore', params: ['a', work, list[0].id] }, ws, ctx);
      await ws.response('r');
      expect(fs.readFileSync(path.join(work, 'src', 'a.txt'), 'utf8')).toBe('original');
    } finally { cleanup(); }
  });

  test('frames without a checkpoint hint behave exactly as before (no snapshot)', async () => {
    const { work, ctx, cleanup } = setup();
    try {
      const ws = fakeWs();
      handle({ id: 'rpc-nosnapexe0-1', method: 'exec', params: [`echo hi > ${work}/x.txt`] }, ws, ctx);
      expect((await ws.response('rpc-nosnapexe0-1')).result.exitCode).toBe(0);
      handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
      expect((await ws.response('l')).result).toEqual([]);
    } finally { cleanup(); }
  });

  test('degrades honestly when git is missing — operations still run, status says why', async () => {
    const { work, ctx, cleanup } = setup({ gitBin: '/nonexistent/definitely-not-git' });
    try {
      const ws = fakeWs();
      // The mutation is never blocked by the unavailable engine.
      handle({
        id: 'rpc-degexe1120-1', method: 'exec', params: [`echo ok > ${work}/y.txt`],
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
      handle({ id: 'r', method: 'checkpointRestore', params: ['a', work, 'abcdef0'] }, ws, ctx);
      expect((await ws.response('r')).error).toBe('checkpoints unavailable: git not found');
    } finally { cleanup(); }
  });

  test('retention prunes to the configured keep', async () => {
    const { work, ctx, cleanup } = setup({ keep: 2 });
    try {
      const ws = fakeWs();
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(path.join(work, 'n.txt'), `v${i}`);
        handle({ id: `e${i}`, method: 'exec', params: ['true'], checkpoint: { agent: 'a', turnId: `t${i}`, sessionId: 's', dir: work } }, ws, ctx);
        await ws.response(`e${i}`);
      }
      handle({ id: 'l', method: 'checkpointList', params: ['a'] }, ws, ctx);
      const list = (await ws.response('l')).result;
      expect(list).toHaveLength(2);
      expect(list.map((e) => e.turnId)).toEqual(['t3', 't2']);
    } finally { cleanup(); }
  });

  /**
   * The cloud path's store answers "what did THIS turn change", so a limit
   * cannot bury a checkpoint that exists. `listFileCheckpoints` forwards the
   * turn id here as the third param; before it did, the DO read a global window
   * and the web client filtered it itself, which is how a turn that had written
   * plenty was reported as "It changed no device files."
   */
  test('checkpointList narrows by turn in the store, so a limit cannot bury a turn', async () => {
    const { work, ctx, cleanup } = setup();
    try {
      const ws = fakeWs();
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(work, 'n.txt'), `v${i}`);
        handle({
          id: `e${i}`, method: 'exec', params: ['true'],
          checkpoint: { agent: 'a', turnId: `t${i}`, sessionId: 's', dir: work },
        }, ws, ctx);
        await ws.response(`e${i}`);
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
    } finally { cleanup(); }
  });
});

/**
 * The device half of the toolchain probe. The hub sends the binary names from
 * core's single table and this answers which of THOSE the machine has; the
 * answer becomes the `laptop` capability row the model routes work by.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-which-'));
    for (const name of names) {
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
    }
    return dir;
  }

  test('answers only about the names it was asked, and only those that resolve', async () => {
    const dir = pathWith(['node', 'git']);
    try {
      const ws = fakeWs();
      withPath(dir, () => handle({ id: 1, method: 'which', params: [['node', 'bun', 'git', 'python3']] }, ws, {}));

      // `bun` and `python3` are not there. Reported as absent, which is a
      // measurement — distinct from the hub never getting an answer at all.
      expect((await ws.response(1)).result).toEqual({ present: ['node', 'git'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a non-executable file of the right name is not a binary on PATH', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-which-'));
    fs.writeFileSync(path.join(dir, 'python3'), 'not a program', { mode: 0o644 });
    try {
      const ws = fakeWs();
      withPath(dir, () => handle({ id: 1, method: 'which', params: [['python3']] }, ws, {}));

      // The capability reads "Runs Python". A file nobody can execute does not.
      expect((await ws.response(1)).result).toEqual({ present: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to answer for anything but a bare binary name', async () => {
    const dir = pathWith(['node']);
    try {
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  test('HELLO on connect, rotation, exec, cancel, file op, and reconnect — all under Bun', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-e2e-'));
    // Outside KINU_HOME on purpose: Kinu's own directory is never served
    // through the tunnel (see the credential-fence test below), so a file op
    // that proves the socket works must target a consented directory instead.
    const files = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-e2e-files-'));
    try {
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

          // ROTATE: the hub rotates the long-lived token; the daemon persists it.
          const rotated = `pdt_${'c'.repeat(32)}`;
          hub.socket().send(JSON.stringify({ type: 'ROTATE', token: rotated }));
          await untilHub(() => JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).token === rotated);
          expect(JSON.parse(fs.readFileSync(path.join(root, 'device.json'), 'utf8')).token).toBe(rotated);
          expect(daemonLog()).toContain('Device token rotated');

          const reply = async (id, timeoutMs = 15_000) => {
            const frame = await untilHub(() => hub.frames.find((f) => f.id === id), timeoutMs);
            if (!frame) throw new Error(`no reply for ${id}: log says ${daemonLog()}`);
            return frame;
          };

          // exec round-trip through the real supervisor under Bun. The result
          // frame is then ACKED — the supervisor publishes its ack FIFO before
          // the result and exits only once the cloud confirms receipt, so an
          // un-acked exec leaves a detached grandchild holding this runner's
          // process table open after the test ends.
          hub.socket().send(JSON.stringify({ id: 'rpc-e2eexec00A-1', method: 'exec', params: ['echo hello-from-daemon'] }));
          const execResult = await reply('rpc-e2eexec00A-1');
          expect(execResult.result.exitCode).toBe(0);
          expect(execResult.result.stdout).toContain('hello-from-daemon');
          hub.socket().send(JSON.stringify({ id: 'rpc-e2eack00A-1', method: 'execAck', params: ['rpc-e2eexec00A-1', 1] }));
          await reply('rpc-e2eack00A-1');

          // execCancel: a command that outlives its cancellation window.
          hub.socket().send(JSON.stringify({ id: 'rpc-e2ecancelf-1', method: 'exec', params: ['sleep 30'] }));
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
          hub.socket().send(JSON.stringify({ id: 'rpc-e2efile0-1', method: 'writeFile', params: [note, 'bun wrote this'] }));
          const writeResult = await reply('rpc-e2efile0-1');
          expect(writeResult.result).toEqual({ success: true });
          expect(fs.readFileSync(note, 'utf-8')).toBe('bun wrote this');

          // Reconnect after a socket drop: the hub closes; the daemon redials.
          hub.socket().close();
          const hello2 = await untilHub(() => hub.frames.filter((f) => f.type === 'HELLO')[1]);
          expect(hello2).toBeDefined();
        } finally {
          // Teardown owns three things the runner's exit depends on: the
          // daemon child (SIGTERM, then reaped through .exited), the in-flight
          // root (any supervisor the test failed to ack dies with its process
          // group — killing by -pid on the child's group is not possible here
          // because Bun.spawn above is not detached, so each supervisor's own
          // directory is checked and removed), and the hub.
          child.kill('SIGTERM');
          await child.exited;
          const inflight = path.join(root, 'inflight');
          if (fs.existsSync(inflight)) {
            for (const entry of fs.readdirSync(inflight)) {
              const state = path.join(inflight, entry, 'state');
              if (!fs.existsSync(state)) continue;
              const pid = Number(/^pid=(\d+)$/m.exec(fs.readFileSync(state, 'utf-8'))?.[1]);
              // ESRCH is the supervisor already being gone; that is the
              // teardown's goal, so nothing rethrows past it.
              if (Number.isInteger(pid) && pid > 0) tolerate(() => process.kill(-pid, 'SIGKILL'), 'esrch');
            }
          }
        }
      } finally {
        await hub.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(files, { recursive: true, force: true });
    }
  // A finite sequence, with its own waits: every `untilHub` fails by name
  // within its 10-15 s. The outer bound is their sum, not a detector — the
  // sequence spawns three Bun processes and the daemon's 1 s reconnect
  // backoff sits inside it, and it measured 11.9-12.0 s on a box at load
  // 64 (three runs, 2026-09-02), where bun's default 5 s read red.
  }, 60_000);

  /**
   * One connected daemon, torn down. Composed from the four helpers above so
   * each hardening case below is its own named failure rather than another
   * phase inside the sequence test.
   */
  async function withDaemon(extraEnv, body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-case-'));
    try {
      const hub = startFakeHub();
      try {
        makeConfig(root, hub.origin);
        const { child, logPath } = spawnDaemon(root, extraEnv);
        const daemonLog = () => fs.readFileSync(logPath, 'utf-8');
        try {
          const hello = await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'));
          if (!hello) throw new Error(`daemon never connected: log says ${daemonLog()}`);
          const reply = async (id, timeoutMs = 15_000) => {
            const frame = await untilHub(() => hub.frames.find((f) => f.id === id), timeoutMs);
            if (!frame) throw new Error(`no reply for ${id}: log says ${daemonLog()}`);
            return frame;
          };
          await body({ hub, root, child, reply, daemonLog });
        } finally {
          child.kill('SIGTERM');
          await child.exited;
          const inflight = path.join(root, 'inflight');
          if (fs.existsSync(inflight)) {
            for (const entry of fs.readdirSync(inflight)) {
              const state = path.join(inflight, entry, 'state');
              if (!fs.existsSync(state)) continue;
              const pid = Number(/^pid=(\d+)$/m.exec(fs.readFileSync(state, 'utf-8'))?.[1]);
              if (Number.isInteger(pid) && pid > 0) tolerate(() => process.kill(-pid, 'SIGKILL'), 'esrch');
            }
          }
        }
      } finally {
        await hub.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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
  // on which root the call carries: these frames send NO root at all, which is
  // the full tier — the strongest thing a workspace can hold.
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
        hub.socket().send(JSON.stringify({ id, method, params }));
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
        hub.socket().send(JSON.stringify({ id: 'rpc-fence00sy-1', method: 'readFile', params: [bait] }));
        expect((await reply('rpc-fence00sy-1')).error).toContain("inside Kinu's own directory");
      } finally {
        fs.rmSync(bait, { force: true });
      }
    });
  }, 60_000);

  // F8. The daemon inherits the shell that ran `kinu connect`. Before this,
  // every command inherited that whole environment, so one `env` turned a
  // shell grant into the owner's CLI bearer, their PAT and their SSH agent.
  test('a command gets an allow-listed environment, never the daemon\'s inherited credentials', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    // NODE_OPTIONS is the code-loading class the allow-list exists for, and
    // bun ignores it, so a pre-fix tree still RUNS the command and the failure
    // below is the credential leak rather than a broken spawn. BUN_INSPECT is
    // the same class and the same construction excludes it, but a pre-fix
    // supervisor exits 1 trying to open that socket, which proves nothing
    // about credentials.
    const poison = {
      KINU_TOKEN: 'ptc_leaked_cli_bearer',
      KINU_AUTH: 'leaked-gateway-auth',
      GITHUB_TOKEN: 'ghp_leaked_pat',
      AWS_SECRET_ACCESS_KEY: 'leaked-aws-key',
      SSH_AUTH_SOCK: '/tmp/leaked-agent.sock',
      NODE_OPTIONS: '--require /tmp/leaked-preload.js',
    };
    await withDaemon(poison, async ({ hub, reply }) => {
      hub.socket().send(JSON.stringify({ id: 'rpc-envdump000-1', method: 'exec', params: ['env'] }));
      const dumped = await reply('rpc-envdump000-1');
      expect(dumped.error).toBeUndefined();
      expect(dumped.result.exitCode).toBe(0);
      const names = new Set(
        dumped.result.stdout.split('\n')
          .filter((line) => line.includes('='))
          .map((line) => line.slice(0, line.indexOf('='))),
      );
      // A command that cannot find its own tools is not hardened, it is broken.
      expect(names.has('PATH')).toBe(true);
      expect(names.has('HOME')).toBe(true);
      // Asserted as a SET so the failure names what leaked.
      expect([...names].filter((name) => Object.hasOwn(poison, name))).toEqual([]);
      expect(dumped.result.stdout).not.toContain('ptc_leaked_cli_bearer');
      expect(dumped.result.stdout).not.toContain('ghp_leaked_pat');

      hub.socket().send(JSON.stringify({ id: 'rpc-envdmpack-1', method: 'execAck', params: ['rpc-envdump000-1', 1] }));
      await reply('rpc-envdmpack-1');
    });
  }, 60_000);

  // The supervisor holds a terminal result until the cloud acknowledges it,
  // and the daemon is the FIFO's only writer. A daemon that dies in that
  // window used to leave the supervisor waiting forever; 156 of them were
  // found on one machine in a day, each from a test whose daemon exited.
  test('a supervisor whose daemon is gone stops waiting for an ack nobody can send', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-orphan-'));
    const requestId = 'rpc-orphanwait-1';
    const requestDir = path.join(root, 'inflight', requestId);
    let supervisorPid = 0;
    try {
      const hub = startFakeHub();
      try {
        makeConfig(root, hub.origin);
        const first = spawnDaemon(root);
        const firstLog = () => fs.readFileSync(first.logPath, 'utf-8');
        expect(await untilHub(() => hub.frames.find((f) => f.type === 'HELLO'))).toBeDefined();
        hub.socket().send(JSON.stringify({ id: requestId, method: 'exec', params: ['printf orphan-check'] }));
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
          expect(await untilHub(() => hub.frames.filter((f) => f.type === 'HELLO')[1])).toBeDefined();
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
      fs.rmSync(root, { recursive: true, force: true });
    }
  // Two daemon spawns, one exec, and the supervisor's 1 s orphan poll, each
  // with its own named wait inside.
  }, 60_000);
});
