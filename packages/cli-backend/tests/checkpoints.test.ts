/**
 * Shadow-git checkpoint engine — behavior tests against REAL git on this
 * host (no mocks on the engine path). Covers the borrow-list #6 contract:
 * one snapshot per turn at the first mutation, exact restore (content,
 * deletions, additions), the user's own .git untouched, bounded retention,
 * and honest degradation without git.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { git } from '@proteus/test-utils';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeRestorePlan } from '@proteus/core';
import { createHostCheckpoints } from '../src/checkpoints.js';
import { createHostShell, withCheckpointedShell } from '../src/runtime.js';

function setup(opts: { keep?: number; gitBin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'proteus-ckpt-'));
  const work = join(root, 'project');
  mkdirSync(work, { recursive: true });
  const engine = createHostCheckpoints({
    agent: 'test-agent',
    base: join(root, 'shadow'),
    keep: opts.keep,
    gitBin: opts.gitBin,
  });
  return { root, work, engine, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('createHostCheckpoints', () => {
  test('first mutation in a turn snapshots once; later mutations in the same turn do not', async () => {
    const { work, engine, cleanup } = setup();
    try {
      writeFileSync(join(work, 'a.txt'), 'one');
      engine.beginTurn({ turnId: 'turn-1', sessionId: 'sess-1' });
      const first = await engine.ensureCheckpoint(work);
      expect(first).toBeTruthy();
      writeFileSync(join(work, 'a.txt'), 'two');
      expect(await engine.ensureCheckpoint(work)).toBeNull(); // deduped within the turn

      engine.beginTurn({ turnId: 'turn-2', sessionId: 'sess-1' });
      const second = await engine.ensureCheckpoint(work);
      expect(second).toBeTruthy();
      expect(second).not.toBe(first!);

      const list = await engine.list();
      expect(list).toHaveLength(2);
      expect(list[0]!.turnId).toBe('turn-2');
      expect(list[1]!.turnId).toBe('turn-1');
      expect(list.every((e) => e.sessionId === 'sess-1' && e.dir === work)).toBe(true);
    } finally { cleanup(); }
  });

  test('an unchanged tree produces no new checkpoint', async () => {
    const { work, engine, cleanup } = setup();
    try {
      writeFileSync(join(work, 'a.txt'), 'same');
      engine.beginTurn({ turnId: 't1', sessionId: 's' });
      const first = await engine.ensureCheckpoint(work);
      engine.beginTurn({ turnId: 't2', sessionId: 's' });
      const second = await engine.ensureCheckpoint(work); // nothing changed
      expect(second).toBe(first!);
      expect(await engine.list()).toHaveLength(1);
    } finally { cleanup(); }
  });

  test('restore returns exact multi-file content, recreates deletions, removes additions', async () => {
    const { work, engine, cleanup } = setup();
    try {
      mkdirSync(join(work, 'src'), { recursive: true });
      writeFileSync(join(work, 'src', 'main.ts'), 'original main');
      writeFileSync(join(work, 'README.md'), 'original readme');
      writeFileSync(join(work, 'doomed.txt'), 'will be deleted by the agent');

      engine.beginTurn({ turnId: 'turn-1', sessionId: 's' });
      const id = await engine.ensureCheckpoint(work);
      expect(id).toBeTruthy();

      // The "agent" then mutates everything: edit, delete, create.
      writeFileSync(join(work, 'src', 'main.ts'), 'CLOBBERED');
      writeFileSync(join(work, 'README.md'), 'CLOBBERED TOO');
      rmSync(join(work, 'doomed.txt'));
      writeFileSync(join(work, 'new-junk.txt'), 'created after the checkpoint');

      const plan = await engine.plan(work, id!);
      const kinds = Object.fromEntries(plan.files.map((f) => [f.path, f.kind]));
      expect(kinds['src/main.ts']).toBe('modify');
      expect(kinds['README.md']).toBe('modify');
      expect(kinds['doomed.txt']).toBe('create');     // restore re-creates it
      expect(kinds['new-junk.txt']).toBe('delete');   // restore removes it
      expect(summarizeRestorePlan(plan.files)).toEqual({ modified: 2, created: 1, deleted: 1 });

      const result = await engine.restore(work, id!);
      expect(result.preRestoreId).toBeTruthy();
      expect(readFileSync(join(work, 'src', 'main.ts'), 'utf8')).toBe('original main');
      expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('original readme');
      expect(readFileSync(join(work, 'doomed.txt'), 'utf8')).toBe('will be deleted by the agent');
      expect(existsSync(join(work, 'new-junk.txt'))).toBe(false);

      // Undo-the-undo: the pre-restore snapshot restores the clobbered state.
      await engine.restore(work, result.preRestoreId!);
      expect(readFileSync(join(work, 'src', 'main.ts'), 'utf8')).toBe('CLOBBERED');
      expect(existsSync(join(work, 'doomed.txt'))).toBe(false);
      expect(readFileSync(join(work, 'new-junk.txt'), 'utf8')).toBe('created after the checkpoint');
    } finally { cleanup(); }
  });

  test('the pre-restore snapshot carries no turn meta even while a turn is armed', async () => {
    const { work, engine, cleanup } = setup();
    try {
      writeFileSync(join(work, 'a.txt'), 'original');
      engine.beginTurn({ turnId: 'turn-1', sessionId: 's' });
      const id = await engine.ensureCheckpoint(work);
      writeFileSync(join(work, 'a.txt'), 'damage');

      // The turn is still armed when /undo restores mid-session; the safety
      // snapshot must NOT inherit it, or /undo groups it with turn-1 and
      // "/undo 1" after a restore lands back on the pre-turn state.
      const result = await engine.restore(work, id!);
      const entries = await engine.list();
      const preRestore = entries.find((e) => e.id === result.preRestoreId);
      expect(preRestore).toBeDefined();
      expect(preRestore!.reason).toBe('pre-restore');
      expect(preRestore!.turnId).toBeNull();
      expect(preRestore!.sessionId).toBeNull();
      const turnSnapshot = entries.find((e) => e.id === id);
      expect(turnSnapshot!.turnId).toBe('turn-1');
    } finally { cleanup(); }
  });

  test("the user's own .git repo is never snapshotted or touched", async () => {
    const { work, engine, cleanup } = setup();
    try {
      // A real user repo in the target dir. `git()` clears the whole GIT_
      // prefix, not just the config vars: a git hook exports GIT_DIR, and with
      // it set these `cwd: work` calls read and write the developer's checkout.
      git(work, 'init', '--quiet', '-b', 'main');
      writeFileSync(join(work, 'file.txt'), 'v1');
      git(work, 'add', '-A');
      git(work, '-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-q', '-m', 'user commit');
      const userHeadBefore = git(work, 'rev-parse', 'HEAD').trim();

      engine.beginTurn({ turnId: 't', sessionId: 's' });
      const id = await engine.ensureCheckpoint(work);
      writeFileSync(join(work, 'file.txt'), 'v2');
      await engine.restore(work, id!);

      // The user's repo is untouched: same HEAD, fully functional, no shadow
      // refs leaked into it.
      expect(git(work, 'rev-parse', 'HEAD').trim()).toBe(userHeadBefore);
      const refs = git(work, 'for-each-ref');
      expect(refs).not.toContain('refs/proteus');
      // And the snapshot itself excluded .git entirely.
      const plan = await engine.plan(work, id!);
      expect(plan.files.every((f) => !f.path.startsWith('.git/'))).toBe(true);
      expect(readFileSync(join(work, 'file.txt'), 'utf8')).toBe('v1');
    } finally { cleanup(); }
  });

  test('retention keeps only the newest N checkpoints', async () => {
    const { work, engine, cleanup } = setup({ keep: 3 });
    try {
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(work, 'counter.txt'), `value ${i}`);
        engine.beginTurn({ turnId: `turn-${i}`, sessionId: 's' });
        expect(await engine.ensureCheckpoint(work)).toBeTruthy();
      }
      const list = await engine.list();
      expect(list).toHaveLength(3);
      expect(list.map((e) => e.turnId)).toEqual(['turn-4', 'turn-3', 'turn-2']);
    } finally { cleanup(); }
  });

  test('degrades honestly when git is not installed', async () => {
    const { work, engine, cleanup } = setup({ gitBin: '/nonexistent/definitely-not-git' });
    try {
      writeFileSync(join(work, 'a.txt'), 'data');
      engine.beginTurn({ turnId: 't', sessionId: 's' });
      // Never blocks the mutation path:
      expect(await engine.ensureCheckpoint(work)).toBeNull();
      expect(await engine.list()).toEqual([]);
      expect(await engine.status()).toEqual({ available: false, reason: 'checkpoints unavailable: git not found' });
      expect(engine.restore(work, 'abcdef0')).rejects.toThrow('checkpoints unavailable: git not found');
    } finally { cleanup(); }
  });

  test('a vanished workdir fails the operation without flipping into git-not-found mode', async () => {
    const { work, engine, cleanup } = setup();
    try {
      writeFileSync(join(work, 'a.txt'), 'x');
      engine.beginTurn({ turnId: 't', sessionId: 's' });
      const id = await engine.ensureCheckpoint(work);
      rmSync(work, { recursive: true, force: true });
      expect(engine.plan(work, id!)).rejects.toThrow('working directory');
      expect(await engine.status()).toEqual({ available: true }); // git is still here
    } finally { cleanup(); }
  });

  test('workdirForPath resolves the nearest project marker dir', async () => {
    const { work, engine, cleanup } = setup();
    try {
      mkdirSync(join(work, 'nested', 'deep'), { recursive: true });
      writeFileSync(join(work, 'package.json'), '{}');
      writeFileSync(join(work, 'nested', 'deep', 'file.txt'), 'x');
      expect(engine.workdirForPath(join(work, 'nested', 'deep', 'file.txt'))).toBe(work);
      expect(engine.workdirForPath(join(work, 'nested', 'deep'))).toBe(work);
    } finally { cleanup(); }
  });
});

describe('withCheckpointedShell', () => {
  test('any shell exec snapshots the cwd before running (first mutation per turn)', async () => {
    const { work, engine, cleanup } = setup();
    try {
      writeFileSync(join(work, 'precious.txt'), 'original');
      const shell = withCheckpointedShell(createHostShell(work), engine, work);

      engine.beginTurn({ turnId: 'shell-turn', sessionId: 's' });
      const result = await shell.exec('echo CLOBBERED > precious.txt');
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(work, 'precious.txt'), 'utf8').trim()).toBe('CLOBBERED');

      const [entry] = await engine.list();
      expect(entry!.turnId).toBe('shell-turn');
      await engine.restore(work, entry!.id);
      expect(readFileSync(join(work, 'precious.txt'), 'utf8')).toBe('original');
    } finally { cleanup(); }
  });
});
