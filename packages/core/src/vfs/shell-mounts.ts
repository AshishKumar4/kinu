/** The shell's side of the one file plane (docs/EXECUTION-LAYER-SPEC.md). */
import * as v from 'valibot';
import { SqliteFilesystemAuthority } from '@nimbus-sh/core/runtime/filesystem-authority.js';
import { VFSError } from '@nimbus-sh/core/substrate/lifo/kernel/vfs/types.js';
import type {
  NimbusFilesystemAuthority, NimbusFilesystemBinding, NimbusHostFilesystemLease, RuntimeFileHandle, RuntimeFsBridge,
  RuntimeFsPath, RuntimeOpenFlags, RuntimeReadOptions, RuntimeVfsDirEntry, RuntimeVfsStat, VfsCred, VfsMutationReceipt,
} from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { VfsEntryStat } from '../types/primitives';
import { tolerateAsync } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import { makeVfsError } from './errno';
import type { MountedVfs } from './mounts';

export type ShellMountTable = (cred: Readonly<VfsCred>) => MountedVfs | null;

/** Nimbus's facet manager requires the SQLite authority (`instanceof`). */
export function mountedAuthority(base: NimbusFilesystemAuthority, table: ShellMountTable): NimbusFilesystemAuthority {
  if (!(base instanceof SqliteFilesystemAuthority)) {
    throw new Error('shell mounts extend the session SQLite authority, and this workspace supplied another');
  }

  return new MountedAuthority(base.vfs, table);
}

class MountedAuthority extends SqliteFilesystemAuthority {
  constructor(vfs: SqliteVFS, private readonly table: ShellMountTable) {
    super(vfs);
  }

  override bind(binding: NimbusFilesystemBinding): RuntimeFsBridge {
    return new MountRoutedBridge(super.bind(binding), () => this.table(binding.cred), binding.cred);
  }

  override openHost(cred: Readonly<VfsCred>, options?: { signal?: AbortSignal }): NimbusHostFilesystemLease {
    const lease = super.openHost(cred, options);

    return { fs: new MountRoutedBridge(lease.fs, () => this.table(cred), cred), dispose: () => lease.dispose() };
  }
}

interface MountRoute {
  readonly plane: MountedVfs;
  readonly mount: string;
  readonly path: string;
}

interface MountDescriptor {
  readonly at: MountRoute;
  readonly directory: boolean;
  readonly writable: boolean;
  append: boolean;
  position: number;
  content: Uint8Array | null;
  dirty: boolean;
  refs: number;
}

const MOUNT_DESCRIPTOR_BASE = 2 ** 30;

function normalAbsolute(path: string): string {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment === '..') segments.pop();
    else segments.push(segment);
  }

  return `/${segments.join('/')}`;
}

function beneath(base: string, relative: string, confined: boolean): string {
  const joined = normalAbsolute(`${base}/${relative}`);

  if (confined && joined !== base && !joined.startsWith(`${base}/`)) {
    throw makeVfsError('EPERM', `the path climbs out of ${base}, the directory it resolves beneath`, joined);
  }

  return joined;
}

function numberOf(name: string): number {
  return Number.parseInt(sha256Hex(name, 8), 16) || 1;
}

function splice(content: Uint8Array, offset: number, bytes: Uint8Array): Uint8Array {
  const next = new Uint8Array(Math.max(content.length, offset + bytes.length));
  next.set(content.subarray(0, Math.min(content.length, next.length)), 0);
  next.set(bytes, offset);

  return next;
}

function resized(content: Uint8Array, size: number): Uint8Array {
  const next = new Uint8Array(size);
  next.set(content.subarray(0, Math.min(content.length, size)), 0);

  return next;
}

function absentAsNull<T>(read: () => Promise<T>): Promise<T | null> {
  return tolerateAsync(read, 'enoent').then((value) => value ?? null);
}

function unsupported(path: string, what: string): Error {
  return makeVfsError('ENOTSUP', `a mounted plane keeps no ${what}`, path);
}

class MountRoutedBridge implements RuntimeFsBridge {
  private readonly descriptors = new Map<number, MountDescriptor>();
  private nextDescriptor = MOUNT_DESCRIPTOR_BASE;
  /** Serves the stats `ls` makes right after a listing. */
  private readonly listings = new Map<string, ReadonlyMap<string, VfsEntryStat | null>>();

  constructor(
    private readonly inner: RuntimeFsBridge,
    private readonly plane: () => MountedVfs | null,
    private readonly cred: Readonly<VfsCred>,
  ) {}

  get synchronous(): RuntimeFsBridge['synchronous'] {
    return this.inner.synchronous;
  }

  /** Relative is root-relative, as the durable bridge reads it. */
  private route(path: RuntimeFsPath): MountRoute | null {
    const absolute = this.absolute(path);

    if (absolute === null) return null;
    const plane = this.plane();
    const mount = plane?.mountOf(absolute) ?? null;

    return plane && mount !== null ? { plane, mount, path: absolute } : null;
  }

  private absolute(path: RuntimeFsPath): string | null {
    if (v.is(v.string(), path)) return normalAbsolute(path);

    if (path.path.startsWith('/')) return normalAbsolute(path.path);

    if ('root' in path) return path.root.startsWith('/') ? beneath(normalAbsolute(path.root), path.path, true) : null;
    const directory = this.descriptors.get(path.directory);

    return directory === undefined ? null : beneath(directory.at.path, path.path, path.beneath === true);
  }

  private onPath<T>(path: RuntimeFsPath, durable: () => T, mounted: (at: MountRoute) => T): T {
    const at = this.route(path);

    return at === null ? durable() : mounted(at);
  }

  private onDescriptor<T>(handleId: number, durable: () => T, mounted: (descriptor: MountDescriptor) => T): T {
    const descriptor = this.descriptors.get(handleId);

    return descriptor === undefined ? durable() : mounted(descriptor);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.listings.clear();

    return operation();
  }

  private runtimeStat(at: MountRoute, stat: VfsEntryStat): RuntimeVfsStat {
    const mtime = Math.trunc(stat.mtimeMs);

    return {
      dev: numberOf(`mount:${at.mount}`),
      ino: numberOf(at.path),
      nlink: 1,
      type: stat.isDir ? 'directory' : 'file',
      size: stat.size,
      ctime: mtime,
      atime: mtime,
      mtime,
      mode: stat.isDir ? 0o40755 : 0o100644,
      uid: this.cred.uid,
      gid: this.cred.gid,
      revision: mtime,
    };
  }

  private async statAt(at: MountRoute): Promise<RuntimeVfsStat | null> {
    const slash = at.path.lastIndexOf('/');
    const listed = this.listings.get(at.path.slice(0, slash) || '/')?.get(at.path.slice(slash + 1));
    const stat = listed === undefined ? await at.plane.stat(at.path) : listed;

    return stat === null ? null : this.runtimeStat(at, stat);
  }

  private async existing(at: MountRoute): Promise<VfsEntryStat> {
    const stat = await at.plane.stat(at.path);

    if (stat === null) throw makeVfsError('ENOENT', 'no such file or directory', at.path);

    return stat;
  }

  private async bytesOf(at: MountRoute): Promise<Uint8Array> {
    const raw = await at.plane.readFile(at.path);

    return raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
  }

  private async revisionAt(at: MountRoute): Promise<number> {
    return (await this.statAt(at))?.revision ?? 0;
  }

  private async receipt(at: MountRoute, operation: () => Promise<void>): Promise<VfsMutationReceipt> {
    const before = await this.revisionAt(at);
    await this.mutate(operation);

    return { before, after: await this.revisionAt(at) };
  }

  private async listAt(at: MountRoute): Promise<RuntimeVfsDirEntry[]> {
    const listed = await at.plane.readdirStats(at.path);
    const stats = new Map(listed.map((entry) => [entry.name, entry.stat]));
    this.listings.set(at.path, stats);
    setTimeout(() => {
      if (this.listings.get(at.path) === stats) this.listings.delete(at.path);
    }, 0);

    return listed.flatMap(({ name, stat }) => (stat === null ? [] : [{ name, type: stat.isDir ? 'directory' : 'file' }]));
  }

  private async withMountPoints(listed: RuntimeVfsDirEntry[] | Promise<RuntimeVfsDirEntry[]>, points: readonly string[]): Promise<RuntimeVfsDirEntry[]> {
    const entries = await listed;
    const named = new Set(entries.map((entry) => entry.name));

    return [...entries, ...points.filter((name) => !named.has(name)).map((name): RuntimeVfsDirEntry => ({ name, type: 'directory' }))];
  }

  private async readWhole(path: RuntimeFsPath): Promise<Uint8Array> {
    const at = this.route(path);

    if (at !== null) return this.bytesOf(at);
    const bytes = await this.inner.readFile(path);

    if (bytes === null) throw makeVfsError('ENOENT', 'no such file or directory', v.is(v.string(), path) ? path : path.path);

    return bytes;
  }

  private async writeWhole(path: RuntimeFsPath, bytes: Uint8Array): Promise<void> {
    const at = this.route(path);

    if (at === null) {
      await this.inner.writeFile(path, bytes);

      return;
    }

    await this.mutate(() => at.plane.writeFile(at.path, bytes));
  }

  private handleOf(descriptor: MountDescriptor, flags: RuntimeFileHandle['flags']): RuntimeFileHandle {
    const id = this.nextDescriptor++;
    this.descriptors.set(id, descriptor);

    return { id, path: descriptor.at.path, flags, position: descriptor.position, closed: false };
  }

  private async contentOf(descriptor: MountDescriptor): Promise<Uint8Array> {
    descriptor.content ??= await this.bytesOf(descriptor.at);

    return descriptor.content;
  }

  private async flush(descriptor: MountDescriptor): Promise<void> {
    if (!descriptor.dirty || descriptor.content === null) return;
    const { at, content } = descriptor;
    await this.mutate(() => at.plane.writeFile(at.path, content));
    descriptor.dirty = false;
  }

  stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): ReturnType<RuntimeFsBridge['stat']> {
    return this.onPath(path, () => this.inner.stat(path, options), (at) => this.statAt(at));
  }

  readFile(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): ReturnType<RuntimeFsBridge['readFile']> {
    return this.onPath(path, () => this.inner.readFile(path, options), (at) => absentAsNull(() => this.bytesOf(at)));
  }

  writeFile(
    path: RuntimeFsPath, bytes: string | Uint8Array, options?: { createParents?: boolean; expectedRevision?: number },
  ): ReturnType<RuntimeFsBridge['writeFile']> {
    return this.onPath(path, () => this.inner.writeFile(path, bytes, options), (at) => {
      if (options?.expectedRevision !== undefined) throw unsupported(at.path, 'revision to compare a write against');

      return this.mutate(async () => {
        if (options?.createParents === true) await at.plane.mkdir(at.path.slice(0, at.path.lastIndexOf('/')) || '/', { recursive: true });
        await at.plane.writeFile(at.path, bytes);

        return this.revisionAt(at);
      });
    });
  }

  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): ReturnType<RuntimeFsBridge['readRange']> {
    return this.onPath(path, () => this.inner.readRange(path, offset, length, options), (at) => {
      if (options?.expectedRevision !== undefined) throw unsupported(at.path, 'revision to compare a read against');

      return absentAsNull(() => at.plane.readRange(at.path, offset, length));
    });
  }

  writeRange(
    path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: { createParents?: boolean; expectedRevision?: number },
  ): ReturnType<RuntimeFsBridge['writeRange']> {
    return this.onPath(path, () => this.inner.writeRange(path, offset, bytes, options), (at) => {
      if (options?.expectedRevision !== undefined) throw unsupported(at.path, 'revision to compare a write against');

      return this.receipt(at, async () => {
        const current = await absentAsNull(() => this.bytesOf(at)) ?? new Uint8Array(0);
        await at.plane.writeFile(at.path, splice(current, offset, bytes));
      });
    });
  }

  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean }): ReturnType<RuntimeFsBridge['truncate']> {
    return this.onPath(path, () => this.inner.truncate(path, size, options), (at) => this.receipt(at, async () => {
      await at.plane.writeFile(at.path, resized(await this.bytesOf(at), size));
    }));
  }

  /** Accepted, changing nothing: cross-device `mv` needs it. */
  private async unchanged(at: MountRoute): Promise<VfsMutationReceipt> {
    const stat = await this.statAt(at);

    if (stat === null) throw makeVfsError('ENOENT', 'no such file or directory', at.path);

    return { before: stat.revision, after: stat.revision };
  }

  utimes(...args: Parameters<RuntimeFsBridge['utimes']>): ReturnType<RuntimeFsBridge['utimes']> {
    return this.onPath(args[0], () => this.inner.utimes(...args), (at) => this.unchanged(at));
  }

  chmod(...args: Parameters<RuntimeFsBridge['chmod']>): ReturnType<RuntimeFsBridge['chmod']> {
    return this.onPath(args[0], () => this.inner.chmod(...args), (at) => this.unchanged(at));
  }

  chown(...args: Parameters<RuntimeFsBridge['chown']>): ReturnType<RuntimeFsBridge['chown']> {
    return this.onPath(args[0], () => this.inner.chown(...args), (at) => this.unchanged(at));
  }

  access(path: RuntimeFsPath, mode: number): ReturnType<RuntimeFsBridge['access']> {
    return this.onPath(path, () => this.inner.access(path, mode), (at) => this.existing(at).then(() => undefined));
  }

  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): ReturnType<RuntimeFsBridge['open']> {
    return this.onPath(path, () => this.inner.open(path, flags), (at) => this.openAt(at, flags));
  }

  private async openAt(at: MountRoute, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle> {
    const stat = await at.plane.stat(at.path);
    const writable = flags.write === true || flags.append === true;

    if (stat === null && flags.create !== true) throw makeVfsError('ENOENT', 'no such file or directory', at.path);

    if (stat !== null && flags.create === true && flags.exclusive === true) throw makeVfsError('EEXIST', 'file exists', at.path);

    if (stat?.isDir === true && (writable || flags.truncate === true)) throw makeVfsError('EISDIR', 'is a directory', at.path);

    if (flags.directory === true && stat?.isDir !== true) throw makeVfsError('ENOTDIR', 'not a directory', at.path);

    const fresh = stat === null || (writable && flags.truncate === true);

    const descriptor: MountDescriptor = {
      at, directory: stat?.isDir === true, writable, append: flags.append === true, position: 0,
      content: fresh ? new Uint8Array(0) : null, dirty: fresh, refs: 1,
    };

    return this.handleOf(descriptor, {
      read: flags.read === true || !writable, write: writable, append: descriptor.append, create: flags.create === true,
      exclusive: flags.exclusive === true, directory: descriptor.directory, truncate: flags.truncate === true,
      followSymlinks: flags.followSymlinks !== false,
    });
  }

  read(handleId: number, offset: number | null, length: number): ReturnType<RuntimeFsBridge['read']> {
    return this.onDescriptor(handleId, () => this.inner.read(handleId, offset, length), (descriptor) => this.readAt(descriptor, offset, length));
  }

  private async readAt(descriptor: MountDescriptor, offset: number | null, length: number): Promise<Uint8Array> {
    if (descriptor.directory) throw makeVfsError('EISDIR', 'is a directory', descriptor.at.path);

    const at = offset ?? descriptor.position;

    const bytes = descriptor.content === null
      ? await descriptor.at.plane.readRange(descriptor.at.path, at, length)
      : descriptor.content.slice(at, at + length);

    if (offset === null) descriptor.position = at + bytes.length;

    return bytes;
  }

  write(handleId: number, offset: number | null, bytes: Uint8Array): ReturnType<RuntimeFsBridge['write']> {
    return this.onDescriptor(handleId, () => this.inner.write(handleId, offset, bytes), (descriptor) => this.writeAt(descriptor, offset, bytes));
  }

  private async writeAt(descriptor: MountDescriptor, offset: number | null, bytes: Uint8Array): Promise<number> {
    if (!descriptor.writable) throw makeVfsError('EPERM', 'the descriptor was opened for reading', descriptor.at.path);
    const content = await this.contentOf(descriptor);
    const at = descriptor.append ? content.length : offset ?? descriptor.position;
    descriptor.content = splice(content, at, bytes);
    descriptor.dirty = true;

    if (offset === null) descriptor.position = at + bytes.length;

    return bytes.length;
  }

  close(handleId: number): ReturnType<RuntimeFsBridge['close']> {
    return this.onDescriptor(handleId, () => this.inner.close(handleId), (descriptor) => {
      this.descriptors.delete(handleId);

      return --descriptor.refs > 0 ? undefined : this.flush(descriptor);
    });
  }

  readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): ReturnType<RuntimeFsBridge['readdir']> {
    return this.onPath(path, () => {
      const plane = this.absolute(path) === '/' ? this.plane() : null;
      const listed = this.inner.readdir(path, options);

      return plane === null ? listed : this.withMountPoints(listed, plane.mountPoints());
    }, (at) => this.listAt(at));
  }

  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number }): ReturnType<RuntimeFsBridge['mkdir']> {
    return this.onPath(path, () => this.inner.mkdir(path, options), (at) => this.mutate(() => at.plane.mkdir(at.path, { recursive: options?.recursive === true })));
  }

  unlink(path: RuntimeFsPath): ReturnType<RuntimeFsBridge['unlink']> {
    return this.onPath(path, () => this.inner.unlink(path), (at) => this.mutate(() => at.plane.unlink(at.path)));
  }

  rmdir(path: RuntimeFsPath): ReturnType<RuntimeFsBridge['rmdir']> {
    return this.onPath(path, () => this.inner.rmdir(path), (at) => this.mutate(async () => {
      if (!(await this.existing(at)).isDir) throw makeVfsError('ENOTDIR', 'not a directory', at.path);

      if ((await at.plane.readdir(at.path)).length > 0) throw makeVfsError('ENOTEMPTY', 'directory not empty', at.path);
      await at.plane.removeRecursive(at.path);
    }));
  }

  rename(from: RuntimeFsPath, to: RuntimeFsPath): ReturnType<RuntimeFsBridge['rename']> {
    const source = this.route(from);
    const target = this.route(to);

    if (source === null && target === null) return this.inner.rename(from, to);

    if (source === null || target === null || source.mount !== target.mount) {
      throw new VFSError('EXDEV', `${source?.path ?? String(this.absolute(from))} and ${target?.path ?? String(this.absolute(to))} are on different devices`);
    }

    return this.mutate(() => source.plane.rename(source.path, target.path));
  }

  readlink(path: RuntimeFsPath): ReturnType<RuntimeFsBridge['readlink']> {
    return this.onPath(path, () => this.inner.readlink(path), (at) => this.existing(at).then(() => null));
  }

  symlink(target: string, path: RuntimeFsPath): ReturnType<RuntimeFsBridge['symlink']> {
    return this.onPath(path, () => this.inner.symlink(target, path), (at) => { throw unsupported(at.path, 'symlinks'); });
  }

  fsync(handleId?: number): ReturnType<RuntimeFsBridge['fsync']> {
    const descriptor = handleId === undefined ? undefined : this.descriptors.get(handleId);

    return descriptor === undefined ? this.inner.fsync(handleId) : this.flush(descriptor);
  }

  revision(path?: RuntimeFsPath): ReturnType<RuntimeFsBridge['revision']> {
    const at = path === undefined ? null : this.route(path);

    return at === null ? this.inner.revision(path) : this.revisionAt(at);
  }

  acquire(...args: Parameters<RuntimeFsBridge['acquire']>): ReturnType<RuntimeFsBridge['acquire']> {
    return this.inner.acquire(...args);
  }

  list(...args: Parameters<RuntimeFsBridge['list']>): ReturnType<RuntimeFsBridge['list']> {
    return this.inner.list(...args);
  }

  subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void {
    return this.onPath(path, () => {
      if (!this.inner.subscribe) throw unsupported(path, 'change feed');

      return this.inner.subscribe(path, listener);
    }, (at) => { throw unsupported(at.path, 'change feed'); });
  }

  realpath(path: RuntimeFsPath): ReturnType<RuntimeFsBridge['realpath']> {
    return this.onPath(path, () => this.inner.realpath(path), (at) => this.existing(at).then(() => at.path));
  }

  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean }): ReturnType<RuntimeFsBridge['remove']> {
    return this.onPath(path, () => this.inner.remove(path, options), (at) => this.mutate(async () => {
      const stat = await at.plane.stat(at.path);

      if (stat === null) {
        if (options?.force === true) return;
        throw makeVfsError('ENOENT', 'no such file or directory', at.path);
      }

      if (!stat.isDir) return at.plane.unlink(at.path);

      if (options?.recursive !== true) throw makeVfsError('EISDIR', 'is a directory', at.path);
      await at.plane.removeRecursive(at.path);
    }));
  }

  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): ReturnType<RuntimeFsBridge['copyFile']> {
    if (this.route(from) === null && this.route(to) === null) return this.inner.copyFile(from, to);

    return this.readWhole(from).then((bytes) => this.writeWhole(to, bytes));
  }

  fstat(handleId: number): ReturnType<RuntimeFsBridge['fstat']> {
    return this.onDescriptor(handleId, () => this.inner.fstat(handleId), async (descriptor) => {
      const stored = await descriptor.at.plane.stat(descriptor.at.path) ?? { size: 0, mtimeMs: Date.now(), isDir: false };

      return this.runtimeStat(descriptor.at, descriptor.content === null ? stored : { ...stored, size: descriptor.content.length });
    });
  }

  dup(handleId: number): ReturnType<RuntimeFsBridge['dup']> {
    return this.onDescriptor(handleId, () => this.inner.dup(handleId), (descriptor) => {
      descriptor.refs++;

      return this.handleOf(descriptor, {
        read: true, write: descriptor.writable, append: descriptor.append, create: false, exclusive: false,
        directory: descriptor.directory, truncate: false, followSymlinks: true,
      });
    });
  }

  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): ReturnType<RuntimeFsBridge['seek']> {
    return this.onDescriptor(handleId, () => this.inner.seek(handleId, offset, whence), async (descriptor) => {
      let origin = descriptor.position;

      if (whence === 'set') origin = 0;
      else if (whence === 'end') origin = descriptor.content?.length ?? (await this.existing(descriptor.at)).size;

      if (origin + offset < 0) throw new VFSError('EINVAL', `a seek to ${String(origin + offset)} in ${descriptor.at.path}`);
      descriptor.position = origin + offset;

      return descriptor.position;
    });
  }

  setStatus(handleId: number, status: { append?: boolean }): ReturnType<RuntimeFsBridge['setStatus']> {
    return this.onDescriptor(handleId, () => this.inner.setStatus(handleId, status), (descriptor) => {
      descriptor.append = status.append ?? descriptor.append;
    });
  }

  readdirHandle(handleId: number): ReturnType<RuntimeFsBridge['readdirHandle']> {
    return this.onDescriptor(handleId, () => this.inner.readdirHandle(handleId), (descriptor) => {
      if (!descriptor.directory) throw makeVfsError('ENOTDIR', 'not a directory', descriptor.at.path);

      return this.listAt(descriptor.at);
    });
  }

  ftruncate(handleId: number, size: number): ReturnType<RuntimeFsBridge['ftruncate']> {
    return this.onDescriptor(handleId, () => this.inner.ftruncate(handleId, size), async (descriptor) => {
      if (!descriptor.writable) throw makeVfsError('EPERM', 'the descriptor was opened for reading', descriptor.at.path);
      descriptor.content = resized(await this.contentOf(descriptor), size);
      descriptor.dirty = true;
    });
  }

  fchmod(...args: Parameters<RuntimeFsBridge['fchmod']>): ReturnType<RuntimeFsBridge['fchmod']> {
    return this.onDescriptor(args[0], () => this.inner.fchmod(...args), () => undefined);
  }

  fchown(...args: Parameters<RuntimeFsBridge['fchown']>): ReturnType<RuntimeFsBridge['fchown']> {
    return this.onDescriptor(args[0], () => this.inner.fchown(...args), () => undefined);
  }

  futimes(...args: Parameters<RuntimeFsBridge['futimes']>): ReturnType<RuntimeFsBridge['futimes']> {
    return this.onDescriptor(args[0], () => this.inner.futimes(...args), () => undefined);
  }

  appendOnce(...args: Parameters<RuntimeFsBridge['appendOnce']>): ReturnType<RuntimeFsBridge['appendOnce']> {
    return this.onPath(args[0], () => this.inner.appendOnce(...args), (at) => { throw unsupported(at.path, 'append journal'); });
  }

  acknowledgeAppend(...args: Parameters<RuntimeFsBridge['acknowledgeAppend']>): ReturnType<RuntimeFsBridge['acknowledgeAppend']> {
    return this.inner.acknowledgeAppend(...args);
  }

  writeBatch(...args: Parameters<RuntimeFsBridge['writeBatch']>): ReturnType<RuntimeFsBridge['writeBatch']> {
    return this.inner.writeBatch(...args);
  }

  writeStream(...args: Parameters<RuntimeFsBridge['writeStream']>): ReturnType<RuntimeFsBridge['writeStream']> {
    return this.inner.writeStream(...args);
  }

  acquireExclusiveMutation(
    ...args: Parameters<RuntimeFsBridge['acquireExclusiveMutation']>
  ): ReturnType<RuntimeFsBridge['acquireExclusiveMutation']> {
    return this.onPath(args[0], () => this.inner.acquireExclusiveMutation(...args), (at) => { throw unsupported(at.path, 'mutation lease'); });
  }

  releaseExclusiveMutation(
    ...args: Parameters<RuntimeFsBridge['releaseExclusiveMutation']>
  ): ReturnType<RuntimeFsBridge['releaseExclusiveMutation']> {
    return this.inner.releaseExclusiveMutation(...args);
  }
}
