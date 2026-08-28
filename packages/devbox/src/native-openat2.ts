import { dlopen, ptr, read } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import { closeSync, constants as FS, fstatSync, openSync, readSync, writeSync } from 'node:fs';

const OPENAT2 = 437;
const MKDIRAT = 258;
const UNLINKAT = 263;
const LINKAT = 265;
const SYMLINKAT = 266;
const UTIMENSAT = 280;
const FCHOWNAT = 260;
const LSETXATTR = 189;
const FALLOCATE = 285;
const RENAMEAT2 = 316;
const FTRUNCATE = 77;
const LSEEK = 8;
const FSETXATTR = 190;
const FGETXATTR = 193;
const FLISTXATTR = 196;
const FREMOVEXATTR = 199;
const OPEN_HOW_BYTES = 24;
const AT_REMOVEDIR = 0x200;
const AT_EMPTY_PATH = 0x1000;
const AT_SYMLINK_NOFOLLOW = 0x100;
const O_CLOEXEC = 0o2000000;
const O_NOFOLLOW = 0o400000;
const O_PATH = 0o10000000;
const RESOLVE_NO_MAGICLINKS = 0x02;
const RESOLVE_NO_SYMLINKS = 0x04;
const RESOLVE_BENEATH = 0x08;
const RENAME_NOREPLACE = 1;
const RENAME_EXCHANGE = 2;
const RENAME_WHITEOUT = 4;
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
// The kernel's per-component NAME_MAX. packages/cli's NAME_MAX_BYTES states
// the same platform fact for attachment names; declared apart because the
// packages share no dependency edge, and each cites the platform, not the other.
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 4096;
const MAX_RANGE_BYTES = 512 * 1024;

type Syscall = (number: bigint, a1: bigint, a2: bigint, a3: bigint, a4: bigint, a5: bigint, a6: bigint) => bigint;
type ErrnoLocation = () => Pointer | null;

export interface SparseExtent {
  readonly offset: number;
  readonly length: number;
}

export interface BeneathParent {
  readonly fd: number;
  readonly name: string;
  close(): void;
}

export class BeneathError extends Error {
  readonly errno: number | undefined;

  constructor(operation: string, path: string, errno: number | undefined) {
    super(`${operation} refused ${path}: errno ${errno ?? 'unknown'}`);
    this.name = 'BeneathError';
    this.errno = errno;
  }
}

if (process.arch !== 'x64') throw new Error(`openat2 helper is not implemented for ${process.arch}`);

/* syscall is variadic in libc. Linux consumes the operation's arguments and
 * ignores the remaining register slots. Keeping it private prevents callers
 * from bypassing the retained-root confinement boundary. */
const libc = dlopen('libc.so.6', {
  syscall: { args: ['i64', 'i64', 'i64', 'i64', 'i64', 'i64', 'i64'], returns: 'i64' },
  __errno_location: { args: [], returns: 'ptr' },
});
// SAFETY: the preceding `dlopen` declaration constructs this symbol with seven
// signed 64-bit arguments and a signed 64-bit result, exactly `Syscall`.
const syscall = libc.symbols.syscall as Syscall;
// SAFETY: the preceding `dlopen` declaration constructs this symbol with no
// arguments and a pointer result, exactly `ErrnoLocation`.
const errnoLocation = libc.symbols.__errno_location as ErrnoLocation;

function pointer(bytes: Uint8Array): bigint {
  return BigInt(ptr(bytes));
}

function cstring(value: string): Uint8Array {
  return Buffer.from(`${value}\0`);
}

function errno(): number | undefined {
  const location = errnoLocation();
  return location === null ? undefined : read.i32(location);
}

function checkedRelativePath(path: string): void {
  if (path.length === 0 || path.startsWith('/') || path.includes('\0')) {
    throw new Error(`openat2 refused non-relative path: ${String(path)}`);
  }
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes >= MAX_PATH_BYTES) throw new Error(`openat2 refused non-relative path: ${path}`);
  for (const component of path.split('/')) {
    if (component.length === 0 || component === '.' || component === '..' || Buffer.byteLength(component) > MAX_NAME_BYTES) {
      throw new Error(`openat2 refused non-relative path: ${path}`);
    }
  }
}



function checkedXattrName(name: string): void {
  if (name.length === 0 || name.includes('\0') || Buffer.byteLength(name) > MAX_NAME_BYTES) {
    throw new Error(`invalid xattr name: ${name}`);
  }
}
function checkedOffset(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function checkedRange(offset: number, length: number): void {
  checkedOffset(offset, 'offset');
  checkedOffset(length, 'length');
  if (length > MAX_RANGE_BYTES || offset + length > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`range exceeds ${MAX_RANGE_BYTES} byte bound`);
  }
}

function call(number: number, operation: string, path: string, a1: bigint, a2 = 0n, a3 = 0n, a4 = 0n, a5 = 0n): bigint {
  const result = syscall(BigInt(number), a1, a2, a3, a4, a5, 0n);
  if (result === -1n) throw new BeneathError(operation, path, errno());
  return result;
}

function openAt(dirFd: number, path: string, flags: number, mode = 0): number {
  checkedRelativePath(path);
  const how = new BigUint64Array([
    BigInt(flags | O_CLOEXEC),
    BigInt(mode),
    BigInt(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS),
  ]);
  const name = cstring(path);
  return Number(call(OPENAT2, 'openat2', path, BigInt(dirFd), pointer(name), pointer(new Uint8Array(how.buffer)), BigInt(OPEN_HOW_BYTES)));
}

function openDirectoryAt(dirFd: number, path: string): number {
  return openAt(dirFd, path, FS.O_RDONLY | FS.O_DIRECTORY | O_NOFOLLOW);
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBADF') throw error;
  }
}

/**
 * A retained root descriptor. Every path operation starts from this descriptor
 * or a descriptor opened beneath it; the mutable root string is never resolved
 * again after construction.
 */
export class BeneathRoot {
  readonly #fd: number;
  #closed = false;

  constructor(root: string) {
    this.#fd = openSync(root, FS.O_RDONLY | FS.O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  }

  get fd(): number {
    this.#assertOpen();
    return this.#fd;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#fd);
  }

  openRead(path: string): number {
    this.#assertOpen();
    return openAt(this.#fd, path, FS.O_RDONLY | O_NOFOLLOW);
  }

  openWrite(path: string, flags = FS.O_WRONLY): number {
    this.#assertOpen();
    return openAt(this.#fd, path, flags | O_NOFOLLOW);
  }

  createFile(path: string, flags = FS.O_WRONLY | FS.O_CREAT, mode = 0o600): number {
    this.#assertOpen();
    return openAt(this.#fd, path, flags | FS.O_CREAT | O_NOFOLLOW, mode);
  }

  mkdir(path: string, mode = 0o755): void {
    this.#assertOpen();
    checkedRelativePath(path);
    let current = this.#fd;
    let owned = false;
    try {
      for (const component of path.split('/')) {
        const name = cstring(component);
        try {
          call(MKDIRAT, 'mkdirat', component, BigInt(current), pointer(name), BigInt(mode));
        } catch (error) {
          if (!(error instanceof BeneathError) || error.errno !== 17) throw error;
        }
        const next = openDirectoryAt(current, component);
        if (owned) closeSync(current);
        current = next;
        owned = true;
      }
    } finally {
      if (owned) closeQuietly(current);
    }
  }

  openParent(path: string): BeneathParent {
    this.#assertOpen();
    checkedRelativePath(path);
    const slash = path.lastIndexOf('/');
    if (slash < 0) return { fd: this.#fd, name: path, close: () => undefined };
    const parentFd = openDirectoryAt(this.#fd, path.slice(0, slash));
    let closed = false;
    return {
      fd: parentFd,
      name: path.slice(slash + 1),
      close: () => {
        if (!closed) {
          closed = true;
          closeSync(parentFd);
        }
      },
    };
  }

  unlink(path: string): void {
    this.#unlink(path, 0, 'unlinkat');
  }

  rmdir(path: string): void {
    this.#unlink(path, AT_REMOVEDIR, 'unlinkat');
  }

  hardlink(source: string, destination: string): void {
    this.#assertOpen();
    const target = this.openParent(destination);
    let sourceFd: number | undefined;
    try {
      sourceFd = openAt(this.#fd, source, O_PATH | O_NOFOLLOW);
      if (fstatSync(sourceFd).isSymbolicLink()) throw new BeneathError('linkat', source, undefined);
      const empty = cstring('');
      const targetName = cstring(target.name);
      call(LINKAT, 'linkat', source, BigInt(sourceFd), pointer(empty), BigInt(target.fd), pointer(targetName), BigInt(AT_EMPTY_PATH));
    } finally {
      if (sourceFd !== undefined) closeQuietly(sourceFd);
      target.close();
    }
  }

  symlink(target: string, path: string): void {
    this.#assertOpen();
    if (target.includes('\0')) throw new BeneathError('symlinkat', target, undefined);
    const parent = this.openParent(path);
    try {
      const targetBytes = cstring(target);
      const name = cstring(parent.name);
      call(SYMLINKAT, 'symlinkat', path, pointer(targetBytes), BigInt(parent.fd), pointer(name));
    } finally {
      parent.close();
    }
  }

  rename(source: string, destination: string, flags = 0): void {
    this.#assertOpen();
    if (!Number.isSafeInteger(flags) || flags < 0 || (flags & ~(RENAME_NOREPLACE | RENAME_EXCHANGE | RENAME_WHITEOUT)) !== 0) {
      throw new RangeError('invalid renameat2 flags');
    }
    const from = this.openParent(source);
    const to = this.openParent(destination);
    try {
      const sourceName = cstring(from.name);
      const destinationName = cstring(to.name);
      call(RENAMEAT2, 'renameat2', source, BigInt(from.fd), pointer(sourceName), BigInt(to.fd), pointer(destinationName), BigInt(flags));
    } finally {
      to.close();
      from.close();
    }
  }

  chmod(path: string, mode: number): void {
    this.#withFile(path, FS.O_RDONLY | O_NOFOLLOW, (fd) => {
      call(91, 'fchmod', path, BigInt(fd), BigInt(mode));
    });
  }

  chown(path: string, uid: number, gid: number): void {
    this.#withFile(path, FS.O_RDONLY | O_NOFOLLOW, (fd) => {
      call(93, 'fchown', path, BigInt(fd), BigInt(uid), BigInt(gid));
    });
  }
  lchown(path: string, uid: number, gid: number): void {
    this.#assertOpen();
    const parent = this.openParent(path);
    try {
      const name = cstring(parent.name);
      call(
        FCHOWNAT,
        'fchownat',
        path,
        BigInt(parent.fd),
        pointer(name),
        BigInt(uid),
        BigInt(gid),
        BigInt(AT_SYMLINK_NOFOLLOW),
      );
    } finally {
      parent.close();
    }
  }
  utimens(path: string, atimeNs: bigint, mtimeNs: bigint): void {
    if (atimeNs < 0n || mtimeNs < 0n) throw new RangeError('timestamps must be non-negative');
    const atimeSeconds = atimeNs / 1_000_000_000n;
    const atimeRemainder = atimeNs % 1_000_000_000n;
    const mtimeSeconds = mtimeNs / 1_000_000_000n;
    const mtimeRemainder = mtimeNs % 1_000_000_000n;
    const times = new BigInt64Array([atimeSeconds, atimeRemainder, mtimeSeconds, mtimeRemainder]);
    const parent = this.openParent(path);
    try {
      const name = cstring(parent.name);
      call(UTIMENSAT, 'utimensat', path, BigInt(parent.fd), pointer(name), pointer(new Uint8Array(times.buffer)), BigInt(AT_SYMLINK_NOFOLLOW));
    } finally {
      parent.close();
    }
  }

  setxattr(path: string, name: string, value: Uint8Array, flags = 0): void {
    checkedXattrName(name);
    this.#withFile(path, FS.O_RDONLY | O_NOFOLLOW, (fd) => {
      const key = cstring(name);
      call(FSETXATTR, 'fsetxattr', path, BigInt(fd), pointer(key), pointer(value), BigInt(value.byteLength), BigInt(flags));
    });
  }
  lsetxattr(path: string, name: string, value: Uint8Array, flags = 0): void {
    this.#assertOpen();
    checkedXattrName(name);
    const parent = this.openParent(path);
    try {
      // lsetxattr has no *at syscall. This retained descriptor path keeps the
      // lookup under the trusted root and lsetxattr leaves its final symlink.
      const target = cstring(`/proc/self/fd/${parent.fd}/${parent.name}`);
      const key = cstring(name);
      call(
        LSETXATTR,
        'lsetxattr',
        path,
        pointer(target),
        pointer(key),
        pointer(value),
        BigInt(value.byteLength),
        BigInt(flags),
      );
    } finally {
      parent.close();
    }
  }

  getxattr(path: string, name: string): Uint8Array {
    checkedXattrName(name);
    let result = new Uint8Array();
    this.#withFile(path, FS.O_RDONLY | O_NOFOLLOW, (fd) => {
      const key = cstring(name);
      const size = Number(call(FGETXATTR, 'fgetxattr', path, BigInt(fd), pointer(key), 0n, 0n));
      const value = new Uint8Array(size);
      const count = Number(call(FGETXATTR, 'fgetxattr', path, BigInt(fd), pointer(key), pointer(value), BigInt(size)));
      result = value.slice(0, count);
    });
    return result;
  }

  listxattr(path: string): readonly string[] {
    let result: readonly string[] = [];
    this.#withFile(path, FS.O_RDONLY | O_NOFOLLOW, (fd) => {
      const size = Number(call(FLISTXATTR, 'flistxattr', path, BigInt(fd), 0n, 0n));
      if (size === 0) {
        result = [];
        return;
      }
      const values = new Uint8Array(size);
      const count = Number(call(FLISTXATTR, 'flistxattr', path, BigInt(fd), pointer(values), BigInt(size)));
      result = new TextDecoder().decode(values.slice(0, count)).split('\0').filter((name) => name.length > 0);
    });
    return result;
  }

  removexattr(path: string, name: string): void {
    checkedXattrName(name);
    this.#withFile(path, FS.O_RDONLY | O_NOFOLLOW, (fd) => {
      const key = cstring(name);
      call(FREMOVEXATTR, 'fremovexattr', path, BigInt(fd), pointer(key));
    });
  }

  truncate(path: string, size: number): void {
    checkedOffset(size, 'size');
    this.#withFile(path, FS.O_WRONLY | O_NOFOLLOW, (fd) => {
      call(FTRUNCATE, 'ftruncate', path, BigInt(fd), BigInt(size));
    });
  }

  fallocate(path: string, offset: number, length: number, mode = 0): void {
    checkedOffset(offset, 'offset');
    checkedOffset(length, 'length');
    this.#withFile(path, FS.O_WRONLY | O_NOFOLLOW, (fd) => {
      call(FALLOCATE, 'fallocate', path, BigInt(fd), BigInt(mode), BigInt(offset), BigInt(length));
    });
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    checkedRange(offset, length);
    const fd = this.openRead(path);
    try {
      const bytes = new Uint8Array(length);
      let cursor = 0;
      while (cursor < length) {
        const count = readSync(fd, bytes, cursor, length - cursor, offset + cursor);
        if (count === 0) throw new Error(`sealed extent ${path}:${offset} is truncated`);
        cursor += count;
      }
      return bytes;
    } finally {
      closeSync(fd);
    }
  }

  writeRange(path: string, offset: number, bytes: Uint8Array): number {
    checkedRange(offset, bytes.byteLength);
    const fd = this.openWrite(path);
    try {
      let cursor = 0;
      while (cursor < bytes.byteLength) {
        const count = writeSync(fd, bytes, cursor, bytes.byteLength - cursor, offset + cursor);
        if (count === 0) throw new Error(`pwrite made no progress for ${path}`);
        cursor += count;
      }
      return cursor;
    } finally {
      closeSync(fd);
    }
  }

  sparseExtents(path: string, size?: number): readonly SparseExtent[] {
    const fd = this.openRead(path);
    const extentSize = size ?? fstatSync(fd).size;
    checkedOffset(extentSize, 'size');
    try {
      const extents: SparseExtent[] = [];
      let cursor = 0;
      while (cursor < extentSize) {
        let data: number;
        try {
          data = Number(call(LSEEK, 'lseek(SEEK_DATA)', path, BigInt(fd), BigInt(cursor), BigInt(SEEK_DATA)));
        } catch (error) {
          if (error instanceof BeneathError && error.errno === 6) break;
          throw error;
        }
        const hole = Number(call(LSEEK, 'lseek(SEEK_HOLE)', path, BigInt(fd), BigInt(data), BigInt(SEEK_HOLE)));
        if (hole <= data || hole > extentSize) throw new Error(`invalid sparse extent for ${path}`);
        extents.push({ offset: data, length: hole - data });
        cursor = hole;
      }
      return extents;
    } finally {
      closeSync(fd);
    }
  }

  #unlink(path: string, flags: number, operation: string): void {
    this.#assertOpen();
    const parent = this.openParent(path);
    try {
      const name = cstring(parent.name);
      call(UNLINKAT, operation, path, BigInt(parent.fd), pointer(name), BigInt(flags));
    } finally {
      parent.close();
    }
  }

  #withFile(path: string, flags: number, action: (fd: number) => void): void {
    this.#assertOpen();
    const fd = openAt(this.#fd, path, flags);
    try {
      action(fd);
    } finally {
      closeSync(fd);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('BeneathRoot is closed');
  }
}

export { MAX_RANGE_BYTES, MAX_NAME_BYTES, MAX_PATH_BYTES, RENAME_EXCHANGE, RENAME_NOREPLACE, RENAME_WHITEOUT };
