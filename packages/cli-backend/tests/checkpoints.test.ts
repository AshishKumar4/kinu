/**
 * Shadow-git checkpoint engine — behavior tests against REAL git on this
 * host (no mocks on the engine path). Covers the borrow-list #6 contract:
 * one snapshot per turn at the first mutation, exact restore (content,
 * deletions, additions), the user's own .git untouched, bounded retention,
 * and honest degradation without git.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { git } from '@kinu.run/test-utils';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createAgentConfigStore, summarizeRestorePlan } from '@kinu.run/core';
import { createHostCheckpoints } from '../src/checkpoints';
import { createCLIRuntime } from '../src/runtime';

function setup(opts: { keep?: number; gitBin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kinu-ckpt-'));
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
      expect(refs).not.toContain('refs/kinu');
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

  /**
   * THE WINDOW CANNOT HIDE A CHECKPOINT THAT EXISTS.
   *
   * Retention is per WORKING DIRECTORY (`DEFAULT_CHECKPOINT_KEEP` = 50) while
   * the reader's limit is global across every directory — the web client asks
   * for 200 (WorkspacePage.tsx) and then filters by turn on the CLIENT. So once
   * the operator has a handful of active directories, total entries pass the
   * limit and a turn whose checkpoint is STILL RETAINED falls outside the
   * window. The client saw an empty filter result and rendered it as a fact
   * about the world: "This turn changed no files on your machine."
   *
   * Same class as the availability lie fixed above it, and the same class as the
   * chat-history incident: a read that silently returns a short window, reported
   * as an absence. Scaled down here (3 dirs x keep 4, read 6) because the defect
   * is `limit < total retained`, not the literal 200.
   */
  test('a turn-keyed read finds a checkpoint the global window cannot reach', async () => {
    const { root, engine, cleanup } = setup({ keep: 4 });
    try {
      const dirs = ['alpha', 'beta', 'gamma'].map((name) => {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        return dir;
      });
      // The turn under test is the OLDEST, in the FIRST directory, so every
      // later checkpoint outranks it in a newest-first window.
      const buried = 'turn-buried';
      for (const [index, dir] of dirs.entries()) {
        for (let i = 0; i < 4; i++) {
          writeFileSync(join(dir, 'counter.txt'), `d${String(index)} v${String(i)}`);
          engine.beginTurn({
            turnId: index === 0 && i === 0 ? buried : `turn-${String(index)}-${String(i)}`,
            sessionId: 's',
          });
          expect(await engine.ensureCheckpoint(dir)).toBeTruthy();
        }
      }

      // It survived retention: per-directory pruning keeps 4 and each got 4.
      const everything = await engine.list({ limit: 1000 });
      expect(everything).toHaveLength(12);
      expect(everything.filter((e) => e.turnId === buried)).toHaveLength(1);

      // But the window the client uses cannot see it — this is the lie.
      const windowed = await engine.list({ limit: 6 });
      expect(windowed).toHaveLength(6);
      expect(windowed.filter((e) => e.turnId === buried)).toHaveLength(0);

      // A turn-keyed read finds it regardless of how many newer ones exist, and
      // the limit cannot bury it, because the store filters before it truncates.
      const keyed = await engine.list({ turnId: buried, limit: 6 });
      expect(keyed).toHaveLength(1);
      expect(keyed[0]!.turnId).toBe(buried);
      expect(keyed[0]!.dir).toBe(dirs[0]);

      // And a turn that genuinely has no checkpoint still reads empty, so the
      // fix does not make every turn look restorable.
      expect(await engine.list({ turnId: 'never-ran' })).toEqual([]);
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

  test('a path it may not read is skipped and named in the record, not a failed checkpoint', async () => {
    // The live failure verbatim: `checkpoint staging failed: warning: could not
    // open directory 'systemd-private-…'`, which accounted for 3 of 4
    // `execute_tools` failures in one run. A directory owned by someone else is
    // not a failed checkpoint, and refusing to snapshot is not a reason to
    // refuse the agent's write.
    const { work, engine, cleanup } = setup();
    const foreign = join(work, 'systemd-private-9f2c');
    try {
      writeFileSync(join(work, 'a.txt'), 'mine');
      // Sorts AFTER both unreadable entries, so a staging pass that aborts on
      // the first refusal leaves it out of the snapshot — a checkpoint missing
      // files restores a tree the user never had.
      writeFileSync(join(work, 'zz.txt'), 'also mine');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'inside.txt'), 'not mine');
      writeFileSync(join(work, 'locked.txt'), 'not mine either');
      chmodSync(join(work, 'locked.txt'), 0o000);
      chmodSync(foreign, 0o000);

      engine.beginTurn({ turnId: 't', sessionId: 's' });
      const id = await engine.ensureCheckpoint(work, 'file write');
      expect(id).toBeTruthy();

      // RECORDED, not swallowed: the snapshot says which paths are missing from
      // it, so an incomplete restore is explainable rather than surprising.
      const [entry] = await engine.list();
      expect(entry!.reason).toBe('file write [skipped 2 unreadable: locked.txt systemd-private-9f2c]');

      // And the readable tree is WHOLE — including the file that sorts after the
      // refusals, which is what an aborted staging pass would have dropped.
      writeFileSync(join(work, 'a.txt'), 'clobbered');
      rmSync(join(work, 'zz.txt'));
      await engine.restore(work, id!);
      expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('mine');
      expect(readFileSync(join(work, 'zz.txt'), 'utf8')).toBe('also mine');

      // The unreadable paths are untouched by the restore: absent from the tree
      // means absent from the restore's business, never "delete it".
      expect(existsSync(join(work, 'locked.txt'))).toBe(true);
      expect(existsSync(foreign)).toBe(true);
    } finally {
      chmodSync(foreign, 0o700);
      cleanup();
    }
  });

  test('the shared temp root is not a work tree, so it is never snapshotted', async () => {
    // `workdirForPath('/tmp/scratch.js')` finds no project marker above it and
    // answers `/tmp` — 12,017 entries on this box, belonging to every process
    // and user on the machine. Tolerating the unreadable ones (above) is what
    // makes staging that tree SUCCEED, so this is the difference between a
    // skipped snapshot and copying the box's scratch into the agent's store.
    const { engine, cleanup } = setup();
    try {
      expect(engine.workdirForPath(join(tmpdir(), 'scratch.js'))).toBe(tmpdir());

      engine.beginTurn({ turnId: 't', sessionId: 's' });
      expect(await engine.ensureCheckpoint(tmpdir(), 'file write')).toBeNull();
      expect(await engine.ensureCheckpoint('/var/tmp', 'file write')).toBeNull();
      expect(await engine.list()).toEqual([]);
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

describe('checkpointed runtime shell', () => {
  test('any shell exec snapshots the cwd before running (first mutation per turn)', async () => {
    const { root, work, cleanup } = setup();
    const db = new Database(':memory:');
    try {
      writeFileSync(join(work, 'precious.txt'), 'original');
      // Checkpoint storage is global per agent name, so this fixture mints a
      // unique one. A stable test name would read valid stores from prior runs.
      const rt = createCLIRuntime(db, {
        dbPath: join(root, 'agent.db'),
        cwd: work,
        agentName: `ckpt-shell-test-${String(Date.now())}-${String(process.pid)}`,
        llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
      });
      // The default is 'strict', which asks a channel this runtime has none of.
      createAgentConfigStore(rt.storage.sql).setShellApprovalMode('allow_all');
      const shell = rt.shell;
      if (!shell) throw new Error('a bound runtime must have a shell');
      const checkpoints = rt.checkpoints;
      if (!checkpoints) throw new Error('a bound runtime must have a checkpoint engine');

      checkpoints.beginTurn({ turnId: 'shell-turn', sessionId: 's' });
      const result = await shell.exec('echo CLOBBERED > precious.txt');
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(work, 'precious.txt'), 'utf8').trim()).toBe('CLOBBERED');

      const [entry] = await checkpoints.list();
      expect(entry!.turnId).toBe('shell-turn');
      await checkpoints.restore(work, entry!.id);
      expect(readFileSync(join(work, 'precious.txt'), 'utf8')).toBe('original');
    } finally {
      db.close();
      cleanup();
    }
  });
});
