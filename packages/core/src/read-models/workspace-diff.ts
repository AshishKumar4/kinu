/**
 * Change-set read model: the workspace's own plane against a baseline manifest (`vfs_baseline_manifest`, bodies
 * by hash in `vfs_baseline_blob`); other executors by read-only git diff. Reads never mutate the baseline.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, VFS, VfsEntryStat, VfsLinkStat } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus, type Omitted } from '../vfs/diff';
import { nanoid } from '../utils/nanoid';
import * as v from 'valibot';
import { CommandResultSchema } from '../execution/exec-result';
import { KinuError, renderThrownChain, tolerateAsync } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import { shellQuote } from '../utils/shell';
import type { VfsMountRouting } from '../vfs/mounts';
import { LEGACY_WORKSPACE_ROOT, SLATES_ROOT, WORKSPACE_ROOT } from '../vfs/workspace-path';
import { unmovedSince } from '../vfs/unmoved';

/** `do.sqlite.row_bytes` caps a body's row, which also holds its 64-hex key. */
const BODY_MAX_BYTES = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value - 64;

/** Quarter of the facet RPC ceiling: the reply is UTF-16 in the isolate plus per-line overhead.
 *  Files past it are listed with +/- counts and no body. */
const MAX_CHANGESET_BODY_CHARS = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

/** Installed dependency trees: installs, not work, and costly to walk. Hidden ones fall under {@link reviewed}. */
const DEPENDENCY_TREES: ReadonlySet<string> = new Set(['__pycache__', 'node_modules', 'venv']);

/** Hidden files and folders, and dependency trees, are never reviewed (owner, 2026-09-25). */
function reviewed(name: string): boolean {
  return !name.startsWith('.') && !DEPENDENCY_TREES.has(name);
}

const WORKING_DIRECTORY_NAMES = [WORKSPACE_ROOT, LEGACY_WORKSPACE_ROOT];

const UNREVIEWED_PATHS: ReadonlySet<string> = new Set(WORKING_DIRECTORY_NAMES);

/** Also a manifest row: a generation that holds it walked the plane root, so its slates are already at /slates. */
const PLANE_ROOT = '/';

/** Under the plane root the change-set reviews every agent's home and the slates, and nothing else (owner, 2026-09-25). */
const REVIEWED_UNDER_ROOT = ['home', SLATES_ROOT.slice(1)];

/** How far below an executor's working directory the git view looks for repositories, as VS Code bounds its scan. */
const REPOSITORY_SCAN_DEPTH = 3;

/** Opens each record of the git view, at a line start. */
const MARK = '\u0001';

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
  /** The git view's repositories, as the folders their files are listed under. */
  repositories?: string[];
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
 * Every file and symbolic link the change-set reviews, breadth-first so root files come first, by stat alone. A link
 * is an entry, never followed. The walk runs while turns write, so an entry can vanish between its directory's
 * listing and its own read: it is absent, as a snapshot of a file that is gone does not contain it.
 */
async function walkWorkspaceFiles(
  rt: WorkspaceBaselineRuntime,
  visit: (path: string, stat: VfsEntryStat | VfsLinkStat) => void | Promise<void>,
): Promise<void> {
  const routed: VFS & Partial<Pick<VfsMountRouting, 'mountOf'>> = rt.storage.vfs;
  const roots = ['', PLANE_ROOT];
  const directories = [...roots];

  for (let next = 0; next < directories.length; next++) {
    const dir = directories[next];
    const names = await namesIn(rt, dir, next >= roots.length);
    const children: string[] = [];

    for (const name of names ?? []) {
      if (!reviewed(name)) continue;

      if (dir === PLANE_ROOT && !REVIEWED_UNDER_ROOT.includes(name)) continue;
      const full = dir === '' ? name : `${dir === PLANE_ROOT ? '' : dir}/${name}`;

      if (UNREVIEWED_PATHS.has(full) || (routed.mountOf?.(full) ?? null) !== null) continue;
      const st = await statOf(rt, full);

      if (st === undefined || st === null) continue;

      if (st.isDir && !isLink(st)) {
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

/**
 * The entry itself, a symbolic link not followed: a link's target is files seen twice, or hidden ones, or its own
 * folder again. Null when the entry is gone since its directory was listed.
 */
async function statOf(rt: WorkspaceBaselineRuntime, path: string): Promise<VfsLinkStat | VfsEntryStat | null | undefined> {
  const { vfs } = rt.storage;

  try {
    return await tolerateAsync(() => (vfs.lstat === undefined ? vfs.stat(path) : vfs.lstat(path)), 'eacces');
  } catch (error) {
    throw new Error(`Workspace snapshot could not stat ${JSON.stringify(path)}`, { cause: error });
  }
}

function isLink(st: VfsEntryStat | VfsLinkStat): boolean {
  return 'isSymlink' in st && st.isSymlink;
}

/** A digest of a file's bytes, and the text a line diff shows unless the file is binary (NUL-bearing). */
interface Contents {
  readonly digest: string;
  readonly text: string | null;
}

/** A link's contents are its target text, digested apart from a file holding the same text, so a swap is a change. */
const LINK_DIGEST_PREFIX = new TextEncoder().encode('symlink\0');

async function contentsOf(rt: WorkspaceBaselineRuntime, path: string, st: VfsEntryStat | VfsLinkStat): Promise<Contents | undefined> {
  const { vfs } = rt.storage;
  let content: string | Uint8Array | undefined;

  try {
    if (!isLink(st)) {
      content = await whileThere(() => vfs.readFile(path));
    } else if (vfs.readlink === undefined) {
      throw new Error('this plane reports links but reads none');
    } else {
      const readlink = vfs.readlink.bind(vfs);
      content = await whileThere(() => readlink(path));
    }
  } catch (error) {
    throw new Error(`Workspace snapshot could not read ${JSON.stringify(path)}`, { cause: error });
  }

  if (content === undefined) return undefined;
  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  const digested = isLink(st) ? new Uint8Array([...LINK_DIGEST_PREFIX, ...bytes]) : bytes;

  return { digest: sha256Hex(digested), text: bytes.includes(0) ? null : new TextDecoder().decode(bytes) };
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
    // A generation captured before hidden files were left out still lists them.
    else if (row.path.split('/').every((name) => name === '' || reviewed(name))) entries.set(row.path, { size: row.size, mtimeMs: row.mtime_ms, hash: row.hash });
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
    const now = st.size > BODY_MAX_BYTES ? null : await contentsOf(rt, path, st);

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
        const contents = await contentsOf(rt, path, st);

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

/** One changed file of a repository: $1 the repository, $2 `tracked` or `untracked`, $3 the path from git's -z list. */
const GIT_FILE_SCRIPT = [
  // xargs runs once on empty input; `/` is the list's own failure; `dir/` is a nested repository, its own section.
  'case "${3-}" in "") exit 0;; /) exit 1;; */) exit 0;; esac',
  `printf '\\001F%s\\000\\n' "$3"`,
  'if [ "$2" = tracked ]; then exec git -C "$1" --no-pager diff --no-ext-diff --no-renames HEAD -- ":(literal)$3"; fi',
  'git -C "$1" --no-pager diff --no-index --no-ext-diff --no-renames -- /dev/null "$3" || test "$?" -eq 1',
].join('\n');

/** One repository's section: $1 the folder git runs in, $2 its label (empty for the one enclosing the working directory). */
const GIT_REPOSITORY_SCRIPT = [
  'head=$(git -C "$1" rev-parse --verify --quiet HEAD 2>/dev/null) || head=',
  `printf '\\001R%s\\000%s\\000\\n' "$2" "$head"`,
  `scope='--cached --others'`,
  'if [ -n "$head" ]; then',
  `  { git -C "$1" diff --name-only -z --no-renames HEAD -- || printf '/\\000'; } | xargs -0 -n 1 sh -c "$KINU_GIT_FILE" sh "$1" tracked || printf '\\n\\001X\\n'`,
  '  scope=--others',
  'fi',
  `{ git -C "$1" ls-files $scope --exclude-standard -z || printf '/\\000'; } | xargs -0 -n 1 sh -c "$KINU_GIT_FILE" sh "$1" untracked || printf '\\n\\001X\\n'`,
].join('\n');

/** The repositories find hands over, `./.git` excepted: the enclosing section already holds it. */
const GIT_SCAN_SCRIPT = 'exec 2>&3; for dotgit; do [ "$dotgit" = ./.git ] || sh -c "$KINU_GIT_REPO" sh "${dotgit%/.git}" "${dotgit%/.git}"; done';

/**
 * One exec, in POSIX sh, that shows the repository enclosing the working directory, as VS Code does, and every one
 * within {@link REPOSITORY_SCAN_DEPTH} below it, skipping hidden folders and node_modules: tracked, staged and
 * untracked changes since HEAD, .gitignore honoured. Every path travels NUL-delimited, from `find -exec` and git's
 * `-z` lists into records the parser reads by NUL, so no name is split or quoted. `git diff --no-index` reads
 * untracked files without writing the index.
 */
function gitViewScript(): string {
  return [
    `export KINU_GIT_FILE=${shellQuote(GIT_FILE_SCRIPT)} KINU_GIT_REPO=${shellQuote(GIT_REPOSITORY_SCRIPT)}`,
    'if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then',
    `  printf '\\001N'; git rev-parse --show-toplevel; printf '\\000'; git rev-parse --show-prefix; printf '\\000\\n'`,
    '  cdup=$(git rev-parse --show-cdup)',
    `  sh -c "$KINU_GIT_REPO" sh "\${cdup:-.}" ''`,
    'fi',
    // find's own complaints (an unreadable folder) are dropped; the sections' stderr goes out on fd 3.
    `find . -maxdepth ${String(REPOSITORY_SCAN_DEPTH + 1)} \\( -name node_modules -o \\( -name '.?*' ! -name .git \\) \\) -prune -o -name .git -prune -exec sh -c ${shellQuote(GIT_SCAN_SCRIPT)} sh {} + 3>&2 2>/dev/null`,
    `printf '\\001E\\n'`,
  ].join('\n');
}

/** A record's tag and its NUL-ended field count: N the enclosing repository's top and the working directory's
 *  prefix in it, R a repository's label and HEAD, F one file's path, X a failed git command, E the end. */
const RECORD_FIELDS = new Map([['N', 2], ['R', 2], ['F', 1], ['X', 0], ['E', 0]]);

interface GitRecord {
  readonly tag: string;
  readonly fields: string[];
  readonly body: string;
}

interface GitRecords {
  readonly records: GitRecord[];
  readonly stderr: string;
}

/**
 * The records, each at a line start. A patch line never starts with the mark: its lines are prefixed, and git
 * quotes a control character in a header path. What follows the end record is stderr.
 */
function gitRecords(output: string): GitRecords {
  const records: GitRecord[] = [];
  let at = output.startsWith(MARK) ? 0 : output.indexOf(`\n${MARK}`) + 1;

  while (at > 0 || (at === 0 && output.startsWith(MARK))) {
    const tag = output.charAt(at + 1);
    const count = RECORD_FIELDS.get(tag);

    if (count === undefined) throw new KinuError('io', `Unexpected git view record ${JSON.stringify(tag)}`);
    const fields: string[] = [];
    let next = at + 2;

    for (let i = 0; i < count; i++) {
      const end = output.indexOf('\0', next);

      if (end === -1) throw new KinuError('io', `Truncated git view record ${tag}`);
      fields.push(output.slice(next, end));
      next = end + 1;
    }

    if (output.charAt(next) !== '\n') throw new KinuError('io', `Malformed git view record ${tag}`);
    next++;

    if (tag === 'E') return { records, stderr: output.slice(next) };
    const following = output.indexOf(`\n${MARK}`, next - 1);
    const bodyEnd = following === -1 ? output.length : following + 1;
    records.push({ tag, fields, body: output.slice(next, bodyEnd) });
    at = following === -1 ? -1 : bodyEnd;
  }

  throw new KinuError('io', `The git view ended early: ${output.slice(-2000)}`);
}

interface GitView {
  readonly files: FileDiff[];
  readonly repositories: string[];
  readonly heads: string[];
}

/** One line git printed, without its newline. */
function printedLine(field: string): string {
  return field.endsWith('\n') ? field.slice(0, -1) : field;
}

/**
 * The records read back: each repository's files under its folder. Inside a repository the list is framed at its
 * top, under the top's name, so the enclosing repository and the ones below the working directory share one tree.
 */
function gitView(output: string): GitView {
  const { records, stderr } = gitRecords(output);

  if (records.some((record) => record.tag === 'X')) throw new KinuError('io', `A git command failed: ${stderr.trim()}`);
  const enclosing = records.find((record) => record.tag === 'N');
  const top = enclosing === undefined ? '' : printedLine(enclosing.fields[0] ?? '');
  const base = top.slice(top.lastIndexOf('/') + 1);
  const prefix = enclosing === undefined ? '' : printedLine(enclosing.fields[1] ?? '');

  const folderOf = (label: string): string => {
    if (label === '') return base;
    const relative = `${prefix}${label.replace(/^\.\//, '')}`;

    return base === '' ? relative : `${base}/${relative}`;
  };

  const sections: { label: string; head: string; files: FileDiff[] }[] = [];

  for (const record of records) {
    const [first = '', second = ''] = record.fields;

    if (record.tag === 'R') sections.push({ label: first, head: second, files: [] });
    else if (record.tag === 'F') for (const file of parseGitDiff(record.body)) sections.at(-1)?.files.push({ ...file, path: first });
  }

  // find hands repositories over in directory order; the list reads in code-unit order, so the enclosing one ('') first.
  sections.sort((a, b) => (a.label < b.label ? -1 : Number(a.label > b.label)));
  const view: GitView = { files: [], repositories: [], heads: [] };

  for (const section of sections) {
    if (section.head !== '' && !v.safeParse(HeadCommitSchema, section.head).success) {
      throw new KinuError('io', `Unexpected git HEAD in ${section.label || top}: ${section.head}`);
    }

    const folder = folderOf(section.label);
    view.repositories.push(folder);
    view.heads.push(`${folder}@${section.head}`);

    for (const file of section.files) view.files.push({ ...file, path: folder === '' ? file.path : `${folder}/${file.path}` });
  }

  return view;
}

async function getGitDiff(rt: AgentRuntime, executorId: string): Promise<ExecutorDiffResult> {
  const provider = rt.executionRouter?.getProvider(executorId);

  if (!provider) return { files: [], mode: 'git', error: `Executor "${executorId}" not found` };
  const execTool = provider.tools.exec;

  if (!execTool) return { files: [], mode: 'git', error: `Executor "${executorId}" has no exec tool` };

  try {
    const result = v.parse(CommandResultSchema, await execTool.execute(gitViewScript()));

    if (!v.is(v.string(), result)) throw new KinuError(result.reason, result.error);
    const view = gitView(result);

    if (view.repositories.length === 0) return { files: [], mode: 'git', notGitRepo: true };

    return { files: view.files, mode: 'git', baseline: view.heads.join(' '), repositories: view.repositories };
  } catch (err) {
    return { files: [], mode: 'git', error: renderThrownChain({ cause: err }) };
  }
}

/** Whether a write at `path`, absolute as the workspace's file events name it, can move the change-set. */
function reviewsPath(path: string): boolean {
  const names = path.split('/').filter((name) => name !== '');
  const [top] = names;

  return top !== undefined && REVIEWED_UNDER_ROOT.includes(top) && names.every(reviewed);
}

/** The frame a workspace sends its pages when its change-set moved: Changes reads again, shown or not. */
export const CHANGES_MOVED_EVENT = 'changes_moved';

/**
 * The workspace's change-set, read again only after something it reviews moved: a file event on a reviewed path, or
 * a baseline that Mark reviewed or Undo moved. A poll while nothing moved walks nothing.
 */
export class ChangeSetCache {
  private generation = 0;
  private held: { readonly generation: number; readonly result: WorkspaceDiffResult } | null = null;
  /**
   * A move was announced and no read has settled since. A burst of writes is one frame, and a page told re-reads one
   * walk at a time: a frame per read started would let each write start a walk beside the last.
   */
  private announced = false;

  /** `announce` tells the workspace's pages that the change-set moved. */
  constructor(private readonly announce: () => void) {}

  /** Paths a write touched, as the workspace's file events name them. */
  touched(paths: readonly string[]): void {
    if (paths.some(reviewsPath)) this.move();
  }

  /** After Mark reviewed or Undo has moved the baseline. */
  moved(): void {
    this.move();
  }

  async read(load: () => Promise<WorkspaceDiffResult>): Promise<WorkspaceDiffResult> {
    const { generation } = this;

    try {
      if (this.held?.generation === generation) return this.held.result;
      const result = await load();

      // A slower read of an older generation never replaces a newer one.
      if (this.held === null || this.held.generation < generation) this.held = { generation, result };

      return result;
    } finally {
      this.settled(generation);
    }
  }

  private move(): void {
    this.generation += 1;
    this.tell();
  }

  /** A read of `generation` settled: a move it did not see is news again. */
  private settled(generation: number): void {
    this.announced = false;

    if (this.generation !== generation) this.tell();
  }

  private tell(): void {
    if (this.announced) return;
    this.announced = true;
    this.announce();
  }
}

export async function getExecutorDiff(rt: AgentRuntime, executorId: string, changes?: ChangeSetCache): Promise<ExecutorDiffResult> {
  if (executorId === 'workspace') {
    const r = await (changes === undefined ? getWorkspaceDiff(rt) : changes.read(() => getWorkspaceDiff(rt)));

    return { files: r.files, mode: 'vfs-baseline', trackedSince: r.trackedSince, baseline: r.baseline };
  }

  return getGitDiff(rt, executorId);
}
