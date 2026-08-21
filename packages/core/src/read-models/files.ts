/**
 * The file manager's read/write surface — one executor at a time.
 *
 * Each executor carries its OWN file view over its OWN raw handle
 * (`ExecutorProvider.files`), in that environment's native paths: the workspace
 * is Nimbus, the sandbox is its container, `laptop` is the user's machine. The
 * browser shows them one row at a time, never merged. (The AGENT-facing merge
 * is the workspace plane's mount table, `vfs/mounts.ts` — a different surface
 * with a different reader; nothing here rewrites one environment's paths into
 * another's namespace.)
 *
 * Errors are values here, not throws: a browser asking for a path on an offline
 * environment wants the reason rendered in the pane, not a failed RPC.
 */

import { normalizePath } from '@kinu.run/agent-utils';
import type { VFS } from '../types/primitives';
import { renderThrownChain } from '../obs/index';

/** Just enough of the router to find one executor's files, and to ask that
 *  environment where its own relative paths resolve. */
export interface ExecutorFileLookup {
  getProvider(name: string): { files?: VFS; homeDir(): Promise<string> } | undefined;
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
  policy: { readOnly: boolean; consistency: 'durable' | 'ephemeral' | 'live-shared' };
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

/** Enough of the router to list environments. Listing is a roster read and
 *  stays synchronous: where each environment's files START is answered by the
 *  listing call itself, which is the only call that has to resolve a path. */
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
      policy: { readOnly: false, consistency: CONSISTENCY[exec.name] ?? 'ephemeral' },
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

/** Read cap for the file viewer — past this the content is carried truncated.
 *  A `response` bound in the platform catalog's terms, applied after the whole
 *  file is already resident, so it protects the wire and not the isolate. The
 *  one constant in the tree that models peak resident bytes instead is
 *  `identity/archive.ts`'s page budget. */
const MAX_VIEWABLE_BYTES = 512 * 1024;

/** The named executor's file view, or null when it has none (unknown id, or an
 *  environment with no browsable filesystem). */
export function executorFiles(router: ExecutorFileLookup, executorId: string): VFS | null {
  return router.getProvider(executorId)?.files ?? null;
}

/**
 * Absolute-path arithmetic for the file plane — the ONE implementation, shared
 * by the listing here and by the browser that navigates it. `normalizePath`
 * already resolves `.`/`..` and refuses to climb above root; these three only
 * keep the leading slash it strips, so an absolute path stays absolute.
 */
export function normalizeDir(path: string): string {
  return `/${normalizePath(path)}`;
}

/** One child of a directory, absolute. */
export function joinDir(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** The directory above, which for the root is the root. */
export function parentDir(dir: string): string {
  return normalizeDir(`${dir}/..`);
}

/** Directories first, then files; alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Typed directory listing — off the executor's own raw handle, so types and
 * sizes are the environment's real ones.
 *
 * `path` is an absolute directory in that environment's own paths, or empty
 * for "wherever this environment starts". Either way the answer carries the
 * ABSOLUTE directory that was listed, so the browser never has to invent one:
 * the shape this replaced returned entries for a literal `'.'` reported as
 * every environment's working directory, and "go up one level" computed from
 * that token landed on the filesystem root instead of the directory above.
 */
export async function getExecutorFiles(
  router: ExecutorFileLookup,
  executorId: string,
  path: string,
): Promise<{ path?: string; entries?: DirEntry[]; error?: string }> {
  const provider = router.getProvider(executorId);
  const vfs = provider?.files;
  if (!provider || !vfs) return { error: `Executor "${executorId}" has no file plane` };
  try {
    const dir = path === '' ? await provider.homeDir() : normalizeDir(path);
    const names = await vfs.readdir(dir);
    const entries: DirEntry[] = [];
    for (const name of names) {
      // `stat` answers null for a path that is gone; anything it throws is the
      // file plane itself failing, and a listing that reported every entry as a
      // sizeless file would hide that behind a plausible directory.
      const s = await vfs.stat(joinDir(dir, name));
      entries.push({ name, type: s?.isDir ? 'dir' : 'file', size: s?.size });
    }
    return { path: dir, entries: sortDirEntries(entries) };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
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
    return { error: renderThrownChain({ cause: err }) };
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
    return { error: renderThrownChain({ cause: err }) };
  }
}
