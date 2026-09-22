/**
 * Host shadow-git implementation of core's FileCheckpoints seam. Store format lives in
 * @kinu.run/core/checkpoints/format, shared with the pc-agent daemon (tests/checkpoint-parity.test.ts).
 * Snapshots are parentless commits; the user's own `.git/` and git config are never touched.
 */

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
  checkpointReason, diagnoseStaging,
  type CheckpointAvailability, type CheckpointTurnMeta, type FileCheckpoints,
  type FileCheckpointEntry, type FileRestoreChange, type FileRestoreKind,
  type FileRestorePlan, type FileRestoreResult,
} from '@kinu.run/core';
import { classify, tolerate, tolerateAsync } from '@kinu.run/core/obs';

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

interface GitResult { code: number; stdout: string; stderr: string }

interface GitEnvironment { [name: string]: string }

/** One staged tree, plus the paths omitted because this process may not read them. */
interface StagedTree { tree: string; unreadable: string[] }

/** A `diff-tree --name-status` letter in restore direction (current→checkpoint). */
function restoreKindOf(status: string): FileRestoreKind {
  if (status === 'A') return 'create';

  if (status === 'D') return 'delete';

  return 'modify';
}

/** A signal kill carries no numeric code and still counts as failure (1). */
function gitExitCode(err: ExecFileException | null): number {
  if (err === null) return 0;
  const reported = Number(err.code);

  return Number.isFinite(reported) ? reported : 1;
}

export function createHostCheckpoints(opts: HostCheckpointsOpts): FileCheckpoints {
  const agent = opts.agent.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = opts.base ?? join(kinuHome(), 'checkpoints');
  const agentBase = join(base, agent);
  const keep = Math.max(1, opts.keep ?? DEFAULT_CHECKPOINT_KEEP);
  const gitBin = opts.gitBin ?? 'git';

  let gitAvailable: boolean | null = null;
  let turn: CheckpointTurnMeta | null = null;
  const turnDone = new Set<string>();
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
    // Pinned locale: `diagnoseStaging` parses git's diagnostics as English strings.
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

  async function probeGit(): Promise<boolean> {
    if (gitAvailable !== null) return gitAvailable;

    try {
      await runGit(['--version'], homedir(), isolatedEnv());
    } catch (error) {
      // A rejection that did not set `gitAvailable` is not a missing git.
      if (gitAvailable !== false) throw error;
    }

    gitAvailable ??= true;

    return gitAvailable;
  }

  function dirHash(dir: string): string {
    return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 16);
  }

  function storeDirFor(dir: string): string {
    return join(agentBase, dirHash(dir));
  }

  async function initStore(gitDir: string, workdir: string): Promise<void> {
    if (existsSync(join(gitDir, 'HEAD'))) return;
    await fs.mkdir(gitDir, { recursive: true });
    const init = await runGit(['init', '--bare', '--quiet', gitDir], dirname(gitDir), isolatedEnv());

    if (init.code !== 0) throw new Error(`checkpoint store init failed: ${init.stderr.trim()}`);
    await fs.mkdir(join(gitDir, 'info'), { recursive: true });
    await fs.writeFile(join(gitDir, 'info', 'exclude'), CHECKPOINT_EXCLUDES.join('\n') + '\n', 'utf8');
    await fs.writeFile(join(gitDir, WORKDIR_MARKER), resolve(workdir) + '\n', 'utf8');
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
   * snapshot; the skipped paths are returned for `diagnoseStaging`.
   */
  async function stageCurrent(gitDir: string, workdir: string): Promise<StagedTree> {
    const env = storeEnv(gitDir, workdir);
    const add = await runGit(['add', '-A', '--ignore-errors'], workdir, env);
    const diagnosis = diagnoseStaging(add.stderr);

    // A non-zero exit explained entirely by unreadable paths is success; anything unexplained throws.
    if (diagnosis.unexplained.length > 0 || (add.code !== 0 && diagnosis.unreadable.length === 0)) {
      throw new Error(`checkpoint staging failed: ${add.stderr.trim()}`);
    }

    const tree = await runGit(['write-tree'], workdir, env);

    if (tree.code !== 0) throw new Error(`checkpoint write-tree failed: ${tree.stderr.trim()}`);

    return { tree: tree.stdout.trim(), unreadable: diagnosis.unreadable };
  }

  /** Snapshot dir with turn meta (null for out-of-turn snapshots, as the daemon does). Returns the
   *  new id, or the newest existing id when nothing changed. */
  async function snapshot(dir: string, meta: CheckpointTurnMeta | null, reason: string): Promise<string | null> {
    if (snapshotSkipped(dir)) return null;
    const abs = resolve(dir);
    const gitDir = storeDirFor(abs);
    await initStore(gitDir, abs);
    const env = storeEnv(gitDir, abs);
    const staged = await stageCurrent(gitDir, abs);
    const tree = staged.tree;

    const refs = await storeRefs(gitDir, abs);
    const latest = refs[0];

    if (latest) {
      const latestTree = await runGit(['rev-parse', `${latest.id}^{tree}`], abs, env);

      if (latestTree.code === 0 && latestTree.stdout.trim() === tree) return latest.id;
    }

    const subject = checkpointSubject(meta, checkpointReason(reason, staged.unreadable));
    const commit = await runGit(['commit-tree', tree, '-m', subject], abs, env);

    if (commit.code !== 0) throw new Error(`checkpoint commit failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    const refName = `${REF_PREFIX}/${String(Date.now()).padStart(13, '0')}-${(refSeq++).toString(36).padStart(3, '0')}`;
    const update = await runGit(['update-ref', refName, sha], abs, env);

    if (update.code !== 0) throw new Error(`checkpoint ref update failed: ${update.stderr.trim()}`);

    await pruneStore(gitDir, abs, refs.length + 1);

    return sha;
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

  async function requireCheckpoint(dir: string, id: string): Promise<{ gitDir: string; abs: string; env: GitEnvironment }> {
    if (!SHA_RE.test(id)) throw new Error(`invalid checkpoint id: ${id}`);
    const abs = resolve(dir);
    const gitDir = storeDirFor(abs);

    if (!existsSync(join(gitDir, 'HEAD'))) throw new Error(`no checkpoints exist for ${abs}`);
    const env = storeEnv(gitDir, abs);
    const verify = await runGit(['rev-parse', '--verify', `${id}^{commit}`], workdirOrBase(abs), env);

    if (verify.code !== 0) throw new Error(`checkpoint not found: ${id}`);

    return { gitDir, abs, env };
  }

  async function diffToCheckpoint(gitDir: string, abs: string, id: string): Promise<FileRestoreChange[]> {
    const env = storeEnv(gitDir, abs);
    const current = await stageCurrent(gitDir, abs);
    const diff = await runGit(['diff-tree', '-r', '--name-status', current.tree, `${id}^{tree}`], abs, env);

    if (diff.code !== 0) throw new Error(`checkpoint diff failed: ${diff.stderr.trim()}`);
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
  }

  return {
    beginTurn(meta: CheckpointTurnMeta): void {
      turn = meta;
      turnDone.clear();
    },

    async ensureCheckpoint(dir: string, reason = 'pre-mutation'): Promise<string | null> {
      if (!(await probeGit())) return null;
      const abs = resolve(dir);

      if (turnDone.has(abs)) return null;
      turnDone.add(abs);

      return await snapshot(abs, turn, reason);
    },

    async list(query: { limit?: number; turnId?: string } = {}): Promise<FileCheckpointEntry[]> {
      if (!(await probeGit())) return [];
      const stores = await tolerateAsync(() => fs.readdir(agentBase), 'enoent') ?? [];
      const entries: FileCheckpointEntry[] = [];

      for (const name of stores) {
        const gitDir = join(agentBase, name);
        const markerPath = join(gitDir, WORKDIR_MARKER);

        if (!existsSync(join(gitDir, 'HEAD')) || !existsSync(markerPath)) continue;
        const workdir = (await fs.readFile(markerPath, 'utf8')).trim();

        for (const ref of await storeRefs(gitDir, workdir)) {
          const meta = parseCheckpointSubject(ref.subject);

          if (query.turnId !== undefined && meta.turnId !== query.turnId) continue;
          entries.push({ id: ref.id, dir: workdir, at: checkpointRefTimestampMs(ref.ref), ...meta });
        }
      }

      entries.sort((a, b) => b.at - a.at);

      // Truncate last, after any turn filter, so a limit never hides a matching checkpoint.
      return entries.slice(0, Math.max(1, query.limit ?? 50));
    },

    async plan(dir: string, id: string): Promise<FileRestorePlan> {
      if (!(await probeGit())) throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      const { gitDir, abs } = await requireCheckpoint(dir, id);
      const files = await diffToCheckpoint(gitDir, abs, id);

      return { dir: abs, id, files };
    },

    async restore(dir: string, id: string): Promise<FileRestoreResult> {
      if (!(await probeGit())) throw new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT);
      const { gitDir, abs, env } = await requireCheckpoint(dir, id);

      if (!existsSync(abs)) throw new Error(`working directory no longer exists: ${abs}`);
      const files = await diffToCheckpoint(gitDir, abs, id);

      // Safety snapshot so the restore is undoable; null turn meta keeps it out of the armed turn's /undo group.
      const preRestoreId = await snapshot(abs, null, 'pre-restore');

      for (const change of files) {
        if (change.kind !== 'delete') continue;
        const target = resolve(abs, change.path);

        if (!target.startsWith(abs)) continue; // defense: git emits relative paths only
        await tolerateAsync(() => fs.unlink(target), 'enoent');
      }

      const read = await runGit(['read-tree', id], abs, env);

      if (read.code !== 0) throw new Error(`checkpoint read-tree failed: ${read.stderr.trim()}`);
      const checkout = await runGit(['checkout-index', '-a', '-f'], abs, env);

      if (checkout.code !== 0) throw new Error(`checkpoint restore failed: ${checkout.stderr.trim()}`);

      return { dir: abs, id, files, preRestoreId };
    },

    async status(): Promise<CheckpointAvailability> {
      return (await probeGit())
        ? { available: true }
        : { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT };
    },

    workdirForPath(path: string): string {
      const abs = resolve(path);
      let candidate = abs;

      try {
        if (!statSync(abs).isDirectory()) candidate = dirname(abs);
      } catch (error) {
        if (classify({ cause: error }) !== 'enoent') throw error;
        candidate = dirname(abs);
      }

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
    },
  };
}
