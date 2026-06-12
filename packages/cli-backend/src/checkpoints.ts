/**
 * Host shadow-git checkpoint engine — the cli-backend implementation of the
 * core FileCheckpoints seam (Hermes checkpoint_manager pattern, see
 * external/hermes-agent/tools/checkpoint_manager.py).
 *
 * Store format (constants + subject/ref encoding) lives in
 * @proteus/core/checkpoints/format — the pc-agent daemon writes the same
 * layout (zero-dep mirror, enforced by tests/checkpoint-parity.test.ts) so a
 * machine's checkpoints are one format regardless of which side wrote them.
 *
 * Every snapshot is a parentless commit (content-addressed: unchanged blobs
 * and trees are shared across snapshots). GIT_WORK_TREE points at the target
 * directory and the user's own `.git/` is excluded, so the user's repo is
 * never touched. All git config is isolated (no gpg prompts, no hooks).
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs, existsSync, statSync } from 'node:fs';
import { homedir, devNull } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT,
  CHECKPOINT_REF_PREFIX as REF_PREFIX, CHECKPOINT_WORKDIR_MARKER as WORKDIR_MARKER,
  CHECKPOINT_EXCLUDES, checkpointSubject, parseCheckpointSubject, checkpointRefTimestampMs,
  type CheckpointAvailability, type CheckpointTurnMeta, type FileCheckpoints,
  type FileCheckpointEntry, type FileRestoreChange, type FileRestorePlan, type FileRestoreResult,
} from '@proteus/core';

const SHA_RE = /^[0-9a-f]{4,64}$/i;
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', '.hg'];
const GIT_TIMEOUT_MS = 30_000;

export interface HostCheckpointsOpts {
  agent: string;
  /** Shadow store root. Default: ~/.proteus/checkpoints */
  base?: string;
  /** Checkpoints kept per working directory. Default: DEFAULT_CHECKPOINT_KEEP. */
  keep?: number;
  /** git binary. Default 'git' — tests point this at a missing path to
   *  exercise the honest degraded mode. */
  gitBin?: string;
}

interface GitResult { code: number; stdout: string; stderr: string }

export function createHostCheckpoints(opts: HostCheckpointsOpts): FileCheckpoints {
  const agent = opts.agent.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = opts.base ?? join(homedir(), '.proteus', 'checkpoints');
  const agentBase = join(base, agent);
  const keep = Math.max(1, opts.keep ?? DEFAULT_CHECKPOINT_KEEP);
  const gitBin = opts.gitBin ?? 'git';

  let gitAvailable: boolean | null = null;
  let turn: CheckpointTurnMeta | null = null;
  const turnDone = new Set<string>();
  let refSeq = 0;

  function isolatedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
    }
    env.GIT_CONFIG_GLOBAL = devNull;
    env.GIT_CONFIG_SYSTEM = devNull;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_AUTHOR_NAME = 'Proteus Checkpoint';
    env.GIT_AUTHOR_EMAIL = 'checkpoints@proteus.local';
    env.GIT_COMMITTER_NAME = 'Proteus Checkpoint';
    env.GIT_COMMITTER_EMAIL = 'checkpoints@proteus.local';
    return env;
  }

  function storeEnv(gitDir: string, workdir: string): Record<string, string> {
    return { ...isolatedEnv(), GIT_DIR: gitDir, GIT_WORK_TREE: workdir };
  }

  function runGit(args: string[], cwd: string, env: Record<string, string>): Promise<GitResult> {
    // A missing cwd makes spawn fail with the same ENOENT a missing binary
    // produces — check it here so a vanished workdir can never flip the
    // engine into the sticky "git not found" degraded mode.
    if (!existsSync(cwd)) {
      return Promise.resolve({ code: 1, stdout: '', stderr: `working directory not found: ${cwd}` });
    }
    return new Promise((resolveRun, rejectRun) => {
      execFile(gitBin, args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          gitAvailable = false;
          rejectRun(new Error(CHECKPOINTS_UNAVAILABLE_NO_GIT));
          return;
        }
        gitAvailable = true;
        const code = err ? ((err as { code?: unknown }).code as number | undefined ?? 1) : 0;
        resolveRun({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  async function probeGit(): Promise<boolean> {
    if (gitAvailable !== null) return gitAvailable;
    try {
      await runGit(['--version'], homedir(), isolatedEnv());
    } catch { /* runGit set gitAvailable=false */ }
    gitAvailable = gitAvailable ?? true;
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
    return abs === '/' || abs === resolve(homedir()) || !existsSync(abs) || !statSync(abs).isDirectory();
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
      return { ref: ref!, id: id!, subject: rest.join('|') };
    });
  }

  /** git refuses to run with a missing worktree — fall back to the store base
   *  for read-only ref operations when the workdir vanished. */
  function workdirOrBase(workdir: string): string {
    return existsSync(workdir) ? workdir : base;
  }

  /** Stage the working tree and write it as a tree object. */
  async function stageCurrent(gitDir: string, workdir: string): Promise<string> {
    const env = storeEnv(gitDir, workdir);
    const add = await runGit(['add', '-A'], workdir, env);
    if (add.code !== 0) throw new Error(`checkpoint staging failed: ${add.stderr.trim()}`);
    const tree = await runGit(['write-tree'], workdir, env);
    if (tree.code !== 0) throw new Error(`checkpoint write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  }

  /** Take a snapshot of dir tagged with the given turn meta (null for
   *  out-of-turn snapshots like pre-restore, matching the daemon mirror).
   *  Returns the checkpoint id, or the newest existing id when nothing
   *  changed since it. */
  async function snapshot(dir: string, meta: CheckpointTurnMeta | null, reason: string): Promise<string | null> {
    if (snapshotSkipped(dir)) return null;
    const abs = resolve(dir);
    const gitDir = storeDirFor(abs);
    await initStore(gitDir, abs);
    const env = storeEnv(gitDir, abs);
    const tree = await stageCurrent(gitDir, abs);

    const refs = await storeRefs(gitDir, abs);
    const latest = refs[0];
    if (latest) {
      const latestTree = await runGit(['rev-parse', `${latest.id}^{tree}`], abs, env);
      if (latestTree.code === 0 && latestTree.stdout.trim() === tree) return latest.id;
    }

    const commit = await runGit(['commit-tree', tree, '-m', checkpointSubject(meta, reason)], abs, env);
    if (commit.code !== 0) throw new Error(`checkpoint commit failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    const refName = `${REF_PREFIX}/${String(Date.now()).padStart(13, '0')}-${(refSeq++).toString(36).padStart(3, '0')}`;
    const update = await runGit(['update-ref', refName, sha], abs, env);
    if (update.code !== 0) throw new Error(`checkpoint ref update failed: ${update.stderr.trim()}`);

    await pruneStore(gitDir, abs, refs.length + 1);
    return sha;
  }

  /** Bounded retention: drop the oldest refs beyond `keep`, then reclaim the
   *  now-unreachable objects. */
  async function pruneStore(gitDir: string, workdir: string, refCount: number): Promise<void> {
    if (refCount <= keep) return;
    const env = storeEnv(gitDir, workdir);
    const refs = await storeRefs(gitDir, workdir);
    for (const stale of refs.slice(keep)) {
      await runGit(['update-ref', '-d', stale.ref], workdir, env);
    }
    await runGit(['prune', '--expire=now'], workdir, env);
  }

  async function requireCheckpoint(dir: string, id: string): Promise<{ gitDir: string; abs: string; env: Record<string, string> }> {
    if (!SHA_RE.test(id)) throw new Error(`invalid checkpoint id: ${id}`);
    const abs = resolve(dir);
    const gitDir = storeDirFor(abs);
    if (!existsSync(join(gitDir, 'HEAD'))) throw new Error(`no checkpoints exist for ${abs}`);
    const env = storeEnv(gitDir, abs);
    const verify = await runGit(['rev-parse', '--verify', `${id}^{commit}`], workdirOrBase(abs), env);
    if (verify.code !== 0) throw new Error(`checkpoint not found: ${id}`);
    return { gitDir, abs, env };
  }

  /** diff current staged state → checkpoint tree, as restore-direction changes. */
  async function diffToCheckpoint(gitDir: string, abs: string, id: string): Promise<FileRestoreChange[]> {
    const env = storeEnv(gitDir, abs);
    const currentTree = await stageCurrent(gitDir, abs);
    const diff = await runGit(['diff-tree', '-r', '--name-status', currentTree, `${id}^{tree}`], abs, env);
    if (diff.code !== 0) throw new Error(`checkpoint diff failed: ${diff.stderr.trim()}`);
    const files: FileRestoreChange[] = [];
    for (const line of diff.stdout.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const status = line.slice(0, tab);
      const path = line.slice(tab + 1);
      // Direction current→checkpoint: A = restore re-creates it, D = restore
      // deletes it (added since), M/T = restore rewrites it.
      files.push({ path, kind: status === 'A' ? 'create' : status === 'D' ? 'delete' : 'modify' });
    }
    return files;
  }

  return {
    beginTurn(meta: CheckpointTurnMeta): void {
      turn = meta;
      turnDone.clear();
    },

    async ensureCheckpoint(dir: string, reason = 'pre-mutation'): Promise<string | null> {
      try {
        if (!(await probeGit())) return null;
        const abs = resolve(dir);
        if (turnDone.has(abs)) return null;
        turnDone.add(abs);
        return await snapshot(abs, turn, reason);
      } catch {
        // Snapshot failures must never block the mutation they precede.
        return null;
      }
    },

    async list(limit = 50): Promise<FileCheckpointEntry[]> {
      if (!(await probeGit())) return [];
      let stores: string[];
      try { stores = await fs.readdir(agentBase); } catch { return []; }
      const entries: FileCheckpointEntry[] = [];
      for (const name of stores) {
        const gitDir = join(agentBase, name);
        const markerPath = join(gitDir, WORKDIR_MARKER);
        if (!existsSync(join(gitDir, 'HEAD')) || !existsSync(markerPath)) continue;
        const workdir = (await fs.readFile(markerPath, 'utf8')).trim();
        for (const ref of await storeRefs(gitDir, workdir)) {
          const meta = parseCheckpointSubject(ref.subject);
          entries.push({ id: ref.id, dir: workdir, at: checkpointRefTimestampMs(ref.ref), ...meta });
        }
      }
      entries.sort((a, b) => b.at - a.at);
      return entries.slice(0, Math.max(1, limit));
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

      // Safety snapshot first, so the restore itself is undoable. Turn meta
      // is explicitly null: stamping the armed chat turn would merge this
      // snapshot into that turn's /undo group and break "/undo 1 undoes the
      // restore" (the daemon mirror passes null for the same reason).
      const preRestoreId = await snapshot(abs, null, 'pre-restore');

      // Remove files created since the checkpoint, then materialize the
      // checkpoint tree (content + recreated deletions) from the store index.
      for (const change of files) {
        if (change.kind !== 'delete') continue;
        const target = resolve(abs, change.path);
        if (!target.startsWith(abs)) continue; // defense: git emits relative paths only
        try { await fs.unlink(target); } catch { /* already gone */ }
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
      } catch {
        candidate = dirname(abs);
      }
      const home = resolve(homedir());
      let probe = candidate;
      while (probe !== dirname(probe) && probe !== home) {
        if (PROJECT_MARKERS.some((marker) => existsSync(join(probe, marker)))) return probe;
        probe = dirname(probe);
      }
      return candidate;
    },
  };
}
