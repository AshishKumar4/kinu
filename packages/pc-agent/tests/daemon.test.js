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

/**
 * The daemon's in-flight root, isolated to this run, and set BEFORE the daemon
 * module loads because it reads the variable once at import.
 *
 * Unset, it resolves to `~/.kinu/inflight` — a real directory in the running
 * user's home. `handle()` treats an existing request directory as a request
 * already supervised and replays its recorded state instead of running the
 * command, so a literal request id turned every run after the first into a
 * replay of the first: the command never executed, the frame still carried
 * exit 0, and the assertions about its effects failed. The suite also left its
 * ids behind in the user's home.
 */
const INFLIGHT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-daemon-inflight-'));
process.env.KINU_INFLIGHT_ROOT = INFLIGHT_ROOT;
afterAll(() => { fs.rmSync(INFLIGHT_ROOT, { recursive: true, force: true }); });

const {
  handle,
  createCheckpoints,
  getConnectTicket,
  persistRotatedToken,
  handleTokenRotation,
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
      return new Response(JSON.stringify({ ticket: 'pct_ticket' }), {
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
