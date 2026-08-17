/**
 * PC-agent daemon — protocol round-trips through handle() with REAL git
 * (no mocks on the checkpoint path): the pre-mutation snapshot hint on
 * exec/writeFile frames, the checkpoint RPC methods, and the honest
 * degraded mode when git is missing.
 */
'use strict';
const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handle, createCheckpoints } = require('../src/index.js');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proteus-daemon-'));
  const work = path.join(root, 'project');
  fs.mkdirSync(work, { recursive: true });
  const ctx = { checkpoints: createCheckpoints({ base: path.join(root, 'shadow'), keep: opts.keep, gitBin: opts.gitBin }) };
  return { root, work, ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('daemon checkpoint protocol', () => {
  test('an exec frame with a checkpoint hint snapshots before running; restore round-trips', async () => {
    const { work, ctx, cleanup } = setup();
    try {
      fs.writeFileSync(path.join(work, 'data.txt'), 'original');
      const ws = fakeWs();

      handle({
        id: 'r1', method: 'exec', params: [`echo CLOBBERED > ${work}/data.txt && rm -f ${work}/data.txt && echo gone > ${work}/extra.txt`],
        checkpoint: { agent: 'cloud-agent', turnId: 'turn-1', sessionId: 'default', dir: work },
      }, ws, ctx);
      const exec = await ws.response('r1');
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
      handle({ id: 'e', method: 'exec', params: [`echo hi > ${work}/x.txt`] }, ws, ctx);
      expect((await ws.response('e')).result.exitCode).toBe(0);
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
        id: 'e', method: 'exec', params: [`echo ok > ${work}/y.txt`],
        checkpoint: { agent: 'a', turnId: 't', sessionId: 's', dir: work },
      }, ws, ctx);
      expect((await ws.response('e')).result.exitCode).toBe(0);
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
