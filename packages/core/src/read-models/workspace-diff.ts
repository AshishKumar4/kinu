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

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { RawSqlExec } from '../types/primitives.js';
import { computeWorkspaceDiff, parseGitDiff, type FileDiff } from '../vfs/diff.js';
import { nanoid } from '../utils/nanoid.js';

/** Files bigger than this are excluded from the snapshot — a change-set is a
 *  review surface, not a backup. */
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_FILES = 400;
const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  '.git', '.proteus', '.cache', '.mypy_cache', '.pnpm-store', '.pytest_cache', '.venv',
  '__pycache__', 'node_modules', 'venv',
]);
const NOT_GIT_REPO = '__PROTEUS_NOT_GIT_REPO__';

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
 * The current workspace text files (path → content). Skips directories,
 * binary files (NUL byte) and anything oversized; caps the file count.
 */
export async function readWorkspaceFiles(rt: AgentRuntime): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
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
      let st: Awaited<ReturnType<typeof rt.storage.vfs.stat>>;
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
      if (Object.keys(out).length === MAX_SNAPSHOT_FILES) {
        throw new Error(`Workspace snapshot exceeds the ${MAX_SNAPSHOT_FILES}-file Output limit`);
      }
      out[full] = fileText;
    }
    directories.push(...children);
  }
  return out;
}

/**
 * Replace the stored baseline with this snapshot without exposing a partial
 * replacement. Rows are written under an inactive generation, then one SQLite
 * statement flips the whole table to that generation. A failed insert leaves
 * the previous generation active and the error reaches the caller.
 */
export function captureWorkspaceBaseline(rt: AgentRuntime, files: Record<string, string>): void {
  const generation = nanoid();
  try {
    void rt.storage.sql`DELETE FROM vfs_baseline WHERE active = 0`;
    // The marker makes an intentionally empty snapshot representable.
    void rt.storage.sql`INSERT INTO vfs_baseline (generation, path, content, active)
      VALUES (${generation}, ${''}, ${''}, ${0})`;
    for (const [path, content] of Object.entries(files)) {
      void rt.storage.sql`INSERT INTO vfs_baseline (generation, path, content, active)
        VALUES (${generation}, ${path}, ${content}, ${0})`;
    }
    void rt.storage.sql`UPDATE vfs_baseline
      SET active = CASE WHEN generation = ${generation} THEN 1 ELSE 0 END`;
  } catch (error) {
    // Cleanup is safe because the failed generation was never made active.
    try { void rt.storage.sql`DELETE FROM vfs_baseline WHERE generation = ${generation} AND active = 0`; } catch { /* preserve the original error */ }
    throw error;
  }
}

/** The cumulative workspace change-set since the baseline. */
export async function getWorkspaceDiff(rt: AgentRuntime): Promise<WorkspaceDiffResult> {
  const current = await readWorkspaceFiles(rt);
  const baselineRows = rt.storage.sql<{ path: string; content: string }>`
    SELECT path, content FROM vfs_baseline WHERE active = 1 AND path <> ''`;
  const baseline: Record<string, string> = {};
  for (const r of baselineRows) baseline[r.path] = r.content;
  return { files: computeWorkspaceDiff(baseline, current), baselineJustCaptured: false };
}

/** Mark the current workspace as the new baseline — the diff resets to empty
 *  and accrues from here. */
export async function resetWorkspaceBaseline(rt: AgentRuntime): Promise<{ ok: true; files: number }> {
  const current = await readWorkspaceFiles(rt);
  captureWorkspaceBaseline(rt, current);
  return { ok: true, files: Object.keys(current).length };
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
    if (isExecutorFailure(root)) return { files: [], mode: 'git', error: root };

    const quotedRoot = `'${root.replace(/'/g, `'\\''`)}'`;
    const headOutput = String(await execTool.execute(
      `git -C ${quotedRoot} rev-parse --verify HEAD >/dev/null 2>&1 && printf yes || printf no`,
    )).trim();
    if (isExecutorFailure(headOutput)) return { files: [], mode: 'git', error: headOutput };
    if (headOutput !== 'yes' && headOutput !== 'no') {
      return { files: [], mode: 'git', error: `Unexpected git HEAD probe output: ${headOutput}` };
    }
    const hasHead = headOutput === 'yes';
    const tracked = hasHead
      ? String(await execTool.execute(
          `git -C ${quotedRoot} --no-pager diff --no-ext-diff --no-renames HEAD --`,
        ))
      : '';
    if (isExecutorFailure(tracked)) return { files: [], mode: 'git', error: tracked };
    const pathScope = hasHead ? '--others' : '--cached --others';
    const untracked = String(await execTool.execute(
      `git -C ${quotedRoot} ls-files ${pathScope} --exclude-standard -z`,
    ));
    if (isExecutorFailure(untracked)) return { files: [], mode: 'git', error: untracked };
    const untrackedDiff = untracked === '(no output)'
      ? ''
      : String(await execTool.execute(
          `git -C ${quotedRoot} ls-files ${pathScope} --exclude-standard -z | ` +
          `xargs -0 -n 1 sh -c '[ -z "$2" ] || git -C "$1" --no-pager diff --no-index --no-ext-diff --no-renames -- /dev/null "$2" || test "$?" -eq 1' sh ${quotedRoot}`,
        ));
    if (isExecutorFailure(untrackedDiff)) return { files: [], mode: 'git', error: untrackedDiff };
    const unified = [tracked === '(no output)' ? '' : tracked, untrackedDiff === '(no output)' ? '' : untrackedDiff]
      .filter(Boolean).join('\n');
    return { files: parseGitDiff(unified), mode: 'git' };
  } catch (err) {
    return { files: [], mode: 'git', error: err instanceof Error ? err.message : String(err) };
  }
}

function isExecutorFailure(output: string): boolean {
  return /^(?:Error \(exit \d+\)|exec error:)/i.test(output.trim());
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
