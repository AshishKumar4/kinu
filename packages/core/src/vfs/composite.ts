/**
 * CompositeVFS — the workspace file plane.
 *
 * One VFS (the same 7 methods as `Storage.vfs`, primitives.ts) over a mount
 * table of environments:
 *
 *   /local    SqliteFS (durable base)     — always mounted, never unmounts
 *   /sandbox  container root              — dynamic (when configured)
 *   /nimbus   Nimbus sandbox root         — dynamic (when provisioned)
 *   /pc       user's device root          — dynamic (when connected + consented)
 *
 * Each mount's file view is a VFS adapter over the executor's RAW handle
 * (never its LLM tools — those return error strings). A mount's root maps to
 * the environment's REAL root (`policy.rootPath`), so absolute environment
 * paths stay reachable — a faithful window, not a lossy rewrite.
 *
 * Addressing: relative paths resolve against the composite `cwd` (default
 * /local); absolute non-mount paths compat-route to /local so pre-composite
 * callers (`writeFile('scaffold/agent.js')`, `writeFile('/src/main.ts')`)
 * keep working byte-identically.
 *
 * Resolution does its OWN dot-segment cleaning that PRESERVES the leading
 * slash and the mount prefix — agent-utils' normalizePath strips the leading
 * slash and must never see a prefixed composite path.
 */

import type { VFS } from '../types/primitives.js';
import { makeVfsError, isVfsError, type VfsError } from './errno.js';

export type MountConsistency = 'durable' | 'ephemeral' | 'live-shared';

/** Executor name → its composite mount prefix. The prompt's mount doctrine,
 *  the file-manager upload seam, and the backend mount wiring share this one
 *  map (the workspace executor's VFS IS the composite, so it has no row). */
export const EXECUTOR_MOUNT_PREFIX: Readonly<Record<string, string>> = {
  sandbox: '/sandbox',
  nimbus: '/nimbus',
  laptop: '/pc',
};

/** Declared, inspectable per-mount semantics (not tribal knowledge). */
export interface MountPolicy {
  readOnly: boolean;
  /**
   * Environment-native path the mount root maps onto. '/' exposes the
   * environment's real root; '' is the SqliteFS root (relative addressing).
   */
  rootPath: string;
  /** durable (survives everything) / ephemeral (dies with the container) /
   *  live-shared (the user's own machine — shared with them, live). */
  consistency: MountConsistency;
}

export interface MountSpec {
  /** VFS over the environment's raw handle. Receives environment-NATIVE paths. */
  vfs: VFS;
  policy: MountPolicy;
  /** Evaluated per access — dynamic environments appear/disappear without
   *  remounting. Default: always live. */
  live?: () => boolean;
  /** Environment-native working directory (e.g. '/workspace') — the ergonomic
   *  default cwd for actors entering this mount, and UI metadata. */
  workingDir?: string;
}

/** One row of the mount-table data surface (file-manager UI, cross-env copy). */
export interface MountInfo {
  name: string;
  /** Composite prefix, e.g. '/sandbox'. */
  prefix: string;
  live: boolean;
  policy: MountPolicy;
  /** Composite-addressed working dir (e.g. '/sandbox/workspace'); null for
   *  reserved-but-unavailable rows. */
  cwd: string | null;
  /** Why the name is reserved but not mounted; null for real mounts. */
  reason: string | null;
}

/**
 * Clean '.'/'..'/'//' segments of an absolute composite path, PRESERVING the
 * leading slash. '..' above root clamps at root (chroot semantics).
 */
export function cleanAbsolutePath(abs: string): string {
  const out: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

type MountRow =
  | { kind: 'mount'; vfs: VFS; policy: MountPolicy; live: () => boolean; workingDir: string }
  | { kind: 'reserved'; policy: MountPolicy; reason: string };

export type ResolvedPath =
  /** The synthetic '/' itself. */
  | { kind: 'root' }
  /** A single top-level segment at '/' that is not a mount name. */
  | { kind: 'rootEntry'; name: string }
  /** A reserved/registered mount that is not currently available. */
  | { kind: 'unavailable'; name: string; reason: string }
  /** A path inside a mount; `sub` is the environment-native path and `abs` the
   *  canonical composite path (compat routes normalize to their /local alias,
   *  so one file has one name however it was addressed). */
  | { kind: 'mount'; name: string; vfs: VFS; policy: MountPolicy; sub: string; abs: string; isMountRoot: boolean };

/** A write or delete that landed on the composite, reported to an observer. */
export interface CompositeWriteEvent {
  /** Mount it landed on. 'local' is the agent's own base (and every compat
   *  route into it). */
  readonly mount: string;
  /** Canonical composite path — what the agent addresses the file by. */
  readonly path: string;
  /** Content before this write, or null when the path did not exist. Absent
   *  when the observer declined it (see {@link CompositeWriteObserver}). */
  readonly before?: string | Uint8Array | null;
  /** Content after. null for a delete. */
  readonly after: string | Uint8Array | null;
}

/**
 * Notified of every write and delete through this composite.
 *
 * The pre-write content is fetched only when `needsBaseline` says so, which is
 * what keeps this from costing a second read on every write: an observer that
 * accumulates a net change per path wants the content only the first time a
 * path is touched. When the read fails for any reason other than the file not
 * existing, nothing is reported for that write at all — an unknown baseline is
 * not a change of unknown size, it is a change this observer cannot describe.
 */
export interface CompositeWriteObserver {
  needsBaseline(path: string): boolean;
  record(event: CompositeWriteEvent): void;
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export class CompositeVFS implements VFS {
  /** The actor's working directory — composite-addressed, default '/local'. */
  readonly cwd: string;
  private readonly rows = new Map<string, MountRow>();
  private observer: CompositeWriteObserver | null = null;

  constructor(opts: { local: VFS; cwd?: string }) {
    this.rows.set('local', {
      kind: 'mount',
      vfs: opts.local,
      policy: { readOnly: false, rootPath: '', consistency: 'durable' },
      live: () => true,
      workingDir: '',
    });
    this.cwd = opts.cwd ?? '/local';
  }

  /**
   * Watch every write and delete through this plane. One observer, set by
   * whoever owns the plane's lifetime — a head's runtime installs its own so
   * the split can report which files that head changed, and nothing is watching
   * otherwise, which is what makes this free on the ordinary path.
   */
  observeWrites(observer: CompositeWriteObserver | null): void {
    this.observer = observer;
  }

  /** Attach (or replace a reservation for) a dynamic mount. */
  mount(name: string, spec: MountSpec): void {
    this.assertMountName(name);
    this.rows.set(name, {
      kind: 'mount',
      vfs: spec.vfs,
      policy: spec.policy,
      live: spec.live ?? (() => true),
      workingDir: spec.workingDir ?? spec.policy.rootPath,
    });
  }

  /**
   * Reserve a mount name that exists as a concept on this backend but is not
   * available (e.g. sandbox binding missing). Reserved names never
   * compat-route to /local — access yields a clear unavailability error, so a
   * later-configured environment can't be shadowed by silently-created local
   * files under the same prefix.
   */
  reserve(name: string, reason: string, policy: MountPolicy): void {
    this.assertMountName(name);
    if (this.rows.get(name)?.kind === 'mount') {
      throw new Error(`'${name}' is already mounted`);
    }
    this.rows.set(name, { kind: 'reserved', policy, reason });
  }

  unmount(name: string): void {
    if (name === 'local') throw new Error("'/local' is the writable base and never unmounts");
    this.rows.delete(name);
  }

  /** The mount-table data surface: every registered row with live state. */
  listMounts(): MountInfo[] {
    return [...this.rows.entries()].map(([name, row]) => ({
      name,
      prefix: `/${name}`,
      live: row.kind === 'mount' && row.live(),
      policy: row.policy,
      cwd: row.kind === 'mount' ? `/${name}${row.workingDir === '/' ? '' : row.workingDir}` : null,
      reason: row.kind === 'reserved' ? row.reason : null,
    }));
  }

  /**
   * The resolve algorithm. '/' is the synthetic read-only mount table; mount
   * names are reserved top-level identifiers, matched on segment boundaries
   * ('/sandboxes/x' does NOT hit '/sandbox'). Bare and deeper-absolute
   * non-mount paths compat-route to /local; a single top-level non-mount
   * segment is an entry of the synthetic root itself.
   */
  resolve(path: string): ResolvedPath {
    const abs = cleanAbsolutePath(path.startsWith('/') ? path : `${this.cwd}/${path}`);
    if (abs === '/') return { kind: 'root' };
    const slash = abs.indexOf('/', 1);
    const seg0 = slash === -1 ? abs.slice(1) : abs.slice(1, slash);
    const rest = slash === -1 ? '' : abs.slice(slash);
    const row = this.rows.get(seg0);
    if (row) {
      if (row.kind === 'reserved') return { kind: 'unavailable', name: seg0, reason: row.reason };
      if (!row.live()) {
        return {
          kind: 'unavailable', name: seg0,
          reason: `the ${seg0} environment is not available right now`,
        };
      }
      return {
        kind: 'mount', name: seg0, vfs: row.vfs, policy: row.policy,
        sub: envPath(row.policy.rootPath, rest), abs, isMountRoot: rest === '',
      };
    }
    if (rest === '') return { kind: 'rootEntry', name: seg0 };
    // COMPAT: bare and deeper-absolute non-mount paths belong to /local.
    return this.localCompat(abs);
  }

  /** The COMPAT routing itself: an absolute non-mount path read as its /local
   *  alias. `/src/main.ts` IS `/local/src/main.ts`. */
  private localCompat(abs: string): Extract<ResolvedPath, { kind: 'mount' }> {
    const local = this.rows.get('local') as Extract<MountRow, { kind: 'mount' }>;
    return {
      kind: 'mount', name: 'local', vfs: local.vfs, policy: local.policy,
      sub: envPath(local.policy.rootPath, abs), abs: `/local${abs}`, isMountRoot: false,
    };
  }

  // ── The 7 VFS methods ─────────────────────────────────────────────

  async readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string> {
    const r = this.demandResolved(path, 'open');
    if (r.kind === 'root') throw makeVfsError('EISDIR', `illegal operation on a directory, open '${path}'`, path);
    if (r.kind === 'rootEntry') throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
    return r.vfs.readFile(r.sub, opts);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const r = this.demandResolved(path, 'open');
    if (r.kind === 'root') throw makeVfsError('EISDIR', `illegal operation on a directory, open '${path}'`, path);
    if (r.kind === 'rootEntry') throw this.rootTableError(path);
    if (r.isMountRoot) throw makeVfsError('EISDIR', `illegal operation on a directory, open '${path}'`, path);
    this.assertWritable(r, path);
    this.assertNameNotReserved(r, 'open', path);
    const baseline = await this.baselineFor(r);
    await r.vfs.writeFile(r.sub, data);
    this.report(r, baseline, data);
  }

  async readdir(path: string): Promise<string[]> {
    const r = this.demandResolved(path, 'scandir');
    if (r.kind === 'root') {
      return [...this.rows.entries()]
        .filter(([, row]) => row.kind === 'mount' && row.live())
        .map(([name]) => name);
    }
    if (r.kind === 'rootEntry') throw makeVfsError('ENOENT', `no such file or directory, scandir '${path}'`, path);
    return r.vfs.readdir(r.sub);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
    const r = this.demandResolved(path, 'stat');
    if (r.kind === 'root') return { size: 0, mtimeMs: 0, isDir: true };
    if (r.kind === 'rootEntry') return null;
    // Core-VFS contract: a missing path stats as null. Mount adapters honour it
    // directly; SqliteFS (the /local leaf) throws ENOENT like Node — normalise
    // that one code here so every mount reads the same at the composite seam.
    try {
      return await r.vfs.stat(r.sub);
    } catch (err) {
      if (isVfsError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async unlink(path: string): Promise<void> {
    const r = this.demandResolved(path, 'unlink');
    if (r.kind === 'root') throw makeVfsError('EPERM', `operation not permitted, unlink '${path}'`, path);
    if (r.kind === 'rootEntry') throw this.rootTableError(path);
    if (r.isMountRoot) throw makeVfsError('EPERM', `cannot unlink the /${r.name} mount, unlink '${path}'`, path);
    this.assertWritable(r, path);
    const baseline = await this.baselineFor(r);
    await r.vfs.unlink(r.sub);
    this.report(r, baseline, null);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const r = this.demandResolved(path, 'mkdir');
    if (r.kind === 'root') return; // '/' always exists
    // A top-level non-mount name is the HEAD of the COMPAT namespace, not an
    // entry of the mount table: writeFile('/workspace/x') already lands in
    // /local/workspace, so mkdir('/workspace') has to be that same /local
    // mkdir. Refusing it broke every writer that creates parent directories
    // first (ensureDir → workspace.writeFile) on a path whose write would
    // then have succeeded. Creating a FILE at the root stays refused — that
    // one really would be a mount-table entry with no mount to live in.
    const target = r.kind === 'rootEntry' ? this.localCompat(`/${r.name}`) : r;
    if (target.isMountRoot) return; // the mount root always exists as a directory
    this.assertWritable(target, path);
    this.assertNameNotReserved(target, 'mkdir', path);
    return target.vfs.mkdir(target.sub, opts);
  }

  async exists(path: string): Promise<boolean> {
    const r = this.resolve(path);
    if (r.kind === 'root') return true;
    if (r.kind !== 'mount') return false;
    return r.vfs.exists(r.sub);
  }

  // ── internals ─────────────────────────────────────────────────────

  /**
   * What the observer should be told about the state before a mutation, or
   * null for "tell it nothing about this one".
   *
   * Null covers both the ordinary case (nobody is watching) and the honest
   * failure: the observer asked for a baseline and the read failed for a reason
   * other than the file not existing, so the mutation still happens and simply
   * goes unreported rather than being reported against a baseline we invented.
   */
  private async baselineFor(
    r: Extract<ResolvedPath, { kind: 'mount' }>,
  ): Promise<{ before?: string | Uint8Array | null } | null> {
    const observer = this.observer;
    if (!observer) return null;
    if (!observer.needsBaseline(r.abs)) return {};
    try {
      return { before: (await r.vfs.readFile(r.sub, { encoding: 'utf8' })) ?? null };
    } catch (err) {
      if (isVfsError(err) && err.code === 'ENOENT') return { before: null };
      return null;
    }
  }

  /** Hand a landed mutation to the observer. Called only AFTER the mount
   *  accepted it, so a failed write is never reported as a change. */
  private report(
    r: Extract<ResolvedPath, { kind: 'mount' }>,
    baseline: { before?: string | Uint8Array | null } | null,
    after: string | Uint8Array | null,
  ): void {
    if (!baseline) return;
    this.observer?.record({ mount: r.name, path: r.abs, ...baseline, after });
  }

  private demandResolved(path: string, op: string): Exclude<ResolvedPath, { kind: 'unavailable' }> {
    const r = this.resolve(path);
    if (r.kind === 'unavailable') {
      throw makeVfsError('ENXIO', `/${r.name} is not available (${r.reason}), ${op} '${path}'`, path);
    }
    return r;
  }

  private rootTableError(path: string): VfsError {
    return makeVfsError(
      'EROFS',
      `'/' is the workspace mount table; write under a mount (e.g. /local/x), '${path}'`,
      path,
    );
  }

  private assertWritable(r: Extract<ResolvedPath, { kind: 'mount' }>, path: string): void {
    if (r.policy.readOnly) {
      throw makeVfsError('EROFS', `/${r.name} is a read-only mount, write '${path}'`, path);
    }
  }

  /**
   * The residual shadowing collision: a top-level /local entry named like a
   * LIVE mount would read as a sibling of that mount in the owner's mental
   * model. Rejected at create time; the name frees up if the mount unmounts.
   */
  private assertNameNotReserved(r: Extract<ResolvedPath, { kind: 'mount' }>, op: string, path: string): void {
    if (r.name !== 'local' || r.sub.includes('/')) return;
    const row = this.rows.get(r.sub);
    if (row?.kind === 'mount' && row.live()) {
      throw makeVfsError('EEXIST', `name reserved for the ${r.sub} mount, ${op} '${path}'`, path);
    }
  }

  private assertMountName(name: string): void {
    if (name === 'local') throw new Error("'local' is the permanent writable base mount");
    if (!NAME_RE.test(name)) throw new Error(`invalid mount name '${name}'`);
  }
}

/** Map a mount-relative remainder ('' or '/x/y') onto the environment path. */
function envPath(rootPath: string, rest: string): string {
  if (rootPath === '') return rest.replace(/^\//, '');
  if (rootPath === '/') return rest === '' ? '/' : rest;
  return rest === '' ? rootPath : rootPath + rest;
}
