/**
 * Change-set read model: the workspace's own plane against a baseline manifest (`vfs_baseline_manifest`, bodies
 * by hash in `vfs_baseline_blob`); other executors by read-only git diff. Reads never mutate the baseline.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, VFS, VfsEntryStat } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus, type Omitted } from '../vfs/diff';
import { nanoid } from '../utils/nanoid';
import * as v from 'valibot';
import { CommandResultSchema } from '../execution/exec-result';
import { KinuError, renderThrownChain, tolerateAsync } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import type { VfsMountRouting } from '../vfs/mounts';
import { isSystemManaged, LEGACY_WORKSPACE_ROOT, SLATES_ROOT, WORKSPACE_ROOT } from '../vfs/workspace-path';
import { unmovedSince } from '../vfs/unmoved';

/** `do.sqlite.row_bytes` caps a body's row, which also holds its 64-hex key. */
const BODY_MAX_BYTES = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value - 64;

/** Quarter of the facet RPC ceiling: the reply is UTF-16 in the isolate plus per-line overhead.
 *  Files past it are listed with +/- counts and no body. */
const MAX_CHANGESET_BODY_CHARS = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  '.git', '.cache', '.mypy_cache', '.pnpm-store', '.pytest_cache', '.venv', '__pycache__', 'node_modules', 'venv',
]);

const WORKING_DIRECTORY_NAMES = [WORKSPACE_ROOT, LEGACY_WORKSPACE_ROOT];

const UNREVIEWED_PATHS: ReadonlySet<string> = new Set(WORKING_DIRECTORY_NAMES);

/** Also a manifest row: a generation that holds it walked the plane root, so its slates are already at /slates. */
const PLANE_ROOT = '/';

/** Under the plane root the change-set reviews every agent's home and the slates, and nothing else (owner, 2026-09-25). */
const REVIEWED_UNDER_ROOT = ['home', SLATES_ROOT.slice(1)];

const NOT_GIT_REPO = '__KINU_NOT_GIT_REPO__';

const HeadCommitSchema = v.pipe(v.string(), v.hexadecimal(), v.minLength(40), v.maxLength(64));

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
  baseline: string;
}

export interface ExecutorDiffResult {
  files: FileDiff[];
  mode: 'git' | 'vfs-baseline';
  trackedSince?: number;
  baseline?: string;
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

/**
 * Every regular file the change-set reviews, breadth-first so root files come first, by stat alone. The walk runs
 * while turns write, so an entry can vanish between its directory's listing and its own read: it is absent, as a
 * snapshot of a file that is gone does not contain it.
 */
async function walkWorkspaceFiles(
  rt: WorkspaceBaselineRuntime,
  visit: (path: string, stat: VfsEntryStat) => void | Promise<void>,
): Promise<void> {
  const routed: VFS & Partial<Pick<VfsMountRouting, 'mountOf'>> = rt.storage.vfs;
  const roots = ['', PLANE_ROOT];
  const directories = [...roots];

  for (let next = 0; next < directories.length; next++) {
    const dir = directories[next];
    const names = await namesIn(rt, dir, next >= roots.length);
    const children: string[] = [];

    for (const name of names ?? []) {
      if (isSystemManaged(name) || SNAPSHOT_IGNORED_DIRECTORIES.has(name)) continue;

      if (dir === PLANE_ROOT && !REVIEWED_UNDER_ROOT.includes(name)) continue;
      const full = dir === '' ? name : `${dir === PLANE_ROOT ? '' : dir}/${name}`;

      if (UNREVIEWED_PATHS.has(full) || (routed.mountOf?.(full) ?? null) !== null) continue;
      const st = await statOf(rt, full);

      if (st === undefined || st === null) continue;

      if (st.isDir) {
        children.push(full);
        continue;
      }

      await visit(full, st);
    }

    directories.push(...children);
  }
}

/** A read of an entry the walk listed: undefined when this actor may not read it, or it is gone since the listing. */
async function whileThere<T>(read: () => Promise<T>): Promise<T | undefined> {
  return tolerateAsync(() => tolerateAsync(read, 'enoent'), 'eacces');
}

/** A root's names, or a listed directory's, which is gone (undefined) when it vanished since its parent's listing. */
async function namesIn(rt: WorkspaceBaselineRuntime, dir: string, listed: boolean): Promise<string[] | undefined> {
  const read = () => rt.storage.vfs.readdir(dir);

  try {
    return (await (listed ? whileThere(read) : tolerateAsync(read, 'eacces')))?.sort();
  } catch (error) {
    throw new Error(`Workspace snapshot could not read directory ${JSON.stringify(dir || '.')}`, { cause: error });
  }
}

/** Null when the entry is gone since its directory was listed. */
async function statOf(rt: WorkspaceBaselineRuntime, path: string): Promise<VfsEntryStat | null | undefined> {
  try {
    return await tolerateAsync(() => rt.storage.vfs.stat(path), 'eacces');
  } catch (error) {
    throw new Error(`Workspace snapshot could not stat ${JSON.stringify(path)}`, { cause: error });
  }
}

/** A digest of a file's bytes, and the text a line diff shows unless the file is binary (NUL-bearing). */
interface Contents {
  readonly digest: string;
  readonly text: string | null;
}

async function contentsOf(rt: WorkspaceBaselineRuntime, path: string): Promise<Contents | undefined> {
  let content: string | Uint8Array | undefined;

  try {
    content = await whileThere(() => rt.storage.vfs.readFile(path));
  } catch (error) {
    throw new Error(`Workspace snapshot could not read ${JSON.stringify(path)}`, { cause: error });
  }

  if (content === undefined) return undefined;
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

  const rows = rt.storage.sql<{ generation: string; path: string; size: number; mtime_ms: number; hash: string | null }>`
    SELECT generation, path, size, mtime_ms, hash FROM vfs_baseline_manifest
    WHERE actor_id = ${rt.actor.actorId} AND active = 1`;

  const entries = new Map<string, ManifestEntry>();
  let marker: { readonly capturedAt: number; readonly generation: string } | null = null;
  let planeWalked = false;

  for (const row of rows) {
    if (row.path === '') marker = { capturedAt: row.mtime_ms, generation: row.generation };
    else if (row.path === PLANE_ROOT) planeWalked = true;
    else entries.set(row.path, { size: row.size, mtimeMs: row.mtime_ms, hash: row.hash });
  }

  if (marker === null) return null;

  return { ...marker, entries: planeWalked ? entries : slatesMovedToRoot(entries) };
}

function slatesMovedToRoot(entries: Map<string, ManifestEntry>): Map<string, ManifestEntry> {
  const moved = new Map<string, ManifestEntry>();

  for (const [path, entry] of entries) moved.set(path.startsWith('slates/') ? `${SLATES_ROOT}/${path.slice('slates/'.length)}` : path, entry);

  return moved;
}

/** A file's text as `generation` holds it: null past one row, or for a binary file, which has no body. */
function blobText(rt: WorkspaceBaselineRuntime, entry: ManifestEntry, generation: string): string | null {
  if (entry.hash === null) return null;
  const row = rt.storage.sql<{ content: string }>`SELECT content FROM vfs_baseline_blob WHERE hash = ${entry.hash} LIMIT 1`[0];

  if (row !== undefined) return row.content;

  const active = rt.storage.sql<{ active: number }>`SELECT active FROM vfs_baseline_manifest
    WHERE actor_id = ${rt.actor.actorId} AND generation = ${generation} AND path = '' LIMIT 1`[0]?.active === 1;

  // While its generation is active every text body is kept, so a missing one was binary. Otherwise a re-baseline
  // landed mid-read, and assuming empty would report the file as added.
  if (!active) throw new Error(`Workspace baseline changed while reading the change-set (body ${entry.hash})`);

  return null;
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

/** Cumulative change-set since the baseline. A file whose manifest row still holds by {@link unmovedSince} is never read. */
export async function getWorkspaceDiff(rt: WorkspaceBaselineRuntime): Promise<WorkspaceDiffResult> {
  // Without a baseline, tracking starts now: the same capture a new workspace takes at creation.
  const manifest = activeManifest(rt) ?? await capture(rt, null);
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

    if (base !== undefined && unmovedSince(base, manifest.capturedAt, st)) return;
    const now = st.size > BODY_MAX_BYTES ? null : await contentsOf(rt, path);

    if (now === undefined) return;
    const after = now?.text ?? null;

    if (base === undefined) {
      admit(path, 'added', { before: '', after, omitted: unread(st.size) });

      return;
    }

    if (now !== null && base.hash === now.digest) return;
    admit(path, 'changed', { before: after === null ? null : blobText(rt, base, manifest.generation), after, omitted: unread(after === null ? st.size : base.size) });
  });

  // Whatever the baseline still holds was not found in the workspace.
  for (const [path, base] of baseline) admit(path, 'removed', { before: blobText(rt, base, manifest.generation), after: '', omitted: unread(base.size) });

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, trackedSince: manifest.capturedAt, baseline: manifest.generation };
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
  const taken = await capture(rt, activeManifest(rt));

  return { ok: true, files: taken.entries.size, capturedAt: taken.capturedAt };
}

async function capture(rt: WorkspaceBaselineRuntime, held: BaselineManifest | null): Promise<BaselineManifest> {
  const actorId = rt.actor.actorId;
  const generation = nanoid();
  const capturedAt = Date.now();
  const entries = new Map<string, ManifestEntry>();

  try {
    // The marker makes an intentionally empty snapshot representable.
    for (const marker of ['', PLANE_ROOT]) {
      void rt.storage.sql`INSERT INTO vfs_baseline_manifest (actor_id, generation, path, size, mtime_ms, hash, active)
        VALUES (${actorId}, ${generation}, ${marker}, ${0}, ${capturedAt}, ${null}, ${0})`;
    }

    await walkWorkspaceFiles(rt, async (path, st) => {
      const kept = held?.entries.get(path);
      let entry: ManifestEntry = { size: st.size, mtimeMs: st.mtimeMs, hash: null };

      if (kept !== undefined && held !== null && unmovedSince(kept, held.capturedAt, st)) {
        entry = kept;
      } else if (st.size <= BODY_MAX_BYTES) {
        const contents = await contentsOf(rt, path);

        if (contents === undefined) return;
        const { digest, text } = contents;
        entry = { ...entry, hash: digest };

        if (text !== null) void rt.storage.sql`INSERT OR IGNORE INTO vfs_baseline_blob (hash, content) VALUES (${digest}, ${text})`;
      }

      void rt.storage.sql`INSERT INTO vfs_baseline_manifest (actor_id, generation, path, size, mtime_ms, hash, active)
        VALUES (${actorId}, ${generation}, ${path}, ${entry.size}, ${entry.mtimeMs}, ${entry.hash}, ${0})`;
      entries.set(path, entry);
    });
    void rt.storage.sql`INSERT INTO vfs_baseline_generation (actor_id, generation, replaced)
      VALUES (${actorId}, ${generation}, ${held?.generation ?? null})`;
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
    const head = (await execute(`git -C ${quotedRoot} rev-parse --verify --quiet HEAD || printf no`)).trim();
    const hasHead = head !== 'no';

    if (hasHead && !v.safeParse(HeadCommitSchema, head).success) {
      return { files: [], mode: 'git', error: `Unexpected git HEAD probe output: ${head}` };
    }

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

    const files = parseGitDiff(unified);

    return hasHead ? { files, mode: 'git', baseline: head } : { files, mode: 'git' };
  } catch (err) {
    return { files: [], mode: 'git', error: renderThrownChain({ cause: err }) };
  }
}

export async function getExecutorDiff(rt: AgentRuntime, executorId: string): Promise<ExecutorDiffResult> {
  if (executorId === 'workspace') {
    const r = await getWorkspaceDiff(rt);

    return { files: r.files, mode: 'vfs-baseline', trackedSince: r.trackedSince, baseline: r.baseline };
  }

  return getGitDiff(rt, executorId);
}
