/**
 * Change-set read model per executor: read-only git diff where a repo exists, else a snapshot
 * baseline manifest (`vfs_baseline_manifest`, bodies by hash in `vfs_baseline_blob`). Reads never mutate the
 * baseline; "mark reviewed" re-baselines.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, VfsEntryStat } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus, type Omitted } from '../vfs/diff';
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

/**
 * `hash` is a digest of a file's bytes, null past one row; a text file's body is stored once per hash, a binary file's
 * never. `vfs_baseline_generation` names the generation each one replaced, for Undo.
 */
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
  execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline_generation (
    actor_id   TEXT NOT NULL,
    generation TEXT NOT NULL,
    replaced   TEXT,
    PRIMARY KEY (actor_id, generation)
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

/** `body`: the text is stored under `hash`, so the file was not binary. */
interface ManifestEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string | null;
  readonly body: boolean;
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

/** A digest of a file's bytes, and the text a line diff shows unless the file is binary (NUL-bearing). */
interface Contents {
  readonly digest: string;
  readonly text: string | null;
}

async function contentsOf(rt: WorkspaceBaselineRuntime, path: string): Promise<Contents> {
  let content: string | Uint8Array;

  try {
    content = await rt.storage.vfs.readFile(path);
  } catch (error) {
    throw new Error(`Workspace snapshot could not read ${JSON.stringify(path)}`, { cause: error });
  }

  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);

  return { digest: sha256Hex(bytes), text: bytes.includes(0) ? null : new TextDecoder().decode(bytes) };
}

/** The '' marker row carries the capture time. */
interface BaselineManifest {
  readonly capturedAt: number;
  readonly generation: string;
  readonly entries: Map<string, ManifestEntry>;
}

/** Read in one query, so a diff never straddles a concurrent re-baseline. Null: this actor has no baseline yet. */
function activeManifest(rt: WorkspaceBaselineRuntime): BaselineManifest | null {
  rt.actor.assertCurrent();

  const rows = rt.storage.sql<{ generation: string; path: string; size: number; mtime_ms: number; hash: string | null; body: number }>`
    SELECT m.generation, m.path, m.size, m.mtime_ms, m.hash, b.hash IS NOT NULL AS body FROM vfs_baseline_manifest m
    LEFT JOIN vfs_baseline_blob b ON b.hash = m.hash
    WHERE m.actor_id = ${rt.actor.actorId} AND m.active = 1`;

  const entries = new Map<string, ManifestEntry>();
  let marker: { readonly capturedAt: number; readonly generation: string } | null = null;

  for (const row of rows) {
    if (row.path === '') marker = { capturedAt: row.mtime_ms, generation: row.generation };
    else entries.set(row.path, { size: row.size, mtimeMs: row.mtime_ms, hash: row.hash, body: row.body === 1 });
  }

  return marker === null ? null : { ...marker, entries };
}

function blobText(rt: WorkspaceBaselineRuntime, entry: ManifestEntry): string | null {
  if (!entry.body || entry.hash === null) return null;
  const row = rt.storage.sql<{ content: string }>`SELECT content FROM vfs_baseline_blob WHERE hash = ${entry.hash} LIMIT 1`[0];

  // A missing body means a re-baseline landed mid-read; assuming empty would report the file as added.
  if (!row) throw new Error(`Workspace baseline changed while reading the change-set (body ${entry.hash})`);

  return row.content;
}

function unmoved(entry: ManifestEntry, st: VfsEntryStat): boolean {
  return entry.size === st.size && entry.mtimeMs === st.mtimeMs;
}

/** Why a side of this size has no text: past one row, or binary. */
function unread(size: number): Omitted {
  return size > BODY_MAX_BYTES ? 'large' : 'binary';
}

/** A file's two texts, null where a side could not be read, and the reason to give if one could not. */
interface Sides {
  readonly before: string | null;
  readonly after: string | null;
  readonly omitted: Omitted;
}

/** Cumulative change-set since the baseline. A file whose size and mtime match its manifest row is never read. */
export async function getWorkspaceDiff(rt: WorkspaceBaselineRuntime): Promise<WorkspaceDiffResult> {
  // Without a baseline, tracking starts now: the same capture a new workspace takes at creation.
  const manifest = activeManifest(rt) ?? await capture(rt, new Map(), null);
  const baseline = manifest.entries;
  const files: FileDiff[] = [];
  let bodyChars = 0;

  const admit = (path: string, status: FileStatus, { before, after, omitted }: Sides): void => {
    if (before === null || after === null) {
      files.push({ path, status, added: 0, removed: 0, lines: [], omitted });

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
    const now = st.size > BODY_MAX_BYTES ? null : await contentsOf(rt, path);
    const after = now?.text ?? null;

    if (base === undefined) {
      admit(path, 'added', { before: '', after, omitted: unread(st.size) });

      return;
    }

    if (now !== null && base.hash === now.digest) return;
    admit(path, 'changed', { before: after === null ? null : blobText(rt, base), after, omitted: unread(after === null ? st.size : base.size) });
  });

  // Whatever the baseline still holds was not found in the workspace.
  for (const [path, base] of baseline) admit(path, 'removed', { before: blobText(rt, base), after: '', omitted: unread(base.size) });

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, trackedSince: manifest.capturedAt };
}

/** The generation the active one replaced, kept for Undo. */
function replacedGeneration(rt: WorkspaceBaselineRuntime): string | null {
  const actorId = rt.actor.actorId;

  return rt.storage.sql<{ replaced: string | null }>`SELECT g.replaced FROM vfs_baseline_generation g
    JOIN vfs_baseline_manifest m ON m.actor_id = g.actor_id AND m.generation = g.generation
    WHERE g.actor_id = ${actorId} AND m.active = 1 AND m.path = '' LIMIT 1`[0]?.replaced ?? null;
}

/** Drops every generation but the active one and the one it replaced, then the bodies nothing names. */
function pruneBaselines(rt: WorkspaceBaselineRuntime): void {
  const actorId = rt.actor.actorId;

  void rt.storage.sql`DELETE FROM vfs_baseline_manifest WHERE actor_id = ${actorId} AND active = 0
    AND generation IS NOT ${replacedGeneration(rt)}`;
  void rt.storage.sql`DELETE FROM vfs_baseline_generation WHERE actor_id = ${actorId}
    AND generation NOT IN (SELECT generation FROM vfs_baseline_manifest WHERE actor_id = ${actorId})`;
  void rt.storage.sql`DELETE FROM vfs_baseline_blob
    WHERE hash NOT IN (SELECT hash FROM vfs_baseline_manifest WHERE hash IS NOT NULL)`;
}

/**
 * Mark the current workspace as the baseline. Rows go under an inactive generation, then one statement flips it
 * active, so no read sees a partial replacement. An unmoved file keeps its hash without being read.
 */
export async function resetWorkspaceBaseline(
  rt: WorkspaceBaselineRuntime,
): Promise<{ ok: true; files: number; capturedAt: number }> {
  const held = activeManifest(rt);
  const taken = await capture(rt, held?.entries ?? new Map(), held?.generation ?? null);

  return { ok: true, files: taken.entries.size, capturedAt: taken.capturedAt };
}

async function capture(
  rt: WorkspaceBaselineRuntime, previous: ReadonlyMap<string, ManifestEntry>, replaced: string | null,
): Promise<BaselineManifest> {
  const actorId = rt.actor.actorId;
  const generation = nanoid();
  const capturedAt = Date.now();
  const entries = new Map<string, ManifestEntry>();

  try {
    // The marker makes an intentionally empty snapshot representable.
    void rt.storage.sql`INSERT INTO vfs_baseline_manifest (actor_id, generation, path, size, mtime_ms, hash, active)
      VALUES (${actorId}, ${generation}, ${''}, ${0}, ${capturedAt}, ${null}, ${0})`;
    await walkWorkspaceFiles(rt, async (path, st) => {
      const kept = previous.get(path);
      let entry: ManifestEntry = { size: st.size, mtimeMs: st.mtimeMs, hash: null, body: false };

      if (kept !== undefined && unmoved(kept, st)) {
        entry = kept;
      } else if (st.size <= BODY_MAX_BYTES) {
        const { digest, text } = await contentsOf(rt, path);

        entry = { ...entry, hash: digest, body: text !== null };

        if (text !== null) void rt.storage.sql`INSERT OR IGNORE INTO vfs_baseline_blob (hash, content) VALUES (${digest}, ${text})`;
      }

      void rt.storage.sql`INSERT INTO vfs_baseline_manifest (actor_id, generation, path, size, mtime_ms, hash, active)
        VALUES (${actorId}, ${generation}, ${path}, ${entry.size}, ${entry.mtimeMs}, ${entry.hash}, ${0})`;
      entries.set(path, entry);
    });
    void rt.storage.sql`INSERT INTO vfs_baseline_generation (actor_id, generation, replaced)
      VALUES (${actorId}, ${generation}, ${replaced})`;
    void rt.storage.sql`UPDATE vfs_baseline_manifest
      SET active = CASE WHEN generation = ${generation} THEN 1 ELSE 0 END
      WHERE actor_id = ${actorId}`;
  } finally {
    // A failed partial write goes with the older generations; the error propagates.
    pruneBaselines(rt);
  }

  return { capturedAt, generation, entries };
}

/** Undoes the last Mark reviewed: the generation it replaced is the baseline again. */
export function restoreWorkspaceBaseline(rt: WorkspaceBaselineRuntime): { ok: true; capturedAt: number } | { ok: false; error: string } {
  rt.actor.assertCurrent();
  const actorId = rt.actor.actorId;

  const replaced = replacedGeneration(rt);

  const marker = replaced === null ? undefined : rt.storage.sql<{ mtime_ms: number }>`SELECT mtime_ms FROM vfs_baseline_manifest
    WHERE actor_id = ${actorId} AND generation = ${replaced} AND path = '' LIMIT 1`[0];

  if (replaced === null || marker === undefined) return { ok: false, error: 'There is no earlier review to go back to.' };
  void rt.storage.sql`UPDATE vfs_baseline_manifest
    SET active = CASE WHEN generation = ${replaced} THEN 1 ELSE 0 END
    WHERE actor_id = ${actorId}`;
  pruneBaselines(rt);

  return { ok: true, capturedAt: marker.mtime_ms };
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
