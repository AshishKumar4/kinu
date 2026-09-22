/** Shadow-git checkpoint engine against real git: per-turn snapshot, exact restore, user .git untouched, bounded retention. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { scratchDir, git, present } from '@kinu.run/test-utils';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { summarizeRestorePlan } from '@kinu.run/core';
import { createHostCheckpoints } from '../src/checkpoints';
import { createCLIRuntime } from '../src/runtime';

function setup(opts: { keep?: number; gitBin?: string } = {}) {
  const root = scratchDir('ckpt');
  const work = join(root, 'project');
  mkdirSync(work, { recursive: true });

  const engine = createHostCheckpoints({
    agent: 'test-agent',
    base: join(root, 'shadow'),
    keep: opts.keep,
    gitBin: opts.gitBin,
  });

  return { root, work, engine };
}

describe('createHostCheckpoints', () => {
  test('first mutation in a turn snapshots once; later mutations in the same turn do not', async () => {
    const { work, engine } = setup();

    writeFileSync(join(work, 'a.txt'), 'one');
    engine.beginTurn({ turnId: 'turn-1', sessionId: 'sess-1' });
    const first = await engine.ensureCheckpoint(work);
    expect(first).toBeTruthy();
    writeFileSync(join(work, 'a.txt'), 'two');
    expect(await engine.ensureCheckpoint(work)).toBeNull();

    engine.beginTurn({ turnId: 'turn-2', sessionId: 'sess-1' });
    const second = await engine.ensureCheckpoint(work);
    expect(second).toBeTruthy();

    const list = await engine.list();
    expect(list).toHaveLength(2);
    expect(list[0].turnId).toBe('turn-2');
    expect(list[1].turnId).toBe('turn-1');
    expect(list.map((e) => [e.sessionId, e.dir])).toEqual([['sess-1', work], ['sess-1', work]]);
  });

  test('an unchanged tree produces no new checkpoint', async () => {
    const { work, engine } = setup();

    writeFileSync(join(work, 'a.txt'), 'same');
    engine.beginTurn({ turnId: 't1', sessionId: 's' });
    const first = await engine.ensureCheckpoint(work);
    engine.beginTurn({ turnId: 't2', sessionId: 's' });
    const second = await engine.ensureCheckpoint(work);
    expect(second).toBe(first);
    expect(await engine.list()).toHaveLength(1);
  });

  test('restore returns exact multi-file content, recreates deletions, removes additions', async () => {
    const { work, engine } = setup();

    mkdirSync(join(work, 'src'), { recursive: true });
    writeFileSync(join(work, 'src', 'main.ts'), 'original main');
    writeFileSync(join(work, 'README.md'), 'original readme');
    writeFileSync(join(work, 'doomed.txt'), 'will be deleted by the agent');

    engine.beginTurn({ turnId: 'turn-1', sessionId: 's' });
    const id = present(await engine.ensureCheckpoint(work), 'the turn checkpoint id');

    expect(id).toBeTruthy();

    writeFileSync(join(work, 'src', 'main.ts'), 'CLOBBERED');
    writeFileSync(join(work, 'README.md'), 'CLOBBERED TOO');
    rmSync(join(work, 'doomed.txt'));
    writeFileSync(join(work, 'new-junk.txt'), 'created after the checkpoint');

    const plan = await engine.plan(work, id);
    const kinds = Object.fromEntries(plan.files.map((f) => [f.path, f.kind]));
    expect(kinds['src/main.ts']).toBe('modify');
    expect(kinds['README.md']).toBe('modify');
    expect(kinds['doomed.txt']).toBe('create');
    expect(kinds['new-junk.txt']).toBe('delete');
    expect(summarizeRestorePlan(plan.files)).toEqual({ modified: 2, created: 1, deleted: 1 });

    const result = await engine.restore(work, id);

    expect(result.preRestoreId).toBeTruthy();
    expect(readFileSync(join(work, 'src', 'main.ts'), 'utf8')).toBe('original main');
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('original readme');
    expect(readFileSync(join(work, 'doomed.txt'), 'utf8')).toBe('will be deleted by the agent');
    expect(existsSync(join(work, 'new-junk.txt'))).toBe(false);

    await engine.restore(work, present(result.preRestoreId, 'the pre-restore snapshot id'));
    expect(readFileSync(join(work, 'src', 'main.ts'), 'utf8')).toBe('CLOBBERED');
    expect(existsSync(join(work, 'doomed.txt'))).toBe(false);
    expect(readFileSync(join(work, 'new-junk.txt'), 'utf8')).toBe('created after the checkpoint');
  });

  test('the pre-restore snapshot carries no turn meta even while a turn is armed', async () => {
    const { work, engine } = setup();

    writeFileSync(join(work, 'a.txt'), 'original');
    engine.beginTurn({ turnId: 'turn-1', sessionId: 's' });
    const id = present(await engine.ensureCheckpoint(work), 'the turn checkpoint id');

    writeFileSync(join(work, 'a.txt'), 'damage');

    // The turn is still armed during /undo; the safety snapshot must not inherit it or "/undo 1" lands on the pre-turn state.
    const result = await engine.restore(work, id);
    const entries = await engine.list();
    const preRestore = present(entries.find((e) => e.id === result.preRestoreId), 'the pre-restore snapshot entry');
    const turnSnapshot = present(entries.find((e) => e.id === id), 'the turn snapshot entry');

    expect(preRestore.reason).toBe('pre-restore');
    expect(preRestore.turnId).toBeNull();
    expect(preRestore.sessionId).toBeNull();
    expect(turnSnapshot.turnId).toBe('turn-1');
  });

  test("the user's own .git repo is never snapshotted or touched", async () => {
    const { work, engine } = setup();

    // `git()` clears every GIT_ var: a hook-exported GIT_DIR would redirect these calls to the developer's checkout.
    git(work, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(work, 'file.txt'), 'v1');
    git(work, 'add', '-A');
    git(work, '-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-q', '-m', 'user commit');
    const userHeadBefore = git(work, 'rev-parse', 'HEAD').trim();

    engine.beginTurn({ turnId: 't', sessionId: 's' });
    const id = present(await engine.ensureCheckpoint(work), 'the turn checkpoint id');

    writeFileSync(join(work, 'file.txt'), 'v2');
    await engine.restore(work, id);

    expect(git(work, 'rev-parse', 'HEAD').trim()).toBe(userHeadBefore);
    const refs = git(work, 'for-each-ref');
    expect(refs).not.toContain('refs/kinu');
    const plan = await engine.plan(work, id);

    expect(plan.files.filter((f) => f.path.startsWith('.git/'))).toEqual([]);
    expect(readFileSync(join(work, 'file.txt'), 'utf8')).toBe('v1');
  });

  test('retention keeps only the newest N checkpoints', async () => {
    const { work, engine } = setup({ keep: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(join(work, 'counter.txt'), `value ${i}`);
      engine.beginTurn({ turnId: `turn-${i}`, sessionId: 's' });
      expect(await engine.ensureCheckpoint(work)).toBeTruthy();
    }

    const list = await engine.list();
    expect(list).toHaveLength(3);
    expect(list.map((e) => e.turnId)).toEqual(['turn-4', 'turn-3', 'turn-2']);
  });

  /**
   * Retention is per directory (`DEFAULT_CHECKPOINT_KEEP`) but the web client's read limit is global,
   * so a retained checkpoint can fall outside the window and read as "no files changed". Scaled to 3 dirs x keep 4, read 6.
   */
  test('a turn-keyed read finds a checkpoint the global window cannot reach', async () => {
    const { root, engine } = setup({ keep: 4 });

    const dirs = ['alpha', 'beta', 'gamma'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });

      return dir;
    });

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

    const everything = await engine.list({ limit: 1000 });
    expect(everything).toHaveLength(12);
    expect(everything.filter((e) => e.turnId === buried)).toHaveLength(1);

    const windowed = await engine.list({ limit: 6 });
    expect(windowed).toHaveLength(6);
    expect(windowed.filter((e) => e.turnId === buried)).toHaveLength(0);

    // The store filters by turn before it truncates, so the limit cannot bury it.
    const keyed = await engine.list({ turnId: buried, limit: 6 });
    expect(keyed).toHaveLength(1);
    expect(keyed[0].turnId).toBe(buried);
    expect(keyed[0].dir).toBe(dirs[0]);

    expect(await engine.list({ turnId: 'never-ran' })).toEqual([]);
  });

  test('degrades honestly when git is not installed', async () => {
    const { work, engine } = setup({ gitBin: '/nonexistent/definitely-not-git' });

    writeFileSync(join(work, 'a.txt'), 'data');
    engine.beginTurn({ turnId: 't', sessionId: 's' });
    expect(await engine.ensureCheckpoint(work)).toBeNull();
    expect(await engine.list()).toEqual([]);
    expect(await engine.status()).toEqual({ available: false, reason: 'checkpoints unavailable: git not found' });
    await expect(engine.restore(work, 'abcdef0')).rejects.toThrow('checkpoints unavailable: git not found');
  });

  test('a vanished workdir fails the operation without flipping into git-not-found mode', async () => {
    const { work, engine } = setup();

    writeFileSync(join(work, 'a.txt'), 'x');
    engine.beginTurn({ turnId: 't', sessionId: 's' });
    const id = present(await engine.ensureCheckpoint(work), 'the turn checkpoint id');

    rmSync(work, { recursive: true, force: true });
    await expect(engine.plan(work, id)).rejects.toThrow('checkpoint staging failed: working directory not found: ');
    expect(await engine.status()).toEqual({ available: true });
  });

  test('a path it may not read is skipped and named in the record, not a failed checkpoint', async () => {
    // An unreadable directory (e.g. `systemd-private-…`) is not a failed checkpoint and must not refuse the agent's write.
    const { work, engine } = setup();
    const foreign = join(work, 'systemd-private-9f2c');

    try {
      writeFileSync(join(work, 'a.txt'), 'mine');
      // Sorts after the unreadable entries, so a pass that aborts on the first refusal drops it.
      writeFileSync(join(work, 'zz.txt'), 'also mine');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'inside.txt'), 'not mine');
      writeFileSync(join(work, 'locked.txt'), 'not mine either');
      chmodSync(join(work, 'locked.txt'), 0o000);
      chmodSync(foreign, 0o000);

      engine.beginTurn({ turnId: 't', sessionId: 's' });
      const id = present(await engine.ensureCheckpoint(work, 'file write'), 'the turn checkpoint id');

      expect(id).toBeTruthy();

      const [entry] = await engine.list();
      expect(entry.reason).toBe('file write [skipped 2 unreadable: locked.txt systemd-private-9f2c]');

      writeFileSync(join(work, 'a.txt'), 'clobbered');
      rmSync(join(work, 'zz.txt'));
      await engine.restore(work, id);
      expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('mine');
      expect(readFileSync(join(work, 'zz.txt'), 'utf8')).toBe('also mine');

      // Unreadable paths are outside the restore's business, never deleted.
      expect(existsSync(join(work, 'locked.txt'))).toBe(true);
      expect(existsSync(foreign)).toBe(true);
    } finally {
      chmodSync(foreign, 0o700);

    }
  });

  test('the shared temp root is not a work tree, so it is never snapshotted', async () => {
    // `workdirForPath('/tmp/scratch.js')` answers `/tmp`; tolerating unreadable entries would then copy the box's scratch into the store.
    const { engine } = setup();

    expect(engine.workdirForPath(join(tmpdir(), 'scratch.js'))).toBe(tmpdir());

    engine.beginTurn({ turnId: 't', sessionId: 's' });
    expect(await engine.ensureCheckpoint(tmpdir(), 'file write')).toBeNull();
    expect(await engine.ensureCheckpoint('/var/tmp', 'file write')).toBeNull();
    expect(await engine.list()).toEqual([]);
  });

  test('workdirForPath resolves the nearest project marker dir', async () => {
    const { work, engine } = setup();

    mkdirSync(join(work, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(work, 'package.json'), '{}');
    writeFileSync(join(work, 'nested', 'deep', 'file.txt'), 'x');
    expect(engine.workdirForPath(join(work, 'nested', 'deep', 'file.txt'))).toBe(work);
    expect(engine.workdirForPath(join(work, 'nested', 'deep'))).toBe(work);
  });
});

describe('checkpointed runtime shell', () => {
  test('any shell exec snapshots the cwd before running (first mutation per turn)', async () => {
    const { root, work } = setup();
    const db = new Database(join(root, 'agent.db'), { create: true });

    try {
      writeFileSync(join(work, 'precious.txt'), 'original');

      // Checkpoint storage is global per agent name; a stable name would read stores from prior runs.
      const rt = createCLIRuntime(db, {
        dbPath: db.filename,
        cwd: work,
        agentName: `ckpt-shell-test-${String(Date.now())}-${String(process.pid)}`,
        llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
      });

      // The default 'strict' asks a channel this runtime lacks.
      rt.actor.config.setShellApprovalMode('allow_all');
      const shell = rt.shell;

      if (!shell) throw new Error('a bound runtime must have a shell');
      const checkpoints = rt.checkpoints;

      if (!checkpoints) throw new Error('a bound runtime must have a checkpoint engine');

      checkpoints.beginTurn({ turnId: 'shell-turn', sessionId: 's' });
      const result = await shell.exec('echo CLOBBERED > precious.txt');
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(work, 'precious.txt'), 'utf8').trim()).toBe('CLOBBERED');

      const [entry] = await checkpoints.list();
      expect(entry.turnId).toBe('shell-turn');
      await checkpoints.restore(work, entry.id);
      expect(readFileSync(join(work, 'precious.txt'), 'utf8')).toBe('original');
    } finally {
      db.close();

    }
  });
});
