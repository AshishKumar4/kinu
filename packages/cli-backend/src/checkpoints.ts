/**
 * Host shadow-git implementation of core's FileCheckpoints seam. Store format lives in
 * @kinu.run/core/checkpoints/format, shared with the pc-agent daemon (tests/checkpoint-parity.test.ts).
 * Snapshots are parentless commits; the user's own `.git/` and git config are never touched.
 */

import { Cause, Effect } from 'effect';
import { createHash } from 'node:crypto';
import { execFile, type ExecFileException } from 'node:child_process';
import { promises as fs, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, devNull, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { kinuHome } from './home';
import {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT,
  CHECKPOINT_REF_PREFIX as REF_PREFIX, CHECKPOINT_WORKDIR_MARKER as WORKDIR_MARKER,
  CHECKPOINT_EXCLUDES, checkpointSubject, parseCheckpointSubject, checkpointRefTimestampMs,
  checkpointReason, stagingOutcome,
  type CheckpointAvailability, type CheckpointTurnMeta, type FileCheckpoints,
  type FileCheckpointEntry, type FileRestoreChange, type FileRestoreKind,
  type FileRestorePlan, type FileRestoreResult,
} from '@kinu.run/core';
import { classify, tolerate, tolerateAsync, settle, settleSync } from '@kinu.run/core/obs';

const SHA_RE = /^[0-9a-f]{4,64}$/i;

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', '.hg'];

/**
 * Not work trees. Shared temp roots are here because `workdirForPath` resolves a bare `/tmp/x.js`
 * to `/tmp`, which holds every process's files.
 */
const UNSNAPSHOTTABLE = new Set([tmpdir(), '/tmp', '/var/tmp'].map((dir) => resolve(dir)));

export interface HostCheckpointsOpts {
  agent: string;
  /** Shadow store root. Default: $KINU_HOME/checkpoints */
  base?: string;
  /** Checkpoints kept per working directory. Default: DEFAULT_CHECKPOINT_KEEP. */
  keep?: number;
  /** git binary. Default 'git'. */
  gitBin?: string;
}

/** `code` is null when git never finished (a signal, an overfull buffer), whatever it printed. */
interface GitResult { code: number | null; stdout: string; stderr: string }

interface GitEnvironment { [name: string]: string }

/** One staged tree, plus the paths omitted because this process may not read them. */
interface StagedTree { tree: string; unreadable: string[] }

/** A `diff-tree --name-status` letter in restore direction (current→checkpoint). */
function restoreKindOf(status: string): FileRestoreKind {
  if (status === 'A') return 'create';

  if (status === 'D') return 'delete';

  return 'modify';
}

function gitExitCode(err: ExecFileException | null): number | null {
  if (err === null) return 0;

  return Number.isInteger(err.code) ? Number(err.code) : null;
}

export function createHostCheckpoints(opts: HostCheckpointsOpts): FileCheckpoints {
  const agent = opts.agent.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = opts.base ?? join(kinuHome(), 'checkpoints');
  const agentBase = join(base, agent);
  const keep = Math.max(1, opts.keep ?? DEFAULT_CHECKPOINT_KEEP);
  const gitBin = opts.gitBin ?? 'git';

  let gitAvailable: boolean | null = null;
  let turn: CheckpointTurnMeta | null = null;
  /** This turn's snapshot of each directory, in flight or taken: whether it was. A failed one is forgotten, so the next
   *  mutation takes it. */
  const turnSnapshots = new Map<string, Promise<boolean>>();
  let refSeq = 0;

  function isolatedEnv(): GitEnvironment {
    const env: GitEnvironment = {};

    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
    }

    env.GIT_CONFIG_GLOBAL = devNull;
    env.GIT_CONFIG_SYSTEM = devNull;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_AUTHOR_NAME = 'Kinu Checkpoint';
    env.GIT_AUTHOR_EMAIL = 'checkpoints@kinu.local';
    env.GIT_COMMITTER_NAME = 'Kinu Checkpoint';
    env.GIT_COMMITTER_EMAIL = 'checkpoints@kinu.local';
    // Pinned locale: `stagingOutcome` parses git's diagnostics as English strings.
    env.LC_ALL = 'C';

    return env;
  }

  function storeEnv(gitDir: string, workdir: string): GitEnvironment {
    return { ...isolatedEnv(), GIT_DIR: gitDir, GIT_WORK_TREE: workdir };
  }

  /** No wall clock on git; `maxBuffer` bounds this process's heap against runaway output. */
  function runGit(args: string[], cwd: string, env: GitEnvironment): Promise<GitResult> {
    // A missing cwd raises the same ENOENT as a missing binary; check it so a vanished workdir
    // cannot flip the engine into the sticky "git not found" mode.
    if (!existsSync(cwd)) {
      return Promise.resolve({ code: 1, stdout: '', stderr: `working directory not found: ${cwd}` });
    }

    return new Promise((resolveRun, rejectRun) => {
      execFile(gitBin, args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (classify({ cause: err }) === 'enoent') {
          gitAvailable = false;
          rejectRun(new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT));

          return;
        }

        gitAvailable = true;
        resolveRun({ code: gitExitCode(err), stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  function probeGit(): Effect.Effect<boolean> {
    return Effect.gen(function* () {
      if (gitAvailable !== null) return gitAvailable;

      yield* Effect.catchCause(Effect.gen(function* () {
        yield* Effect.promise(async () => runGit(['--version'], homedir(), isolatedEnv()));
      }), (failed) => Effect.gen(function* () {
        // A rejection that did not set `gitAvailable` is not a missing git.
        if (gitAvailable !== false) return yield* Effect.failCause(failed);
      }));

      gitAvailable ??= true;

      return gitAvailable;
    });
  }

  function dirHash(dir: string): string {
    return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 16);
  }

  function storeDirFor(dir: string): string {
    return join(agentBase, dirHash(dir));
  }

  function initStore(gitDir: string, workdir: string): Effect.Effect<void> {
    return Effect.gen(function* () {
      if (existsSync(join(gitDir, 'HEAD'))) return;
      yield* Effect.promise(async () => fs.mkdir(gitDir, { recursive: true }));
      const init = yield* Effect.promise(async () => runGit(['init', '--bare', '--quiet', gitDir], dirname(gitDir), isolatedEnv()));

      if (init.code !== 0) return yield* Effect.die(new Error(`checkpoint store init failed: ${init.stderr.trim()}`));
      yield* Effect.promise(async () => fs.mkdir(join(gitDir, 'info'), { recursive: true }));
      yield* Effect.promise(async () => fs.writeFile(join(gitDir, 'info', 'exclude'), CHECKPOINT_EXCLUDES.join('\n') + '\n', 'utf8'));
      yield* Effect.promise(async () => fs.writeFile(join(gitDir, WORKDIR_MARKER), resolve(workdir) + '\n', 'utf8'));
    });
  }

  function snapshotSkipped(dir: string): boolean {
    const abs = resolve(dir);

    return abs === '/' || abs === resolve(homedir()) || UNSNAPSHOTTABLE.has(abs)
      || !existsSync(abs) || !statSync(abs).isDirectory();
  }

  /** Refs newest-first for one store: [refName, sha, subject]. */
  async function storeRefs(gitDir: string, workdir: string): Promise<Array<{ ref: string; id: string; subject: string }>> {
    const res = await runGit(
      ['for-each-ref', '--sort=-refname', `--format=%(refname)|%(objectname)|%(subject)`, REF_PREFIX],
      workdirOrBase(workdir), storeEnv(gitDir, workdir),
    );

    if (res.code !== 0) return [];

    return res.stdout.split('\n').filter(Boolean).map((line) => {
      const [ref, id, ...rest] = line.split('|');

      return { ref, id, subject: rest.join('|') };
    });
  }

  /** git refuses a missing worktree; read-only ref ops fall back to the store base. */
  function workdirOrBase(workdir: string): string {
    return existsSync(workdir) ? workdir : base;
  }

  /**
   * `--ignore-errors` so an unreadable path costs only that path instead of silently truncating the
   * snapshot; the skipped paths are named in the reason.
   */
  function stageCurrent(gitDir: string, workdir: string): Effect.Effect<StagedTree> {
    return Effect.gen(function* () {
      const env = storeEnv(gitDir, workdir);
      const add = yield* Effect.promise(async () => runGit(['add', '-A', '--ignore-errors'], workdir, env));
      const staged = stagingOutcome(add.code, add.stderr);

      if ('failure' in staged) return yield* Effect.die(new Error(staged.failure));
      const tree = yield* Effect.promise(async () => runGit(['write-tree'], workdir, env));

      if (tree.code !== 0) return yield* Effect.die(new Error(`checkpoint write-tree failed: ${tree.stderr.trim()}`));

      return { tree: tree.stdout.trim(), unreadable: staged.unreadable };
    });
  }

  /** Snapshot dir with turn meta (null for out-of-turn snapshots, as the daemon does). Returns the
   *  new id, or the newest existing id when nothing changed. */
  function snapshot(dir: string, meta: CheckpointTurnMeta | null, reason: string): Effect.Effect<string | null> {
    return Effect.gen(function* () {
      if (snapshotSkipped(dir)) return null;
      const abs = resolve(dir);
      const gitDir = storeDirFor(abs);
      yield* initStore(gitDir, abs);
      const env = storeEnv(gitDir, abs);
      const staged = yield* stageCurrent(gitDir, abs);
      const tree = staged.tree;

      const refs = yield* Effect.promise(async () => storeRefs(gitDir, abs));
      const latest = refs[0];

      if (latest) {
        const latestTree = yield* Effect.promise(async () => runGit(['rev-parse', `${latest.id}^{tree}`], abs, env));

        if (latestTree.code === 0 && latestTree.stdout.trim() === tree) return latest.id;
      }

      const subject = checkpointSubject(meta, checkpointReason(reason, staged.unreadable));
      const commit = yield* Effect.promise(async () => runGit(['commit-tree', tree, '-m', subject], abs, env));

      if (commit.code !== 0) return yield* Effect.die(new Error(`checkpoint commit failed: ${commit.stderr.trim()}`));
      const sha = commit.stdout.trim();
      const refName = `${REF_PREFIX}/${String(Date.now()).padStart(13, '0')}-${(refSeq++).toString(36).padStart(3, '0')}`;
      const update = yield* Effect.promise(async () => runGit(['update-ref', refName, sha], abs, env));

      if (update.code !== 0) return yield* Effect.die(new Error(`checkpoint ref update failed: ${update.stderr.trim()}`));

      yield* Effect.promise(async () => pruneStore(gitDir, abs, refs.length + 1));

      return sha;
    });
  }

  /** Drop refs beyond `keep`, then reclaim unreachable objects. */
  async function pruneStore(gitDir: string, workdir: string, refCount: number): Promise<void> {
    if (refCount <= keep) return;
    const env = storeEnv(gitDir, workdir);
    const refs = await storeRefs(gitDir, workdir);

    for (const stale of refs.slice(keep)) {
      await runGit(['update-ref', '-d', stale.ref], workdir, env);
    }

    await runGit(['prune', '--expire=now'], workdir, env);
  }

  function requireCheckpoint(dir: string, id: string): Effect.Effect<{ gitDir: string; abs: string; env: GitEnvironment }> {
    return Effect.gen(function* () {
      if (!SHA_RE.test(id)) return yield* Effect.die(new Error(`invalid checkpoint id: ${id}`));
      const abs = resolve(dir);
      const gitDir = storeDirFor(abs);

      if (!existsSync(join(gitDir, 'HEAD'))) return yield* Effect.die(new Error(`no checkpoints exist for ${abs}`));
      const env = storeEnv(gitDir, abs);
      const verify = yield* Effect.promise(async () => runGit(['rev-parse', '--verify', `${id}^{commit}`], workdirOrBase(abs), env));

      if (verify.code !== 0) return yield* Effect.die(new Error(`checkpoint not found: ${id}`));

      return { gitDir, abs, env };
    });
  }

  function diffToCheckpoint(gitDir: string, abs: string, id: string): Effect.Effect<FileRestoreChange[]> {
    return Effect.gen(function* () {
      const env = storeEnv(gitDir, abs);
      const current = yield* stageCurrent(gitDir, abs);
      const diff = yield* Effect.promise(async () => runGit(['diff-tree', '-r', '--name-status', current.tree, `${id}^{tree}`], abs, env));

      if (diff.code !== 0) return yield* Effect.die(new Error(`checkpoint diff failed: ${diff.stderr.trim()}`));
      const files: FileRestoreChange[] = [];

      for (const line of diff.stdout.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');

        if (tab < 0) continue;
        const status = line.slice(0, tab);
        const path = line.slice(tab + 1);
        files.push({ path, kind: restoreKindOf(status) });
      }

      return files;
    });
  }

  return {
    beginTurn(meta: CheckpointTurnMeta): void {
      turn = meta;
      turnSnapshots.clear();
    },

    ensureCheckpoint(dir: string, reason = 'pre-mutation'): Promise<string | null> {
      return settle(Effect.gen(function* () {
        if (!(yield* probeGit())) return null;
        const abs = resolve(dir);

        // A mutation never runs ahead of the snapshot that precedes it; a failed one leaves this call to take it.
        for (let pending = turnSnapshots.get(abs); pending !== undefined; pending = turnSnapshots.get(abs)) {
          if (yield* Effect.promise(async () => pending)) return null;
        }

        const flight = Promise.withResolvers<boolean>();
        turnSnapshots.set(abs, flight.promise);

        return yield* snapshot(abs, turn, reason).pipe(
          Effect.tap(() => Effect.sync(() => { flight.resolve(true); })),
          Effect.onError(() => Effect.sync(() => {
            if (turnSnapshots.get(abs) === flight.promise) turnSnapshots.delete(abs);
            flight.resolve(false);
          })),
        );
      }));
    },

    list(query: { limit?: number; turnId?: string } = {}): Promise<FileCheckpointEntry[]> {
      return settle(Effect.gen(function* () {
        if (!(yield* probeGit())) return [];
        const stores = (yield* Effect.promise(async () => tolerateAsync(() => fs.readdir(agentBase), 'enoent'))) ?? [];
        const entries: FileCheckpointEntry[] = [];

        for (const name of stores) {
          const gitDir = join(agentBase, name);
          const markerPath = join(gitDir, WORKDIR_MARKER);

          if (!existsSync(join(gitDir, 'HEAD')) || !existsSync(markerPath)) continue;
          const workdir = (yield* Effect.promise(async () => fs.readFile(markerPath, 'utf8'))).trim();

          for (const ref of (yield* Effect.promise(async () => storeRefs(gitDir, workdir)))) {
            const meta = parseCheckpointSubject(ref.subject);

            if (query.turnId !== undefined && meta.turnId !== query.turnId) continue;
            entries.push({ id: ref.id, dir: workdir, at: checkpointRefTimestampMs(ref.ref), ...meta });
          }
        }

        entries.sort((a, b) => b.at - a.at);

        // Truncate last, after any turn filter, so a limit never hides a matching checkpoint.
        return entries.slice(0, Math.max(1, query.limit ?? 50));
      }));
    },

    plan(dir: string, id: string): Promise<FileRestorePlan> {
      return settle(Effect.gen(function* () {
        if (!(yield* probeGit())) return yield* Effect.die(new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT));
        const { gitDir, abs } = yield* requireCheckpoint(dir, id);
        const files = yield* diffToCheckpoint(gitDir, abs, id);

        return { dir: abs, id, files };
      }));
    },

    restore(dir: string, id: string): Promise<FileRestoreResult> {
      return settle(Effect.gen(function* () {
        if (!(yield* probeGit())) return yield* Effect.die(new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT));
        const { gitDir, abs, env } = yield* requireCheckpoint(dir, id);

        if (!existsSync(abs)) return yield* Effect.die(new Error(`working directory no longer exists: ${abs}`));
        const files = yield* diffToCheckpoint(gitDir, abs, id);

        // Safety snapshot so the restore is undoable; null turn meta keeps it out of the armed turn's /undo group.
        const preRestoreId = yield* snapshot(abs, null, 'pre-restore');

        for (const change of files) {
          if (change.kind !== 'delete') continue;
          const target = resolve(abs, change.path);

          if (!target.startsWith(abs)) continue; // defense: git emits relative paths only
          yield* Effect.promise(async () => tolerateAsync(() => fs.unlink(target), 'enoent'));
        }

        const read = yield* Effect.promise(async () => runGit(['read-tree', id], abs, env));

        if (read.code !== 0) return yield* Effect.die(new Error(`checkpoint read-tree failed: ${read.stderr.trim()}`));
        const checkout = yield* Effect.promise(async () => runGit(['checkout-index', '-a', '-f'], abs, env));

        if (checkout.code !== 0) return yield* Effect.die(new Error(`checkpoint restore failed: ${checkout.stderr.trim()}`));

        return { dir: abs, id, files, preRestoreId };
      }));
    },

    status(): Promise<CheckpointAvailability> {
      return settle(Effect.gen(function* () {
        return (yield* probeGit())
          ? { available: true }
          : { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT };
      }));
    },

    workdirForPath(path: string): string {
      return settleSync(Effect.gen(function* () {
        const abs = resolve(path);
        let candidate = abs;

        yield* Effect.catchCause(Effect.sync(() => {
          if (!statSync(abs).isDirectory()) candidate = dirname(abs);
        }), (failed) => Effect.gen(function* () {
          const error = Cause.squash(failed);

          if (classify({ cause: error }) !== 'enoent') return yield* Effect.failCause(failed);
          candidate = dirname(abs);
        }));

        const home = resolve(homedir());
        // Stop at the temp directory (both resolved and real path): a marker there claimed every host write
        // beneath it, 24,483 ms for one `device.writeFile`, measured 2026-09-02 (scripts/preflight.ts refuses it).
        const temp = resolve(tmpdir());
        const realTemp = tolerate(() => realpathSync(temp), 'enoent') ?? temp;
        let probe = candidate;

        while (probe !== dirname(probe) && probe !== home) {
          const real = tolerate(() => realpathSync(probe), 'enoent') ?? probe;

          if (probe === temp || real === realTemp) break;

          if (PROJECT_MARKERS.some((marker) => existsSync(join(probe, marker)))) return probe;
          probe = dirname(probe);
        }

        return candidate;
      }));
    },
  };
}
