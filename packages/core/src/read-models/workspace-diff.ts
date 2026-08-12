/**
 * The change-set read model — what the agent has actually changed, per
 * executor.
 *
 * Two planes, one answer shape. The agent VFS has no shell, so its change-set
 * is a snapshot baseline stored in `vfs_baseline` and diffed against a fresh
 * read. Shell executors have a real git repo, so theirs is a parsed `git diff`
 * of /workspace — the only way to see changes made inside a container.
 *
 * The baseline is captured lazily on the first read (which therefore reports
 * `baselineJustCaptured` and no files) and re-markable, which is what makes
 * "mark reviewed" work without a second store.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { computeWorkspaceDiff, parseGitDiff, type FileDiff } from '../vfs/diff.js';

/** Files bigger than this are excluded from the snapshot — a change-set is a
 *  review surface, not a backup. */
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_FILES = 400;

/** Where a shell executor's repo lives in every environment we drive. */
const EXECUTOR_REPO_ROOT = '/workspace';

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
  // Walked, not scanned: the snapshot is of the files the agent can open, so it
  // cannot go stale against however the filesystem encodes them.
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (paths.length >= MAX_SNAPSHOT_FILES) return;
    for (const name of await rt.storage.vfs.readdir(dir)) {
      if (paths.length >= MAX_SNAPSHOT_FILES) return;
      const full = dir === '' ? name : `${dir}/${name}`;
      const st = await rt.storage.vfs.stat(full);
      if (!st) continue;
      if (st.isDir) await walk(full);
      else paths.push(full);
    }
  };
  try { await walk(''); } catch { return out; }
  for (const path of paths) {
    try {
      const stat = await rt.storage.vfs.stat(path);
      if (stat && stat.size > MAX_SNAPSHOT_FILE_BYTES) continue;
      const content = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      if (text.includes(String.fromCharCode(0))) continue; // binary (NUL byte = binary)
      out[path] = text;
    } catch { /* unreadable — skip */ }
  }
  return out;
}

/** Replace the stored baseline with this snapshot. */
export function captureWorkspaceBaseline(rt: AgentRuntime, files: Record<string, string>): void {
  try {
    rt.storage.sql`DELETE FROM vfs_baseline`;
    for (const [path, content] of Object.entries(files)) {
      rt.storage.sql`INSERT OR REPLACE INTO vfs_baseline (path, content) VALUES (${path}, ${content})`;
    }
  } catch { /* table may not exist on very first start */ }
}

/** The cumulative workspace change-set since the baseline. */
export async function getWorkspaceDiff(rt: AgentRuntime): Promise<WorkspaceDiffResult> {
  const current = await readWorkspaceFiles(rt);
  let baselineRows: Array<{ path: string; content: string }> = [];
  try {
    baselineRows = rt.storage.sql<{ path: string; content: string }>`SELECT path, content FROM vfs_baseline`;
  } catch { baselineRows = []; }
  if (baselineRows.length === 0) {
    captureWorkspaceBaseline(rt, current);
    return { files: [], baselineJustCaptured: true };
  }
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

/**
 * Per-executor change-set. `git add -A -N` first so newly-created (untracked)
 * files show as additions; it stages intent-to-add only (no content), respects
 * .gitignore, and is cleared by the agent's next commit.
 */
export async function getExecutorDiff(rt: AgentRuntime, executorId: string): Promise<ExecutorDiffResult> {
  if (executorId === 'workspace') {
    const r = await getWorkspaceDiff(rt);
    return { files: r.files, mode: 'vfs-baseline', baselineJustCaptured: r.baselineJustCaptured };
  }
  const provider = rt.executionRouter?.getProvider(executorId);
  if (!provider) return { files: [], mode: 'git', error: `Executor "${executorId}" not found` };
  const execTool = provider.tools.exec;
  if (!execTool) return { files: [], mode: 'git', error: `Executor "${executorId}" has no exec tool` };
  try {
    const isRepo = String(await execTool.execute(
      `git -C ${EXECUTOR_REPO_ROOT} rev-parse --is-inside-work-tree 2>/dev/null || echo no`));
    if (!isRepo.includes('true')) return { files: [], mode: 'git', notGitRepo: true };
    const raw = String(await execTool.execute(
      `git -C ${EXECUTOR_REPO_ROOT} add -A -N >/dev/null 2>&1; git -C ${EXECUTOR_REPO_ROOT} --no-pager diff`));
    return { files: parseGitDiff(raw), mode: 'git' };
  } catch (err) {
    return { files: [], mode: 'git', error: err instanceof Error ? err.message : String(err) };
  }
}
