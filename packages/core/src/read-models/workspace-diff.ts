/**
 * The change-set read model — what the agent has actually changed, per
 * executor.
 *
 * Two planes, one answer shape. A workspace with a git repository uses a
 * read-only git diff; a non-git workspace uses a snapshot baseline stored in
 * `vfs_baseline`. Other shell executors use the same read-only git path from
 * their own working directory.
 *
 * The baseline is captured at workspace birth and is re-markable, which is
 * what makes "mark reviewed" work without a second store. Reads never mutate
 * it: work completed before the owner first opens Output must still be shown.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, VfsEntryStat } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus } from '../vfs/diff';
import { nanoid } from '../utils/nanoid';
// The ONE failure predicate. What stood here was a local regex over
// `Error (exit N)` and `exec error:` — the second is prose no executor writes any
// more, and neither shape covered the refusal payload they return, so an
// unconfigured executor's refusal would have been parsed as a git diff.
import { isFailingResultText } from '../execution/exec-result';
import { renderThrownChain } from '../obs/index';

/**
 * Files bigger than this are excluded from the snapshot — a change-set is a
 * review surface, not a backup.
 *
 * Both numbers bound the RESPONSE, not peak resident bytes: their product is
 * 104,857,600 bytes — 100.0 MiB, or 104.9 MB, which the comment here used to give
 * as 102.4 MiB by dividing a KiB count by 1000. That leaves 23 MB under
 * `worker.isolate.memory`'s published 128 MB, not a margin worth relying on, and
 * `do.isolate.reset_silent` — a retained working set past roughly 200 MiB
 * resetting the object with nothing thrown or logged — would present as an
 * unexplained disappearance rather than as a truncated diff. What bounds residency
 * is `walkWorkspaceTextFiles`, which holds one body at a time; these two only
 * bound what a caller is answered with.
 */
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_FILES = 400;

/** Total body characters one change-set may carry. A quarter of the facet RPC
 *  ceiling, because the reply crosses that boundary and the isolate holds it as
 *  UTF-16 — twice its serialized size — with a row object and JSON quoting per
 *  line on top. A file admitted past it is still listed, with true +/- counts
 *  and no body, rather than dropped. */
const MAX_CHANGESET_BODY_CHARS = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  '.git', '.kinu', '.cache', '.mypy_cache', '.pnpm-store', '.pytest_cache', '.venv',
  '__pycache__', 'node_modules', 'venv',
]);
const NOT_GIT_REPO = '__KINU_NOT_GIT_REPO__';

export function initWorkspaceBaselineTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline (
    generation TEXT NOT NULL,
    path       TEXT NOT NULL,
    content    TEXT NOT NULL,
    active     INTEGER NOT NULL CHECK (active IN (0, 1)),
    PRIMARY KEY (generation, path)
  )`);
}

export interface WorkspaceDiffResult {
  files: FileDiff[];
  baselineJustCaptured: boolean;
}

export interface ExecutorDiffResult {
  files: FileDiff[];
  mode: 'git' | 'vfs-baseline';
  baselineJustCaptured?: boolean;
  notGitRepo?: boolean;
  error?: string;
}

/**
 * Visit every workspace text file the change-set considers, one body at a time.
 *
 * The visitor shape is the whole point. A 400-file workspace of 256 KiB files
 * is 102 MiB, and the previous code held that map, the materialized baseline
 * and the diff output live at once — three copies, in an isolate whose
 * silent-reset wall is `PLATFORM_CATALOG['do.isolate.reset_silent']` and whose
 * breach throws and logs nothing. Exactly one body is live here.
 *
 * Skips directories, binary files (NUL byte) and anything oversized; caps the
 * admitted file count. Binary and oversized files are skipped BEFORE the cap is
 * counted, so a tree of blobs cannot exhaust the text budget.
 */
export async function walkWorkspaceTextFiles(
  rt: AgentRuntime,
  visit: (path: string, content: string) => void | Promise<void>,
): Promise<void> {
  let admitted = 0;
  // Breadth-first, with direct files before child directories. A large nested
  // tree can never hide the authored files beside it at the workspace root.
  const directories = [''];
  while (directories.length > 0) {
    const dir = directories.shift()!;
    const children: string[] = [];
    let names: string[];
    try {
      names = (await rt.storage.vfs.readdir(dir)).sort();
    } catch (error) {
      throw new Error(`Workspace snapshot could not read directory ${JSON.stringify(dir || '.')}`, { cause: error });
    }
    for (const name of names) {
      if (SNAPSHOT_IGNORED_DIRECTORIES.has(name)) continue;
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
      if (st.size > MAX_SNAPSHOT_FILE_BYTES) continue;
      let content: string | Uint8Array;
      try {
        content = await rt.storage.vfs.readFile(full, { encoding: 'utf8' });
      } catch (error) {
        throw new Error(`Workspace snapshot could not read ${JSON.stringify(full)}`, { cause: error });
      }
      const fileText = content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
      if (fileText.includes(String.fromCharCode(0))) continue;
      if (admitted === MAX_SNAPSHOT_FILES) {
        throw new Error(`Workspace snapshot exceeds the ${MAX_SNAPSHOT_FILES}-file Output limit`);
      }
      admitted++;
      await visit(full, fileText);
    }
    directories.push(...children);
  }
}

/** The generation the change-set reads. Pinned once so the per-path content
 *  reads below cannot straddle a concurrent re-baseline. */
function activeBaselineGeneration(rt: AgentRuntime): string | null {
  return rt.storage.sql<{ generation: string }>`
    SELECT generation FROM vfs_baseline WHERE active = 1 LIMIT 1`[0]?.generation ?? null;
}

/** One baseline body, by primary key. Reading these one at a time is what
 *  keeps the whole baseline out of the isolate. */
function baselineContent(rt: AgentRuntime, generation: string, path: string): string {
  const row = rt.storage.sql<{ content: string }>`
    SELECT content FROM vfs_baseline
    WHERE generation = ${generation} AND path = ${path} LIMIT 1`[0];
  // The generation was pinned from the active row, so a missing body means a
  // re-baseline landed mid-read. Saying so lets the caller read again; assuming
  // an empty baseline would report the whole file as newly added.
  if (!row) {
    throw new Error(
      `Workspace baseline changed while reading the change-set (generation ${generation}, path ${JSON.stringify(path)})`,
    );
  }
  return row.content;
}

/**
 * The cumulative workspace change-set since the baseline.
 *
 * Streams: one current body and one baseline body are live at a time, and only
 * the bounded diff accumulates. Nothing here scales with the workspace's total
 * size.
 */
export async function getWorkspaceDiff(rt: AgentRuntime): Promise<WorkspaceDiffResult> {
  const generation = activeBaselineGeneration(rt);
  const unseenBaselinePaths = new Set(
    generation === null
      ? []
      : rt.storage.sql<{ path: string }>`
          SELECT path FROM vfs_baseline
          WHERE generation = ${generation} AND path <> ''`.map((r) => r.path),
  );

  const files: FileDiff[] = [];
  let bodyChars = 0;
  const admit = (path: string, status: FileStatus, before: string, after: string): void => {
    const d = diffLines(before, after);
    if (bodyChars >= MAX_CHANGESET_BODY_CHARS) {
      files.push(fileDiff(path, status, { lines: [], added: d.added, removed: d.removed, truncated: true }));
      return;
    }
    for (const l of d.lines) bodyChars += l.text.length;
    files.push(fileDiff(path, status, d));
  };

  await walkWorkspaceTextFiles(rt, (path, after) => {
    if (generation !== null && unseenBaselinePaths.delete(path)) {
      const before = baselineContent(rt, generation, path);
      if (before !== after) admit(path, 'changed', before, after);
      return;
    }
    admit(path, 'added', '', after);
  });
  // Whatever the baseline still holds was not found in the workspace.
  if (generation !== null) {
    for (const path of unseenBaselinePaths) admit(path, 'removed', baselineContent(rt, generation, path), '');
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, baselineJustCaptured: false };
}

/**
 * Mark the current workspace as the new baseline — the diff resets to empty and
 * accrues from here.
 *
 * Rows are written under an inactive generation as the walk produces them, then
 * one SQLite statement flips the whole table to that generation, so no read ever
 * sees a partial replacement. A failed insert leaves the previous generation
 * active and the error reaches the caller unchanged. The walk awaits between
 * inserts, which other work can interleave with; that is safe for exactly the
 * reason the inactive generation exists — nothing reads it until the flip.
 */
export async function resetWorkspaceBaseline(rt: AgentRuntime): Promise<{ ok: true; files: number }> {
  const generation = nanoid();
  let files = 0;
  try {
    // The marker makes an intentionally empty snapshot representable.
    void rt.storage.sql`INSERT INTO vfs_baseline (generation, path, content, active)
      VALUES (${generation}, ${''}, ${''}, ${0})`;
    await walkWorkspaceTextFiles(rt, (path, content) => {
      void rt.storage.sql`INSERT INTO vfs_baseline (generation, path, content, active)
        VALUES (${generation}, ${path}, ${content}, ${0})`;
      files++;
    });
    void rt.storage.sql`UPDATE vfs_baseline
      SET active = CASE WHEN generation = ${generation} THEN 1 ELSE 0 END`;
  } finally {
    // One sweep for both outcomes, and the reason there is no catch here: after
    // a successful flip the only inactive rows are the generations this one
    // replaced, and after a failure they are this one's own partial write, which
    // no read can see and nothing will ever finish. Deleting them cannot change
    // what the caller is told, so the original error propagates untouched.
    void rt.storage.sql`DELETE FROM vfs_baseline WHERE active = 0`;
  }
  return { ok: true, files };
}

/** Read tracked, staged and untracked changes without writing the repository's
 * index. `git diff --no-index` renders untracked files directly from the work
 * tree; unlike `git add -N`, repeated Output polling cannot contend on
 * `.git/index.lock` or alter a later commit. */
async function getGitDiff(rt: AgentRuntime, executorId: string): Promise<ExecutorDiffResult> {
  const provider = rt.executionRouter?.getProvider(executorId);
  if (!provider) return { files: [], mode: 'git', error: `Executor "${executorId}" not found` };
  const execTool = provider.tools.exec;
  if (!execTool) return { files: [], mode: 'git', error: `Executor "${executorId}" has no exec tool` };
  try {
    // Keep the two git streams separate: the first is a unified diff; the
    // second is a NUL-delimited path list that must be rendered one file at a
    // time. A single shell pipeline would mix binary NULs into the diff.
    const root = String(await execTool.execute(
      `git rev-parse --show-toplevel 2>/dev/null || printf '${NOT_GIT_REPO}'`,
    )).trim();
    if (root === NOT_GIT_REPO) return { files: [], mode: 'git', notGitRepo: true };
    if (isFailingResultText(root)) return { files: [], mode: 'git', error: root };

    const quotedRoot = `'${root.replace(/'/g, `'\\''`)}'`;
    const headOutput = String(await execTool.execute(
      `git -C ${quotedRoot} rev-parse --verify HEAD >/dev/null 2>&1 && printf yes || printf no`,
    )).trim();
    if (isFailingResultText(headOutput)) return { files: [], mode: 'git', error: headOutput };
    if (headOutput !== 'yes' && headOutput !== 'no') {
      return { files: [], mode: 'git', error: `Unexpected git HEAD probe output: ${headOutput}` };
    }
    const hasHead = headOutput === 'yes';
    const tracked = hasHead
      ? String(await execTool.execute(
          `git -C ${quotedRoot} --no-pager diff --no-ext-diff --no-renames HEAD --`,
        ))
      : '';
    if (isFailingResultText(tracked)) return { files: [], mode: 'git', error: tracked };
    const pathScope = hasHead ? '--others' : '--cached --others';
    const untracked = String(await execTool.execute(
      `git -C ${quotedRoot} ls-files ${pathScope} --exclude-standard -z`,
    ));
    if (isFailingResultText(untracked)) return { files: [], mode: 'git', error: untracked };
    const untrackedDiff = untracked === '(no output)'
      ? ''
      : String(await execTool.execute(
          `git -C ${quotedRoot} ls-files ${pathScope} --exclude-standard -z | ` +
          `xargs -0 -n 1 sh -c '[ -z "$2" ] || git -C "$1" --no-pager diff --no-index --no-ext-diff --no-renames -- /dev/null "$2" || test "$?" -eq 1' sh ${quotedRoot}`,
        ));
    if (isFailingResultText(untrackedDiff)) return { files: [], mode: 'git', error: untrackedDiff };
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
    return { files: r.files, mode: 'vfs-baseline', baselineJustCaptured: r.baselineJustCaptured };
  }
  return getGitDiff(rt, executorId);
}
