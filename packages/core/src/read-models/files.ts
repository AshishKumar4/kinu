/**
 * The file manager's read/write surface — one executor at a time.
 *
 * Each executor carries its OWN file view over its OWN raw handle
 * (`ExecutorProvider.files`), in that environment's native paths: the workspace
 * is Nimbus, the sandbox is its container, `laptop` is the user's machine. They
 * are separate filesystems and are addressed as such — there is no mount table
 * and no rewriting of one environment's paths into another's namespace.
 *
 * Errors are values here, not throws: a browser asking for a path on an offline
 * environment wants the reason rendered in the pane, not a failed RPC.
 */

import type { VFS } from '../types/primitives.js';

/** Just enough of the router to find one executor's files. */
export interface ExecutorFileLookup {
  getProvider(name: string): { files?: VFS } | undefined;
}

/**
 * One environment as the file browser lists it — the executor's own row, with
 * live state and how durable its filesystem is.
 *
 * `consistency` is the property a user has to know before writing anywhere:
 * `durable` survives everything, `ephemeral` dies with the container,
 * `live-shared` IS the user's own machine.
 */
export interface EnvironmentInfo {
  name: string;
  /** How the environment is addressed in its own namespace, e.g. `sandbox.*`. */
  prefix: string;
  live: boolean;
  policy: { readOnly: boolean; rootPath: string; consistency: 'durable' | 'ephemeral' | 'live-shared' };
  /** Working directory to open the browser at, or null when unavailable. */
  cwd: string | null;
  /** Why it is listed but not reachable; null when it is. */
  reason: string | null;
}

/** The name the workspace UI imports this row set by. */
export type MountInfo = EnvironmentInfo;

interface RuntimeConsistency {
  [runtime: string]: EnvironmentInfo['policy']['consistency'];
}

const CONSISTENCY: RuntimeConsistency = {
  workspace: 'durable', parent: 'durable', sandbox: 'ephemeral', nimbus: 'ephemeral', laptop: 'live-shared',
};

/** Enough of the router to list environments. */
export interface ExecutorRowLookup {
  listExecutors(): Array<{
    name: string; available: boolean; configured: boolean; reason?: string;
  }>;
  getProvider(name: string): { files?: VFS } | undefined;
}

/** One row per executor that HAS a filesystem — what the file browser lists. */
export function listEnvironments(router: ExecutorRowLookup): EnvironmentInfo[] {
  return router.listExecutors()
    .filter((exec) => router.getProvider(exec.name)?.files !== undefined || !exec.available)
    .map((exec) => ({
      name: exec.name,
      prefix: `${exec.name}.*`,
      live: exec.available && router.getProvider(exec.name)?.files !== undefined,
      policy: { readOnly: false, rootPath: '/', consistency: CONSISTENCY[exec.name] ?? 'ephemeral' },
      cwd: exec.available ? '.' : null,
      reason: exec.available ? null : (exec.reason ?? 'this environment is not available right now'),
    }));
}

/** One directory entry, normalized across executors (each provider's readdir
 *  has its own format). */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}

export type ExecutorWriteResult = { ok: true } | { error: string };

/** Read cap for the file viewer — past this the content is carried truncated. */
const MAX_VIEWABLE_BYTES = 512 * 1024;

/** The named executor's file view, or null when it has none (unknown id, or an
 *  environment with no browsable filesystem). */
export function executorFiles(router: ExecutorFileLookup, executorId: string): VFS | null {
  return router.getProvider(executorId)?.files ?? null;
}

/** Directories first, then files; alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Typed directory listing — off the executor's own raw handle, so types and
 *  sizes are the environment's real ones. */
export async function getExecutorFiles(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ entries?: DirEntry[]; error?: string }> {
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  const dir = path || '.';
  try {
    const names = await vfs.readdir(dir);
    const entries: DirEntry[] = [];
    for (const name of names) {
      const full = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
      let type: DirEntry['type'] = 'file';
      let size: number | undefined;
      try { const s = await vfs.stat(full); if (s) { type = s.isDir ? 'dir' : 'file'; size = s.size; } }
      catch { /* unstattable — keep the default */ }
      entries.push({ name, type, size });
    }
    return { entries: sortDirEntries(entries) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** One file's text content for the viewer. Caps size and refuses binary. */
export async function readExecutorFile(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ content?: string; truncated?: boolean; error?: string }> {
  if (!path) return { error: 'path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  const target = path;
  try {
    const stat = await vfs.stat(target);
    if (stat?.isDir) return { error: 'path is a directory' };
    const raw = await vfs.readFile(target, { encoding: 'utf8' });
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
    if (text.includes(String.fromCharCode(0))) return { error: 'binary file — not previewable' };
    if (text.length > MAX_VIEWABLE_BYTES) return { content: text.slice(0, MAX_VIEWABLE_BYTES), truncated: true };
    return { content: text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write one uploaded file into an executor — binary-safe through the same raw
 * handle the reads use.
 *
 * Raw bytes, and no size cap. Uploads arrive over a transport with no frame
 * ceiling and need no encoding, and the workspace VFS chunks what it stores —
 * so there is nothing left for an app-level limit to protect, and the one that
 * used to be here sat ABOVE the transport's real ceiling anyway.
 */
export async function writeExecutorFileOp(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
  bytes: Uint8Array,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith('/')) return { error: 'file path required' };
  const vfs = executorFiles(router, executorId);
  if (!vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    await vfs.writeFile(path, bytes);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
