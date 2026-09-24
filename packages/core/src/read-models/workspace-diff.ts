/**
 * Change-set read model per executor: read-only git diff where a repo exists, else a snapshot
 * baseline manifest (`vfs_baseline_manifest`, bodies by hash in `vfs_baseline_blob`). Reads never mutate the
 * baseline; "mark reviewed" re-baselines.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, VfsEntryStat } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus } from '../vfs/diff';
import { nanoid } from '../utils/nanoid';
import * as v from 'valibot';
import { CommandResultSchema } from '../execution/exec-result';
import { KinuError, renderThrownChain } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import { isSystemManaged } from '../vfs/workspace-path';

/** `do.sqlite.row_bytes` caps a body's row, which also holds its 64-hex key. */
const BODY_MAX_BYTES = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value - 64;

/** Quarter of the facet RPC ceiling: the reply is UTF-16 in the isolate plus per-line overhead.
 *  Files past it are listed with +/- counts and no body. */
const MAX_CHANGESET_BODY_CHARS = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  '.git', '.cache', '.mypy_cache', '.pnpm-store', '.pytest_cache', '.venv', '__pycache__', 'node_modules', 'venv',
]);

const NOT_GIT_REPO = '__KINU_NOT_GIT_REPO__';

/** A body is stored once per hash; `hash` is null for a file past one row. */
export function initWorkspaceBaselineTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline_manifest (
    actor_id   TEXT NOT NULL,
    generation TEXT NOT NULL,
    path       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtime_ms   INTEGER NOT NULL,
    hash       TEXT,
    active     INTEGER NOT NULL CHECK (active IN (0, 1)),
    PRIMARY KEY (actor_id, generation, path)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_vfs_baseline_manifest_active
    ON vfs_baseline_manifest(actor_id, active)`);
  execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline_blob (
    hash    TEXT PRIMARY KEY,
    content TEXT NOT NULL
  )`);
}

export interface WorkspaceDiffResult {
  files: FileDiff[];
  /** When the baseline these changes are measured against was captured. */
  trackedSince: number;
}

export interface ExecutorDiffResult {
  files: FileDiff[];
  mode: 'git' | 'vfs-baseline';
  trackedSince?: number;
  notGitRepo?: boolean;
  error?: string;
}

/** The baseline read model reads the workspace's files and its own tables, as the actor it serves. */
type WorkspaceBaselineRuntime = Pick<AgentRuntime, 'storage' | 'actor'>;

interface ManifestEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string | null;
}

/** Every regular file the change-set reviews, breadth-first so root files come first, by stat alone. */
async function walkWorkspaceFiles(
  rt: WorkspaceBaselineRuntime,
  visit: (path: string, stat: VfsEntryStat) => void | Promise<void>,
): Promise<void> {
  const directories = [''];

  for (let next = 0; next < directories.length; next++) {
    const dir = directories[next];
    const children: string[] = [];
    let names: string[];

    try {
      names = (await rt.storage.vfs.readdir(dir)).sort();
    } catch (error) {
      throw new Error(`Workspace snapshot could not read directory ${JSON.stringify(dir || '.')}`, { cause: error });
    }

    for (const name of names) {
      if (isSystemManaged(name) || SNAPSHOT_IGNORED_DIRECTORIES.has(name)) continue;
      const full = dir === '' ? name : `${dir}/${name}`;
      let st: VfsEntryStat | null;

      try {
        st = await rt.storage.vfs.stat(full);
      } catch (error) {
        throw new Error(`Workspace snapshot could not stat ${JSON.stringify(full)}`, { cause: error });
      }

      if (!st) throw new Error(`Workspace changed while snapshotting ${JSON.stringify(full)}`);

      if (st.isDir) {
        children.push(full);
        continue;
      }

      await visit(full, st);
    }

    directories.push(...children);
  }
}

/** The body a line diff shows, or null for a binary (NUL-bearing) file. */
async function reviewableText(rt: WorkspaceBaselineRuntime, path: string): Promise<string | null> {
  let content: string | Uint8Array;

  try {
    content = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Workspace snapshot could not read ${JSON.stringify(path)}`, { cause: error });
  }

  const text = content instanceof Uint8Array ? new TextDecoder().decode(content) : content;

  return text.includes(String.fromCharCode(0)) ? null : text;
}

/** The '' marker row carries the capture time; null means this actor has no baseline yet. */
interface BaselineManifest {
  readonly capturedAt: number | null;
  readonly entries: Map<string, ManifestEntry>;
}

/** Read in one query, so a diff never straddles a concurrent re-baseline. */
function activeManifest(rt: WorkspaceBaselineRuntime): BaselineManifest {
  rt.actor.assertCurrent();

  const rows = rt.storage.sql<{ path: string; size: number; mtime_ms: number; hash: string | null }>`
    SELECT path, size, mtime_ms, hash FROM vfs_baseline_manifest
    WHERE actor_id = ${rt.actor.actorId} AND active = 1`;

  const entries = new Map<string, ManifestEntry>();
  let capturedAt: number | null = null;

  for (const row of rows) {
    if (row.path === '') capturedAt = row.mtime_ms;
    else entries.set(row.path, { size: row.size, mtimeMs: row.mtime_ms, hash: row.hash });
  }

  return { capturedAt, entries };
}

function blobText(rt: WorkspaceBaselineRuntime, hash: string | null): string | null {
  if (hash === null) return null;
  const row = rt.storage.sql<{ content: string }>`SELECT content FROM vfs_baseline_blob WHERE hash = ${hash} LIMIT 1`[0];

  // A missing body means a re-baseline landed mid-read; assuming empty would report the file as added.
  if (!row) throw new Error(`Workspace baseline changed while reading the change-set (body ${hash})`);

  return row.content;
}

function unmoved(entry: ManifestEntry, st: VfsEntryStat): boolean {
  return entry.size === st.size && entry.mtimeMs === st.mtimeMs;
}

/** Cumulative change-set since the baseline. A file whose size and mtime match its manifest row is never read. */
export async function getWorkspaceDiff(rt: WorkspaceBaselineRuntime): Promise<WorkspaceDiffResult> {
  const held = activeManifest(rt);
  // Without a baseline, tracking starts now: the same capture a new workspace takes at creation.
  const trackedSince = held.capturedAt ?? (await resetWorkspaceBaseline(rt)).capturedAt;
  const baseline = held.capturedAt === null ? activeManifest(rt).entries : held.entries;
  const files: FileDiff[] = [];
  let bodyChars = 0;

  const admit = (path: string, status: FileStatus, before: string | null, after: string | null): void => {
    if (before === null || after === null) {
      files.push(fileDiff(path, status, { lines: [], added: 0, removed: 0, truncated: true }));

      return;
    }

    const d = diffLines(before, after);

    if (bodyChars >= MAX_CHANGESET_BODY_CHARS) {
      files.push(fileDiff(path, status, { lines: [], added: d.added, removed: d.removed, truncated: true }));

      return;
    }

    for (const l of d.lines) bodyChars += l.text.length;
    files.push(fileDiff(path, status, d));
  };

  await walkWorkspaceFiles(rt, async (path, st) => {
    const base = baseline.get(path);
    baseline.delete(path);

    if (base !== undefined && unmoved(base, st)) return;
    const after = st.size > BODY_MAX_BYTES ? null : await reviewableText(rt, path);

    if (base === undefined) {
      // A binary file the baseline never held is not a reviewable change.
      if (after !== null || st.size > BODY_MAX_BYTES) admit(path, 'added', '', after);

      return;
    }

    if (after !== null && base.hash !== null && base.hash === sha256Hex(after)) return;
    admit(path, 'changed', blobText(rt, base.hash), after);
  });

  // Whatever the baseline still holds was not found in the workspace.
  for (const [path, base] of baseline) admit(path, 'removed', blobText(rt, base.hash), '');

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, trackedSince };
}

/**
 * Mark the current workspace as the baseline. Rows go under an inactive generation, then one statement flips it
 * active, so no read sees a partial replacement. An unmoved file keeps its hash without being read.
 */
export async function resetWorkspaceBaseline(
  rt: WorkspaceBaselineRuntime,
): Promise<{ ok: true; files: number; capturedAt: number }> {
  const previous = activeManifest(rt).entries;
  const actorId = rt.actor.actorId;
  const generation = nanoid();
  const capturedAt = Date.now();
  let files = 0;

  try {
    // The marker makes an intentionally empty snapshot representable.
    void rt.storage.sql`INSERT INTO vfs_baseline_manifest (actor_id, generation, path, size, mtime_ms, hash, active)
      VALUES (${actorId}, ${generation}, ${''}, ${0}, ${capturedAt}, ${null}, ${0})`;
    await walkWorkspaceFiles(rt, async (path, st) => {
      const kept = previous.get(path);
      let hash: string | null = null;

      if (kept !== undefined && unmoved(kept, st)) {
        hash = kept.hash;
      } else if (st.size <= BODY_MAX_BYTES) {
        const text = await reviewableText(rt, path);

        if (text === null) return;
        hash = sha256Hex(text);
        void rt.storage.sql`INSERT OR IGNORE INTO vfs_baseline_blob (hash, content) VALUES (${hash}, ${text})`;
      }

      void rt.storage.sql`INSERT INTO vfs_baseline_manifest (actor_id, generation, path, size, mtime_ms, hash, active)
        VALUES (${actorId}, ${generation}, ${path}, ${st.size}, ${st.mtimeMs}, ${hash}, ${0})`;
      files++;
    });
    void rt.storage.sql`UPDATE vfs_baseline_manifest
      SET active = CASE WHEN generation = ${generation} THEN 1 ELSE 0 END
      WHERE actor_id = ${actorId}`;
  } finally {
    // Inactive rows are either replaced generations or this failed partial write; the error propagates.
    void rt.storage.sql`DELETE FROM vfs_baseline_manifest WHERE actor_id = ${actorId} AND active = 0`;
    void rt.storage.sql`DELETE FROM vfs_baseline_blob
      WHERE hash NOT IN (SELECT hash FROM vfs_baseline_manifest WHERE hash IS NOT NULL)`;
  }

  return { ok: true, files, capturedAt };
}

/** Tracked, staged and untracked changes without writing the index: `git diff --no-index` avoids
 * `.git/index.lock` contention that `git add -N` would cause. */
async function getGitDiff(rt: AgentRuntime, executorId: string): Promise<ExecutorDiffResult> {
  const provider = rt.executionRouter?.getProvider(executorId);

  if (!provider) return { files: [], mode: 'git', error: `Executor "${executorId}" not found` };
  const execTool = provider.tools.exec;

  if (!execTool) return { files: [], mode: 'git', error: `Executor "${executorId}" has no exec tool` };

  const execute = async (command: string): Promise<string> => {
    const result = v.parse(CommandResultSchema, await execTool.execute(command));

    if (!v.is(v.string(), result)) throw new KinuError(result.reason, result.error);

    return result;
  };

  try {
    // Keep the two git streams separate: a single pipeline would mix NUL-delimited paths into the diff.
    const root = (await execute(`git rev-parse --show-toplevel 2>/dev/null || printf '${NOT_GIT_REPO}'`)).trim();

    if (root === NOT_GIT_REPO) return { files: [], mode: 'git', notGitRepo: true };

    const quotedRoot = `'${root.replace(/'/g, `'\\''`)}'`;
    const headOutput = (await execute(`git -C ${quotedRoot} rev-parse --verify HEAD >/dev/null 2>&1 && printf yes || printf no`)).trim();

    if (headOutput !== 'yes' && headOutput !== 'no') {
      return { files: [], mode: 'git', error: `Unexpected git HEAD probe output: ${headOutput}` };
    }

    const hasHead = headOutput === 'yes';

    const tracked = hasHead
      ? await execute(`git -C ${quotedRoot} --no-pager diff --no-ext-diff --no-renames HEAD --`)
      : '';

    const pathScope = hasHead ? '--others' : '--cached --others';
    const untracked = await execute(`git -C ${quotedRoot} ls-files ${pathScope} --exclude-standard -z`);

    const untrackedDiff = untracked === '(no output)'
      ? ''
      : await execute(`git -C ${quotedRoot} ls-files ${pathScope} --exclude-standard -z | ` +
        `xargs -0 -n 1 sh -c '[ -z "$2" ] || git -C "$1" --no-pager diff --no-index --no-ext-diff --no-renames -- /dev/null "$2" || test "$?" -eq 1' sh ${quotedRoot}`);

    const unified = [tracked === '(no output)' ? '' : tracked, untrackedDiff === '(no output)' ? '' : untrackedDiff]
      .filter(Boolean).join('\n');

    return { files: parseGitDiff(unified), mode: 'git' };
  } catch (err) {
    return { files: [], mode: 'git', error: renderThrownChain({ cause: err }) };
  }
}

export async function getExecutorDiff(rt: AgentRuntime, executorId: string): Promise<ExecutorDiffResult> {
  if (executorId === 'workspace') {
    const provider = rt.executionRouter?.getProvider('workspace');

    if (provider?.tools.exec && provider.capabilities.has('git')) {
      const git = await getGitDiff(rt, 'workspace');

      if (!git.notGitRepo) return git;
    }

    const r = await getWorkspaceDiff(rt);

    return { files: r.files, mode: 'vfs-baseline', trackedSince: r.trackedSince };
  }

  return getGitDiff(rt, executorId);
}
