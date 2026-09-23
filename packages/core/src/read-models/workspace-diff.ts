/**
 * Change-set read model per executor: read-only git diff where a repo exists, else a snapshot
 * baseline in `vfs_baseline`. Reads never mutate the baseline; "mark reviewed" re-baselines.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, VfsEntryStat } from '../types/primitives';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { diffLines, fileDiff, parseGitDiff, type FileDiff, type FileStatus } from '../vfs/diff';
import { nanoid } from '../utils/nanoid';
import * as v from 'valibot';
import { CommandResultSchema } from '../execution/exec-result';
import { KinuError, renderThrownChain } from '../obs/index';
import { isSystemManaged } from './files-plane';

/**
 * These two bound the response, not residency: their product is 100 MiB, near
 * `worker.isolate.memory` (128 MB) and `do.isolate.reset_silent`. `walkWorkspaceTextFiles` bounds
 * residency by holding one body at a time.
 */
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;

const MAX_SNAPSHOT_FILES = 400;

/** Quarter of the facet RPC ceiling: the reply is UTF-16 in the isolate plus per-line overhead.
 *  Files past it are listed with +/- counts and no body. */
const MAX_CHANGESET_BODY_CHARS = PLATFORM_CATALOG['do.facet.rpc_bytes'].limit.value / 4;

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  '.git', '.cache', '.mypy_cache', '.pnpm-store', '.pytest_cache', '.venv', '__pycache__', 'node_modules', 'venv',
]);

const NOT_GIT_REPO = '__KINU_NOT_GIT_REPO__';

export function initWorkspaceBaselineTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS vfs_baseline (
    actor_id   TEXT NOT NULL,
    generation TEXT NOT NULL,
    path       TEXT NOT NULL,
    content    TEXT NOT NULL,
    active     INTEGER NOT NULL CHECK (active IN (0, 1)),
    PRIMARY KEY (actor_id, generation, path)
  )`);
  // Active generation is per owner: a subordinate re-baselines its own tree independently.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_vfs_baseline_active
    ON vfs_baseline(actor_id, active)`);
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
 * Visit workspace text files one body at a time, bounding residency under
 * `PLATFORM_CATALOG['do.isolate.reset_silent']`. Binary and oversized files are skipped before the
 * file cap is counted.
 */
export async function walkWorkspaceTextFiles(
  rt: AgentRuntime,
  visit: (path: string, content: string) => void | Promise<void>,
): Promise<void> {
  let admitted = 0;
  // Breadth-first, direct files before child directories, so root files are never starved.
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

/** Pinned once so per-path reads cannot straddle a concurrent re-baseline. */
function activeBaselineGeneration(rt: AgentRuntime): string | null {
  rt.actor.assertCurrent();

  return rt.storage.sql<{ generation: string }>`
    SELECT generation FROM vfs_baseline
    WHERE actor_id = ${rt.actor.actorId} AND active = 1 LIMIT 1`[0]?.generation ?? null;
}

/** One baseline body by primary key, keeping the whole baseline out of the isolate. */
function baselineContent(rt: AgentRuntime, generation: string, path: string): string {
  rt.actor.assertCurrent();

  const row = rt.storage.sql<{ content: string }>`
    SELECT content FROM vfs_baseline
    WHERE actor_id = ${rt.actor.actorId} AND generation = ${generation}
      AND path = ${path} LIMIT 1`[0];

  // A missing body means a re-baseline landed mid-read; assuming empty would report the file as added.
  if (!row) {
    throw new Error(
      `Workspace baseline changed while reading the change-set (generation ${generation}, path ${JSON.stringify(path)})`,
    );
  }

  return row.content;
}

/** Cumulative change-set since the baseline; streams one current and one baseline body at a time. */
export async function getWorkspaceDiff(rt: AgentRuntime): Promise<WorkspaceDiffResult> {
  const generation = activeBaselineGeneration(rt);

  const unseenBaselinePaths = new Set(
    generation === null
      ? []
      : rt.storage.sql<{ path: string }>`
          SELECT path FROM vfs_baseline
          WHERE actor_id = ${rt.actor.actorId} AND generation = ${generation}
            AND path <> ''`.map((r) => r.path),
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
 * Mark the current workspace as the baseline. Rows go under an inactive generation, then one
 * statement flips it active, so no read sees a partial replacement.
 */
export async function resetWorkspaceBaseline(rt: AgentRuntime): Promise<{ ok: true; files: number }> {
  rt.actor.assertCurrent();
  const actorId = rt.actor.actorId;
  const generation = nanoid();
  let files = 0;

  try {
    // The marker makes an intentionally empty snapshot representable.
    void rt.storage.sql`INSERT INTO vfs_baseline (actor_id, generation, path, content, active)
      VALUES (${actorId}, ${generation}, ${''}, ${''}, ${0})`;
    await walkWorkspaceTextFiles(rt, (path, content) => {
      void rt.storage.sql`INSERT INTO vfs_baseline (actor_id, generation, path, content, active)
        VALUES (${actorId}, ${generation}, ${path}, ${content}, ${0})`;
      files++;
    });
    void rt.storage.sql`UPDATE vfs_baseline
      SET active = CASE WHEN generation = ${generation} THEN 1 ELSE 0 END
      WHERE actor_id = ${actorId}`;
  } finally {
    // Inactive rows are either replaced generations or this failed partial write; the error propagates.
    void rt.storage.sql`DELETE FROM vfs_baseline WHERE actor_id = ${actorId} AND active = 0`;
  }

  return { ok: true, files };
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

    return { files: r.files, mode: 'vfs-baseline', baselineJustCaptured: r.baselineJustCaptured };
  }

  return getGitDiff(rt, executorId);
}
