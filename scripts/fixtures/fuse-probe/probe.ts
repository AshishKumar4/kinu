#!/usr/bin/env bun
/**
 * The in-container half of the FUSE capability probe.
 *
 * It deliberately depends only on bun, node compatibility and libc. The
 * Sandbox image has node and bun but has previously measured python3, gcc,
 * make and libfuse userspace tooling absent. This file therefore speaks the
 * `/dev/fuse` ABI directly and invokes libc's `syscall(2)` through Bun FFI.
 * A missing device, denied syscall, helper absence or seccomp refusal becomes
 * evidence and a typed NO_GO in the outer driver; this program never installs
 * a package or claims a binary exists without finding it.
 *
 * Modes:
 *   stage1          capability census, openat2 proof, FUSE semantics/latency
 *   stage2          verified-restart residue, remount, stuck-mount cleanup
 *   daemon <dir> <config-base64>
 *                   private read-only FUSE server used by stage1/stage2
 *   unprivileged-mount <mountpoint>
 *                   helper-only non-root FUSE mount check used by daemon
 *   race <root> <swaps>
 *                   concurrent symlink-ancestor swapper for the openat2 test
 */
import {
  chmodSync, closeSync, constants as FS, existsSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync, chownSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir, release as osRelease } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dlopen, ptr, read as ffiRead } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';

import * as v from 'valibot';

import {
  BIG_FILE_BYTES, BIG_FILE_CHUNKS, CHUNK_BYTES, FUSE_OPCODES, FUSE_PROTOCOL_MAJOR,
  IN_HEADER_SIZE, OPEN_HOW_SIZE, RESOLVE_BENEATH, RESOLVE_NO_SYMLINKS,
  TREE_SEED, buildRangeIntent, canonicalChunk, canonicalRange,
  decodeCapabilitiesV3, errnoName, fuseMountOptions, packDirent, packEntryOut,
  packGetattrOut, packInitOut, packOpenHow, packOpenOut, packOutHeader, packStatfs,
  summarizeLatencies, syscallNumbers, verifyChunk,
} from './core';
import type { Openat2Report, Stage1Report, Stage2Report } from './core';

type SyscallSymbol = (
  nr: bigint,
  a1: bigint,
  a2: bigint,
  a3: bigint,
  a4: bigint,
  a5: bigint,
  a6: bigint,
) => bigint;
type FcntlSymbol = (fd: number, command: number, value: number) => number;

interface Libc {
  readonly syscall: SyscallSymbol;
  readonly fcntl: FcntlSymbol;
  readonly errnoLocation: () => Pointer | null;
}

/** `syscall` is variadic in libc. We deliberately declare seven i64 arguments
 * and pass zeroes for unused slots: Linux ignores registers beyond the system
 * call's arity. Passing every argument as an integer also makes the same FFI
 * entry work for mount(2), umount2(2), capget(2), and openat2(2). */
function libc(): Libc {
  const loaded = dlopen('libc.so.6', {
    syscall: { args: ['i64', 'i64', 'i64', 'i64', 'i64', 'i64', 'i64'], returns: 'i64' },
    fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
    __errno_location: { args: [], returns: 'ptr' },
  });
  return {
    syscall: loaded.symbols.syscall,
    fcntl: loaded.symbols.fcntl,
    errnoLocation: loaded.symbols.__errno_location,
  };
}

const MS_RDONLY = 1;
const MS_NOSUID = 2;
const MS_NODEV = 4;
const MNT_FORCE = 1;
const MNT_DETACH = 2;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

let atomicsWaitUsable = true;
let atomicsWaitRefusal = '';

/** Read the OS error class off a caught Error without casting. */
function errorCode(error: Error): string | undefined {
  if (!('code' in error)) return undefined;
  const code = error.code;
  return code === undefined || code === null ? undefined : String(code);
}

function isFsAbsent(error: Error): boolean {
  return errorCode(error) === 'ENOENT';
}

function isFsDenied(error: Error): boolean {
  return errorCode(error) === 'EACCES';
}

function isProcessGone(error: Error): boolean {
  return errorCode(error) === 'ESRCH';
}

/** Poll sleep. Atomics.wait is the precise primitive, but some bun builds
 *  refuse it on the main thread; a measured-spin fallback keeps readiness
 *  polling alive there at the cost of idle CPU during waits only. */
function sleepSync(ms: number): void {
  if (atomicsWaitUsable) {
    try {
      Atomics.wait(SLEEP_CELL, 0, 0, ms);
      return;
    } catch (error) {
      atomicsWaitUsable = false;
      atomicsWaitRefusal = error instanceof Error ? error.message : String(error);
      console.error(`[fuse-probe] Atomics.wait refused (${atomicsWaitRefusal}); readiness polling spins instead`);
    }
  }
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { /* deliberate spin */ }
}

const LIBC = libc();
const ARCH = process.arch;
const NRS = syscallNumbers(ARCH);
const SELF_PATH = new URL(import.meta.url).pathname;

function pointer(value: Uint8Array | undefined): bigint {
  return value === undefined ? 0n : BigInt(ptr(value));
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf8');
}

interface SyscallResult {
  readonly ok: boolean;
  readonly value?: bigint;
  readonly errno?: number;
  readonly errnoName?: string;
}

function syscall(nr: number, ...args: bigint[]): SyscallResult {
  const [a1 = 0n, a2 = 0n, a3 = 0n, a4 = 0n, a5 = 0n, a6 = 0n] = args;
  const value = LIBC.syscall(BigInt(nr), a1, a2, a3, a4, a5, a6);
  if (value !== -1n) return { ok: true, value };
  const errnoPointer = LIBC.errnoLocation();
  if (errnoPointer === null) throw new Error('libc returned no errno pointer');
  const errno = ffiRead.i32(errnoPointer);
  return { ok: false, errno, errnoName: errnoName(errno) };
}

function mountSyscall(source: string, target: string, type: string, flags: number, data: string): SyscallResult {
  return syscall(
    NRS.mount,
    pointer(cString(source)), pointer(cString(target)), pointer(cString(type)), BigInt(flags), pointer(cString(data)),
  );
}

function umount2(target: string, flags: number): SyscallResult {
  return syscall(NRS.umount2, pointer(cString(target)), BigInt(flags));
}

const O_CLOEXEC = 0o2000000;

function openat2(dirfd: number, pathname: string, resolve: number): SyscallResult {
  const how = packOpenHow(BigInt(FS.O_RDONLY | O_CLOEXEC), 0n, BigInt(resolve));
  return syscall(NRS.openat2, BigInt(dirfd), pointer(cString(pathname)), pointer(how), BigInt(OPEN_HOW_SIZE));
}

function clearCloseOnExec(fd: number): void {
  const F_GETFD = 1;
  const F_SETFD = 2;
  const FD_CLOEXEC = 1;
  const flags = LIBC.fcntl(fd, F_GETFD, 0);
  if (flags >= 0 && (flags & FD_CLOEXEC) !== 0) LIBC.fcntl(fd, F_SETFD, flags & ~FD_CLOEXEC);
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

type Timed<T> = { value: T; ms: number };

function timed<T>(operation: () => T): Timed<T> {
  const started = nowMs();
  const value = operation();
  return { value, ms: nowMs() - started };
}

function pathBinary(name: string): string | null {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, name);
    try {
      if ((statSync(candidate).mode & 0o111) !== 0) return candidate;
    } catch (error) {
      if (!(error instanceof Error && (isFsAbsent(error) || isFsDenied(error)))) throw error;
    }
  }
  return null;
}

function mountLines(needle: string): string[] {
  try {
    return readFileSync('/proc/self/mounts', 'utf8').split('\n').filter((line) => line.includes(needle));
  } catch (error) {
    if (!(error instanceof Error && isFsAbsent(error))) throw error;
    return [];
  }
}

function mountNamespace(): string {
  try {
    return readlinkSync('/proc/self/ns/mnt');
  } catch (error) {
    if (!(error instanceof Error && isFsAbsent(error))) throw error;
    return 'unreadable';
  }
}


function daemonProcessCount(): number {
  try {
    return readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .filter((pid) => {
        try {
          return readFileSync(join('/proc', pid, 'cmdline'), 'utf8').includes('\0daemon\0');
        } catch (error) {
          if (!(error instanceof Error && (isFsAbsent(error) || isFsDenied(error)))) throw error;
          return false;
        }
      }).length;
  } catch (error) {
    if (!(error instanceof Error && isFsAbsent(error))) throw error;
    return -1;
  }
}
function statusFields(): Map<string, string> {
  const fields = new Map<string, string>();
  try {
    for (const line of readFileSync('/proc/self/status', 'utf8').split('\n')) {
      const index = line.indexOf(':');
      if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1).trim());
    }
  } catch (error) {
    if (!(error instanceof Error && isFsAbsent(error))) throw error;
  }
  return fields;
}

type CapSnapshot = { names: string[]; sysAdmin: boolean; detail: string };
type BinaryAvailability = { name: string; path: string | null; availability: 'available' | 'no_go' };
type DevFuseState = { exists: boolean; detail?: string };
type FuseRequestHeader = { length: number; opcode: number; unique: bigint; nodeid: number };
type AttemptRow = {
  label: string;
  route: 'direct-syscall' | 'fusermount';
  ok: boolean;
  errnoName?: string;
  syscallNr?: number;
  detail?: string;
};
type UnmountOutcome = { ok: boolean; detail: string };
type Openat2Attempt = { ok: boolean; errnoName?: string; content?: string };

const AttemptRowSchema = v.looseObject({
  label: v.string(),
  route: v.picklist(['direct-syscall', 'fusermount']),
  ok: v.boolean(),
  errnoName: v.optional(v.string()),
  syscallNr: v.optional(v.number()),
  detail: v.optional(v.string()),
});

const DaemonStartSchema = v.looseObject({
  mounted: v.boolean(),
  pid: v.optional(v.number()),
  attempts: v.optional(v.array(AttemptRowSchema)),
});

/** The daemon's argv config crosses a process boundary as base64 JSON. */
const DaemonConfigSchema = v.looseObject({
  root: v.string(),
  mountpoint: v.string(),
  wideEntries: v.number(),
  poisonChunk: v.optional(v.number()),
  poisonDigest: v.optional(v.boolean()),
});

type CensusResult = {
  uid: number;
  gid: number;
  arch: string;
  kernelRelease: string;
  mountNamespace: string;
  capabilities: { names: string[]; sysAdmin: boolean };
  seccomp: { mode: number; filters: number };
  devFuse: DevFuseState;
  binaries: BinaryAvailability[];
  kernelFilesystems: { fuse: boolean; overlay: boolean; erofs: boolean };
  syscalls: Array<{ name: string; nr: number; outcome: string }>;
  imageFormats: BinaryAvailability[];
};

function capget(): CapSnapshot {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x20080522, 0);
  header.writeInt32LE(0, 4);
  const data = Buffer.alloc(24);
  const result = syscall(NRS.capget, pointer(header), pointer(data));
  if (!result.ok) return { names: [], sysAdmin: false, detail: `capget ${result.errnoName ?? 'failed'}` };
  const words: [number, number, number, number, number, number] = [
    data.readUInt32LE(0), data.readUInt32LE(12),
    data.readUInt32LE(4), data.readUInt32LE(16),
    data.readUInt32LE(8), data.readUInt32LE(20),
  ];
  const decoded = decodeCapabilitiesV3(words);
  return { names: decoded.effective, sysAdmin: decoded.sysAdmin, detail: 'capget v3' };
}

function census(): CensusResult {
  const proc = statusFields();
  const caps = capget();
  const binaryRow = (name: string): BinaryAvailability => {
    const path = pathBinary(name);
    return { name, path, availability: path === null ? 'no_go' : 'available' };
  };
  const binaries = ['fusermount3', 'fusermount', 'mount', 'umount', 'unshare'].map(binaryRow);
  const imageFormats = [
    'mkfs.erofs', 'fsck.erofs', 'dump.erofs',
    'mkcomposefs', 'composefs-info',
    'nydusify', 'nydusd',
  ].map(binaryRow);
  const filesystems = (() => {
    try {
      return readFileSync('/proc/filesystems', 'utf8');
    } catch (error) {
      if (!(error instanceof Error && isFsAbsent(error))) throw error;
      return '';
    }
  })();
  let devFuse: DevFuseState;
  try {
    const mode = lstatSync('/dev/fuse').mode & 0o777;
    devFuse = { exists: true, detail: `mode=${mode.toString(8)}` };
  } catch (error) {
    devFuse = { exists: false, detail: error instanceof Error ? error.message : String(error) };
  }
  return {
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    arch: ARCH,
    kernelRelease: osRelease(),
    mountNamespace: mountNamespace(),
    capabilities: { names: caps.names, sysAdmin: caps.sysAdmin },
    seccomp: { mode: Number(proc.get('Seccomp') ?? -1), filters: Number(proc.get('Seccomp_filters') ?? -1) },
    devFuse,
    binaries,
    kernelFilesystems: {
      fuse: /\bfuse\b/.test(filesystems),
      overlay: /\boverlay\b/.test(filesystems),
      erofs: /\berofs\b/.test(filesystems),
    },
    syscalls: [{ name: 'capget', nr: NRS.capget, outcome: caps.detail }],
    imageFormats,
  };
}

// ── custom read-only FUSE filesystem ─────────────────────────────────────────

const DT = { REG: 8, DIR: 4, LNK: 10 } as const;
const MODE = { REG: 0o100644, EXEC: 0o100755, DIR: 0o040755, LNK: 0o120777 } as const;
const ROOT = 1;
const HELLO = 2;
const EXEC = 3;
const LINK = 4;
const HARD = 5;
const RANGE = 6;
const WIDE = 7;
const DEEP = 8;
const BAD_DIGEST = 9;
const WIDE_BASE = 10_000;
const DEEP_BASE = 20_000;
const DEEP_LEAF = 21_000;
const DEEP_LEVELS = 48;

const ROOT_CHILD_BY_NAME = new Map<string, number>([
  ['hello.txt', HELLO], ['exec.sh', EXEC], ['link-to-hello', LINK],
  ['hard-a', HARD], ['hard-b', HARD], ['range-file.bin', RANGE],
  ['wide', WIDE], ['deep', DEEP], ['bad-digest.bin', BAD_DIGEST],
]);

interface NodeInfo {
  readonly id: number;
  readonly kind: 'file' | 'dir' | 'link';
  readonly mode: number;
  readonly size: number;
  readonly nlink: number;
  readonly target?: string;
  readonly label: string;
}

interface DaemonConfig {
  readonly root: string;
  readonly mountpoint: string;
  readonly wideEntries: number;
  readonly poisonChunk?: number;
  readonly poisonDigest?: boolean;
}

function staticNode(id: number, config: DaemonConfig): NodeInfo | undefined {
  switch (id) {
    case ROOT: return { id, kind: 'dir', mode: MODE.DIR, size: 0, nlink: 2, label: '/' };
    case HELLO: return { id, kind: 'file', mode: MODE.REG, size: 11, nlink: 1, label: 'hello.txt' };
    case EXEC: return { id, kind: 'file', mode: MODE.EXEC, size: 25, nlink: 1, label: 'exec.sh' };
    case LINK: return { id, kind: 'link', mode: MODE.LNK, size: 9, nlink: 1, target: 'hello.txt', label: 'link-to-hello' };
    case HARD: return { id, kind: 'file', mode: MODE.REG, size: 9, nlink: 2, label: 'hard' };
    case RANGE: return { id, kind: 'file', mode: MODE.REG, size: BIG_FILE_BYTES, nlink: 1, label: 'range-file.bin' };
    case WIDE: return { id, kind: 'dir', mode: MODE.DIR, size: 0, nlink: 2, label: 'wide' };
    case DEEP: return { id, kind: 'dir', mode: MODE.DIR, size: 0, nlink: 2, label: 'deep' };
    case BAD_DIGEST: return { id, kind: 'file', mode: MODE.REG, size: 3, nlink: 1, label: 'bad-digest.bin' };
    case DEEP_LEAF: return { id, kind: 'file', mode: MODE.REG, size: 5, nlink: 1, label: 'leaf.txt' };
    default:
      if (id >= WIDE_BASE && id < WIDE_BASE + config.wideEntries) {
        const index = id - WIDE_BASE;
        // stat size must equal the served bytes exactly: `wide:<index>\n`.
        return { id, kind: 'file', mode: MODE.REG, size: 6 + String(index).length, nlink: 1, label: `file-${String(index).padStart(5, '0')}` };
      }
      if (id >= DEEP_BASE && id < DEEP_BASE + DEEP_LEVELS) return { id, kind: 'dir', mode: MODE.DIR, size: 0, nlink: 2, label: `d${id - DEEP_BASE}` };
      return undefined;
  }
}

function children(node: NodeInfo, config: DaemonConfig): Array<{ name: string; id: number; type: number }> {
  if (node.id === ROOT) return [
    { name: 'hello.txt', id: HELLO, type: DT.REG }, { name: 'exec.sh', id: EXEC, type: DT.REG },
    { name: 'link-to-hello', id: LINK, type: DT.LNK }, { name: 'hard-a', id: HARD, type: DT.REG },
    { name: 'hard-b', id: HARD, type: DT.REG }, { name: 'range-file.bin', id: RANGE, type: DT.REG },
    { name: 'wide', id: WIDE, type: DT.DIR }, { name: 'deep', id: DEEP, type: DT.DIR },
    { name: 'bad-digest.bin', id: BAD_DIGEST, type: DT.REG },
  ];
  if (node.id === WIDE) return Array.from({ length: config.wideEntries }, (_, index) => ({
    name: `file-${String(index).padStart(5, '0')}`, id: WIDE_BASE + index, type: DT.REG,
  }));
  if (node.id === DEEP) return [{ name: 'd0', id: DEEP_BASE, type: DT.DIR }];
  if (node.id >= DEEP_BASE && node.id < DEEP_BASE + DEEP_LEVELS) {
    const level = node.id - DEEP_BASE;
    return level + 1 === DEEP_LEVELS
      ? [{ name: 'leaf.txt', id: DEEP_LEAF, type: DT.REG }]
      : [{ name: `d${level + 1}`, id: DEEP_BASE + level + 1, type: DT.DIR }];
  }
  return [];
}

function childByName(parent: NodeInfo, name: string, config: DaemonConfig): NodeInfo | undefined {
  if (parent.id === WIDE) {
    const index = /^file-(\d{5})$/.exec(name)?.[1];
    return index === undefined ? undefined : staticNode(WIDE_BASE + Number(index), config);
  }
  if (parent.id === ROOT) {
    const id = ROOT_CHILD_BY_NAME.get(name);
    return id === undefined ? undefined : staticNode(id, config);
  }
  if (parent.id === DEEP && name === 'd0') return staticNode(DEEP_BASE, config);
  if (parent.id >= DEEP_BASE && parent.id < DEEP_BASE + DEEP_LEVELS) {
    const level = parent.id - DEEP_BASE;
    if (level + 1 === DEEP_LEVELS && name === 'leaf.txt') return staticNode(DEEP_LEAF, config);
    if (name === `d${level + 1}`) return staticNode(DEEP_BASE + level + 1, config);
  }
  return undefined;
}

function nodeContent(node: NodeInfo): Buffer {
  if (node.id === HELLO) return Buffer.from('fuse probe\n');
  if (node.id === EXEC) return Buffer.from('#!/bin/sh\necho fuse-exec\n');
  if (node.id === HARD) return Buffer.from('hardlink\n');
  if (node.id === DEEP_LEAF) return Buffer.from('deep\n');
  if (node.id === BAD_DIGEST) return Buffer.from('bad');
  if (node.id >= WIDE_BASE) return Buffer.from(`wide:${node.id - WIDE_BASE}\n`);
  return Buffer.alloc(0);
}

function response(fd: number, unique: bigint, payload: Uint8Array = new Uint8Array(), error = 0): void {
  const header = packOutHeader(payload.length, unique, error);
  writeSync(fd, Buffer.concat([header, payload]));
}

function requestHeader(buffer: Buffer): FuseRequestHeader {
  return {
    length: buffer.readUInt32LE(0), opcode: buffer.readUInt32LE(4), unique: buffer.readBigUInt64LE(8), nodeid: Number(buffer.readBigUInt64LE(16)),
  };
}

/** Try the setuid/root-helper path as uid 65534. This is distinct from the
 * direct mount(2) attempt: a root container proves nothing about whether an
 * agent process without CAP_SYS_ADMIN can materialize a mount. */
function runUnprivilegedMount(mountpoint: string): never {
  const helper = pathBinary('fusermount3') ?? pathBinary('fusermount');
  if (helper === null) {
    console.log(JSON.stringify({ label: 'uid=65534', route: 'fusermount', ok: false, detail: 'fusermount3 and fusermount absent' }));
    process.exit(0);
  }
  let fd: number | undefined;
  try {
    fd = openSync('/dev/fuse', FS.O_RDWR);
    clearCloseOnExec(fd);
    const result = spawnSync(
      helper,
      ['-o', fuseMountOptions(fd, process.getuid?.() ?? 65534, process.getgid?.() ?? 65534, ['max_read=1048576']), mountpoint],
      { encoding: 'utf8' },
    );
    const mounted = result.status === 0;
    const cleanup = mounted ? spawnSync(helper, ['-u', mountpoint], { encoding: 'utf8' }) : undefined;
    console.log(JSON.stringify({
      label: 'uid=65534',
      route: 'fusermount',
      ok: mounted && cleanup?.status === 0,
      detail: `${basename(helper)} mount=${result.status ?? 'signal'} unmount=${cleanup?.status ?? 'n/a'} ${result.stderr}`.trim(),
    }));
  } catch (error) {
    console.log(JSON.stringify({
      label: 'uid=65534',
      route: 'fusermount',
      ok: false,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  process.exit(0);
}

function unprivilegedAttempt(root: string, currentUid: number): AttemptRow {
  if (currentUid !== 0) {
    return { label: `uid=${currentUid}`, route: 'fusermount', ok: false, detail: 'current process is already unprivileged; its helper route is recorded separately' };
  }
  const mountpoint = join(root, 'unprivileged-mnt');
  mkdirSync(mountpoint);
  try {
    chownSync(mountpoint, 65534, 65534);
    const child = spawnSync(process.execPath, [SELF_PATH, 'unprivileged-mount', mountpoint], {
      encoding: 'utf8',
      timeout: 10_000,
      uid: 65534,
      gid: 65534,
    });
    return v.parse(AttemptRowSchema, JSON.parse(child.stdout.trim() || '{}'));
  } catch (error) {
    return {
      label: 'uid=65534',
      route: 'fusermount',
      ok: false,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    rmSync(mountpoint, { recursive: true, force: true });
  }
}


function requestName(buffer: Buffer, length: number): string {
  const end = buffer.indexOf(0, IN_HEADER_SIZE);
  return buffer.toString('utf8', IN_HEADER_SIZE, end === -1 ? length : end);
}

/** The daemon lives in a separate bun process. No library, helper daemon or
 *  compiled code is required: INIT, LOOKUP, GETATTR, OPEN, READ and READDIR
 *  are the kernel ABI itself. */
/** The '..' dirent must carry the true parent inode: GETATTR on it is served
 *  from staticNode, so a wrong id would report root metadata for a subtree. */
function parentIdOf(id: number): number {
  if (id === WIDE || id === DEEP) return ROOT;
  if (id > DEEP_BASE && id < DEEP_BASE + DEEP_LEVELS) return id - 1;
  if (id >= WIDE_BASE && id < WIDE_BASE + 100_000) return WIDE;
  if (id === DEEP_LEAF) return DEEP_BASE + DEEP_LEVELS - 1;
  return ROOT;
}

function runDaemon(config: DaemonConfig): never {
  const attempts: AttemptRow[] = [];
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  attempts.push(unprivilegedAttempt(config.root, uid));
  let fd: number | undefined;
  try {
    fd = openSync('/dev/fuse', FS.O_RDWR);
    clearCloseOnExec(fd);
    const options = fuseMountOptions(fd, uid, gid, ['max_read=1048576']);
    const direct = mountSyscall('fuse-probe', config.mountpoint, 'fuse', MS_RDONLY | MS_NOSUID | MS_NODEV, options);
    attempts.push({ label: 'current-identity', route: 'direct-syscall', syscallNr: NRS.mount, ok: direct.ok, errnoName: direct.errnoName, detail: direct.ok ? 'mount(2) succeeded' : 'mount(2) refused' });
    let mounted = direct.ok;
    if (!mounted) {
      const helper = pathBinary('fusermount3') ?? pathBinary('fusermount');
      if (helper !== null) {
        const helperResult = spawnSync(helper, ['-o', options, config.mountpoint], { encoding: 'utf8' });
        mounted = helperResult.status === 0;
        attempts.push({ label: 'current-identity', route: 'fusermount', ok: mounted, detail: `${basename(helper)} ${helperResult.status ?? 'signal'} ${helperResult.stderr}`.trim() });
      } else {
        attempts.push({ label: 'current-identity', route: 'fusermount', ok: false, detail: 'fusermount3 and fusermount absent' });
      }
    }
    writeFileSync(join(config.root, 'daemon-start.json'), JSON.stringify({ mounted, attempts, pid: process.pid }));
    if (!mounted) process.exit(0);

    const cache = new Map<number, Buffer>();
    const readBuffer = Buffer.alloc(1024 * 1024 + 4096);
    for (;;) {
      const read = readSync(fd, readBuffer, 0, readBuffer.length, null);
      if (read < IN_HEADER_SIZE) continue;
      const req = requestHeader(readBuffer);
      const node = staticNode(req.nodeid, config);
      const fail = (number: number): void => response(fd!, req.unique, Buffer.alloc(0), -number);
      const attr = (candidate: NodeInfo): void => response(fd!, req.unique, packGetattrOut({ ino: candidate.id, size: candidate.size, mode: candidate.mode, nlink: candidate.nlink }));
      switch (req.opcode) {
        case FUSE_OPCODES.INIT: {
          const major = readBuffer.readUInt32LE(IN_HEADER_SIZE);
          const minor = readBuffer.readUInt32LE(IN_HEADER_SIZE + 4);
          const readahead = readBuffer.readUInt32LE(IN_HEADER_SIZE + 8);
          const flags = readBuffer.readUInt32LE(IN_HEADER_SIZE + 12);
          if (major !== FUSE_PROTOCOL_MAJOR) { fail(22); break; }
          response(fd, req.unique, packInitOut(minor, flags, readahead));
          break;
        }
        case FUSE_OPCODES.LOOKUP: {
          if (node?.kind !== 'dir') { fail(20); break; }
          const found = childByName(node, requestName(readBuffer, req.length), config);
          if (found === undefined) { fail(2); break; }
          if (found.id === BAD_DIGEST && config.poisonDigest === true) { fail(5); break; }
          response(fd, req.unique, packEntryOut(found.id, { ino: found.id, size: found.size, mode: found.mode, nlink: found.nlink }));
          break;
        }
        case FUSE_OPCODES.GETATTR:
          if (node === undefined) fail(2); else attr(node);
          break;
        case FUSE_OPCODES.READLINK:
          if (node?.kind !== 'link' || node.target === undefined) fail(22); else response(fd, req.unique, Buffer.from(node.target));
          break;
        case FUSE_OPCODES.OPEN:
        case FUSE_OPCODES.OPENDIR:
          if (node === undefined) fail(2); else if (req.opcode === FUSE_OPCODES.OPENDIR && node.kind !== 'dir') fail(20); else response(fd, req.unique, packOpenOut(BigInt(node.id)));
          break;
        case FUSE_OPCODES.READ: {
          if (node === undefined || node.kind !== 'file') { fail(2); break; }
          if (node.id === BAD_DIGEST && config.poisonDigest === true) { fail(5); break; }
          const offset = Number(readBuffer.readBigUInt64LE(IN_HEADER_SIZE + 8));
          const size = readBuffer.readUInt32LE(IN_HEADER_SIZE + 16);
          if (node.id !== RANGE) {
            response(fd, req.unique, nodeContent(node).subarray(offset, offset + size));
            break;
          }
          const end = Math.min(BIG_FILE_BYTES, offset + size);
          const out = Buffer.alloc(Math.max(0, end - offset));
          let written = 0;
          for (let index = Math.floor(offset / CHUNK_BYTES); index <= Math.floor((end - 1) / CHUNK_BYTES); index++) {
            let chunk = cache.get(index);
            if (chunk === undefined) {
              chunk = Buffer.from(canonicalChunk(TREE_SEED, index));
              cache.set(index, chunk);
              if (cache.size > 64) cache.delete(cache.keys().next().value!);
            }
            const verification = verifyChunk(TREE_SEED, index, chunk, config.poisonChunk === index);
            if (!verification.ok) { fail(5); written = -1; break; }
            const from = Math.max(offset, index * CHUNK_BYTES) - index * CHUNK_BYTES;
            const to = Math.min(end, (index + 1) * CHUNK_BYTES) - index * CHUNK_BYTES;
            chunk.copy(out, written, from, to);
            written += to - from;
          }
          if (written >= 0) response(fd, req.unique, out);
          break;
        }
        case FUSE_OPCODES.READDIR: {
          if (node?.kind !== 'dir') { fail(20); break; }
          const offset = Number(readBuffer.readBigUInt64LE(IN_HEADER_SIZE + 8));
          const size = readBuffer.readUInt32LE(IN_HEADER_SIZE + 16);
          const entries = [
            { name: '.', id: node.id, type: DT.DIR },
            { name: '..', id: parentIdOf(node.id), type: DT.DIR },
            ...children(node, config),
          ];
          const chunks: Buffer[] = [];
          let bytes = 0;
          for (let index = offset; index < entries.length; index++) {
            const entry = entries[index]!;
            const encoded = packDirent(entry.id, index + 1, entry.type, entry.name);
            if (bytes + encoded.length > size) break;
            chunks.push(encoded); bytes += encoded.length;
          }
          response(fd, req.unique, Buffer.concat(chunks));
          break;
        }
        case FUSE_OPCODES.STATFS:
          response(fd, req.unique, packStatfs(config.wideEntries + BIG_FILE_CHUNKS));
          break;
        case FUSE_OPCODES.ACCESS:
        case FUSE_OPCODES.FLUSH:
        case FUSE_OPCODES.RELEASE:
        case FUSE_OPCODES.RELEASEDIR:
        case FUSE_OPCODES.FSYNC:
        case FUSE_OPCODES.FSYNCDIR:
          response(fd, req.unique);
          break;
        case FUSE_OPCODES.FORGET:
        case FUSE_OPCODES.BATCH_FORGET:
        case FUSE_OPCODES.INTERRUPT:
          break; // These requests deliberately have no reply.
        case FUSE_OPCODES.DESTROY:
          response(fd, req.unique);
          process.exit(0);
        case FUSE_OPCODES.SETATTR:
        case FUSE_OPCODES.WRITE:
        case FUSE_OPCODES.MKNOD:
        case FUSE_OPCODES.MKDIR:
        case FUSE_OPCODES.UNLINK:
        case FUSE_OPCODES.RMDIR:
        case FUSE_OPCODES.RENAME:
        case FUSE_OPCODES.SYMLINK:
        case FUSE_OPCODES.LINK:
        case FUSE_OPCODES.CREATE:
          fail(30); // EROFS: custom reference is read-only by construction.
          break;
        default:
          fail(38); // ENOSYS lets the kernel disable an optional operation.
      }
    }
  } catch (error) {
    writeFileSync(join(config.root, 'daemon-start.json'), JSON.stringify({
      mounted: false,
      attempts,
      failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }));
    if (fd !== undefined) closeSync(fd);
    process.exit(1);
  }
}

interface MountSession {
  readonly root: string;
  readonly mountpoint: string;
  readonly pid: number;
  /** Spawn → first answered syscall through the mount. This — not a
   *  proportional-size readdir — is what makes eager O(entries) bootstrap
   *  observable: a daemon that indexes before answering grows this number
   *  with the tree, a lazy one does not. */
  readonly bringUpMs: number;
  readonly attempts: AttemptRow[];
}
interface MountResult {
  readonly session?: MountSession;
  readonly attempts: AttemptRow[];
}


function awaitFile(path: string, timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
    sleepSync(25);
  }
  throw new Error(`daemon did not publish ${path} within ${timeoutMs}ms`);
}

function mountReference(parent: string, wideEntries: number, options: { poisonChunk?: number; poisonDigest?: boolean } = {}): MountResult {
  const root = mkdtempSync(join(parent, 'mount-'));
  const mountpoint = join(root, 'mnt');
  mkdirSync(mountpoint);
  const config: DaemonConfig = { root, mountpoint, wideEntries, ...options };
  const bringUpStarted = nowMs();
  const child = spawn(process.execPath, [SELF_PATH, 'daemon', root, Buffer.from(JSON.stringify(config)).toString('base64')], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const state = v.parse(DaemonStartSchema, JSON.parse(awaitFile(join(root, 'daemon-start.json'), 15_000)));
  const attempts = state.attempts ?? [];
  if (!state.mounted || state.pid === undefined) return { attempts };
  const session: MountSession = {
    root,
    mountpoint,
    pid: state.pid,
    bringUpMs: nowMs() - bringUpStarted,
    attempts,
  };
  // A real first syscall proves the daemon answers; a successful mount table
  // entry alone could be a stuck mount whose server died before INIT.
  const check = spawnSync('sh', ['-c', `ls ${JSON.stringify(mountpoint)} >/dev/null`], {
    timeout: 3_000,
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    removeSession(session, true);
    return {
      attempts: [
        ...attempts,
        {
          label: 'first-ls',
          route: 'direct-syscall',
          ok: false,
          detail: `status=${check.status ?? 'signal'} stderr=${check.stderr.slice(0, 300)}`,
        },
      ],
    };
  }
  return { session, attempts };
}

function unmount(session: MountSession, forced = false): UnmountOutcome {
  const result = umount2(session.mountpoint, forced ? MNT_FORCE | MNT_DETACH : 0);
  if (result.ok) return { ok: true, detail: forced ? 'umount2(MNT_FORCE|MNT_DETACH)' : 'umount2' };
  const helper = pathBinary('fusermount3') ?? pathBinary('fusermount');
  const fallback = helper === null ? undefined : spawnSync(helper, [forced ? '-uz' : '-u', session.mountpoint], { encoding: 'utf8' });
  return {
    ok: fallback?.status === 0,
    detail: fallback === undefined ? `umount2 ${result.errnoName ?? 'failed'}; helper absent` : `${basename(helper!)} ${fallback.status ?? 'signal'}`,
  };
}

function removeSession(session: MountSession, forced = false): UnmountOutcome {
  const result = unmount(session, forced);
  try {
    process.kill(session.pid, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && isProcessGone(error))) throw error;
  }
  rmSync(session.root, { recursive: true, force: true });
  return result;
}

function nativeTree(parent: string, entries: number): string {
  const root = mkdtempSync(join(parent, 'native-'));
  mkdirSync(join(root, 'wide'));
  writeFileSync(join(root, 'hello.txt'), 'fuse probe\n');
  writeFileSync(join(root, 'exec.sh'), '#!/bin/sh\necho fuse-exec\n'); chmodSync(join(root, 'exec.sh'), 0o755);
  writeFileSync(join(root, 'hard-a'), 'hardlink\n');
  // Node's link call is not needed to control walk/stat; hardlink semantics are
  // proven at the FUSE surface itself.
  for (let index = 0; index < entries; index++) writeFileSync(join(root, 'wide', `file-${String(index).padStart(5, '0')}`), `wide:${index}\n`);
  let deep = join(root, 'deep'); mkdirSync(deep);
  for (let level = 0; level < DEEP_LEVELS; level++) { deep = join(deep, `d${level}`); mkdirSync(deep); }
  writeFileSync(join(deep, 'leaf.txt'), 'deep\n');
  const fd = openSync(join(root, 'range-file.bin'), FS.O_CREAT | FS.O_WRONLY, 0o644);
  try { for (let chunk = 0; chunk < BIG_FILE_CHUNKS; chunk++) writeSync(fd, canonicalChunk(TREE_SEED, chunk)); } finally { closeSync(fd); }
  return root;
}

function recursiveWalk(root: string): number {
  let files = 0;
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path); else files++;
    }
  };
  visit(root);
  return files;
}

function rangeRead(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, FS.O_RDONLY);
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}

function randomRanges(count: number, length: number): Array<{ offset: number; length: number }> {
  const ranges: Array<{ offset: number; length: number }> = [];
  let state = 0x4a11ce;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const maxOffset = BIG_FILE_BYTES - length;
    ranges.push({ offset: (state % Math.floor(maxOffset / 4096)) * 4096, length });
  }
  return ranges;
}

/** Symlink-swap race iterations: the racer argv, the observation loop bound
 *  and the reported count must agree, so all three read this. */
const RACE_SWAPS = 1_500;

function runOpenat2(): Openat2Report {
  const root = mkdtempSync(join(tmpdir(), 'fuse-probe-openat2-'));
  const sub = join(root, 'sub');
  const parked = join(root, 'parked');
  const outside = mkdtempSync(join(tmpdir(), 'fuse-probe-outside-'));
  mkdirSync(sub); writeFileSync(join(sub, 'marker.txt'), 'SAFE');
  writeFileSync(join(outside, 'marker.txt'), 'ESCAPE');
  const dirfd = openSync(root, FS.O_RDONLY | FS.O_DIRECTORY);
  const resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS;
  const checked = (path: string, bits = resolve): Openat2Attempt => {
    const result = openat2(dirfd, path, bits);
    if (!result.ok || result.value === undefined) return { ok: false, errnoName: result.errnoName };
    const fd = Number(result.value);
    try {
      const buffer = Buffer.alloc(32);
      const read = readSync(fd, buffer, 0, buffer.length, null);
      return { ok: true, content: buffer.toString('utf8', 0, read) };
    } finally { closeSync(fd); }
  };
  const positive = checked('sub/marker.txt');
  if (!positive.ok) {
    closeSync(dirfd); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
    return {
      syscallNr: NRS.openat2,
      supported: false,
      supportErrnoName: positive.errnoName ?? 'unknown',
      beneathPositive: { ok: false }, absoluteEscape: { blocked: false }, dotDotEscape: { blocked: false },
      symlinkAncestorNoSymlinks: { blocked: false }, symlinkAncestorBeneathOnly: { blocked: false },
      deterministicSequence: { plainEscaped: false, openat2Blocked: false },
      race: { swaps: 0, resolutions: 0, escapesObserved: 0, controlPlainEscapes: 0, outcomes: {} },
    };
  }
  const absolute = checked('/etc/passwd');
  const dotDot = checked('sub/../../etc/passwd');
  renameSync(sub, parked); symlinkSync(outside, sub);
  const noSymlink = checked('sub/marker.txt');
  const beneathOnly = checked('sub/marker.txt', RESOLVE_BENEATH);
  let plainEscaped = false;
  try { plainEscaped = readFileSync(join(root, 'sub', 'marker.txt'), 'utf8') === 'ESCAPE'; }
  catch (error) { if (!(error instanceof Error && isFsAbsent(error))) throw error; }
  unlinkSync(sub); renameSync(parked, sub);

  const racer = spawn(process.execPath, [SELF_PATH, 'race', root, outside, String(RACE_SWAPS)], { stdio: 'ignore' });
  const outcomes: Record<string, number> = {};
  let escapesObserved = 0;
  let controlPlainEscapes = 0;
  let resolutions = 0;
  for (let iteration = 0; iteration < RACE_SWAPS; iteration++) {
    const result = checked('sub/marker.txt'); resolutions++;
    if (result.ok) {
      outcomes.ok = (outcomes.ok ?? 0) + 1;
      if (result.content !== 'SAFE') escapesObserved++;
    } else outcomes[result.errnoName ?? 'unknown'] = (outcomes[result.errnoName ?? 'unknown'] ?? 0) + 1;
    try { if (readFileSync(join(root, 'sub', 'marker.txt'), 'utf8') === 'ESCAPE') controlPlainEscapes++; }
    catch (error) { if (!(error instanceof Error && isFsAbsent(error))) throw error; }
  }
  try { racer.kill('SIGTERM'); }
  catch (error) { if (!(error instanceof Error && isProcessGone(error))) throw error; }
  closeSync(dirfd);
  rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  return {
    syscallNr: NRS.openat2,
    supported: true,
    beneathPositive: { ok: positive.ok && positive.content === 'SAFE', detail: positive.content },
    absoluteEscape: { blocked: !absolute.ok, errnoName: absolute.errnoName },
    dotDotEscape: { blocked: !dotDot.ok, errnoName: dotDot.errnoName },
    symlinkAncestorNoSymlinks: { blocked: !noSymlink.ok, errnoName: noSymlink.errnoName },
    symlinkAncestorBeneathOnly: { blocked: !beneathOnly.ok, errnoName: beneathOnly.errnoName },
    deterministicSequence: { plainEscaped, openat2Blocked: !noSymlink.ok },
    race: { swaps: RACE_SWAPS, resolutions, escapesObserved, controlPlainEscapes, outcomes },
  };
}

function runRace(root: string, outside: string, swaps: number): never {
  const sub = join(root, 'sub'); const parked = join(root, 'parked');
  for (let i = 0; i < swaps; i++) {
    try {
      renameSync(sub, parked); symlinkSync(outside, sub); unlinkSync(sub); renameSync(parked, sub);
    } catch (error) {
      if (!(error instanceof Error && isFsAbsent(error))) throw error;
    }
  }
  process.exit(0);
}

function stage1(): Stage1Report {
  const startedAt = new Date().toISOString();
  const attemptId = randomUUID();
  const parent = mkdtempSync(join(tmpdir(), 'fuse-probe-'));
  const censusResult = census();
  const openat2Result = runOpenat2();
  const baseResult = mountReference(parent, 2_000);
  const base = baseResult.session;
  const mountAttempts = baseResult.attempts;
  if (base === undefined) {
    const finishedAt = new Date().toISOString();
    const report: Stage1Report = {
      stage: 'stage1', attemptId, startedAt, finishedAt, census: censusResult, openat2: openat2Result,
      mountAttempts, mounted: false, bootstrapSamples: [], coldRootChallengeMs: [], firstStatRead: [],
      rangeReads: [], integrity: { poisonChunk: 3, refused: false, servedWrongBytes: false, digestRefusal: { refused: false } },
      links: { symlinkResolvedContentOk: false, lstatIsLink: false, hardlinkSameInoAndNlink2: false },
      execMetadata: { mode0755Preserved: false, execAttempted: false, execOk: false },
      overlay: { attempted: false, composed: false }, mountsPresentAtExit: [],
    };
    rmSync(parent, { recursive: true, force: true });
    return report;
  }
  const native = nativeTree(parent, 2_000);
  const coldRootChallengeMs: number[] = [];
  const firstStatRead: Array<{ statMs: number; readMs: number; bytes: number }> = [];
  const bootstrapSamples: Array<{ entries: number; ms: number }> = [];
  try {
    // Current mount supplies cold root and first stat/read. Repeated mounts at
    // three cardinalities make O(entries) bootstrap observable rather than a
    // claim inferred from one timing.
    coldRootChallengeMs.push(timed(() => readdirSync(base.mountpoint)).ms);
    const stat = timed(() => statSync(join(base.mountpoint, 'hello.txt'))).ms;
    const read = timed(() => readFileSync(join(base.mountpoint, 'hello.txt'))).ms;
    firstStatRead.push({ statMs: stat, readMs: read, bytes: 11 });
    for (const entries of [200, 2_000, 8_000]) {
      const session: MountSession | undefined = entries === 2_000 ? base : mountReference(parent, entries).session;
      if (session === undefined) continue;
      bootstrapSamples.push({ entries, ms: session.bringUpMs });
      if (session !== base) removeSession(session);
    }

    const workingSamples: number[] = []; const nativeSamples: number[] = [];
    // The report's files/iterations ARE these loop bounds, read from the same
    // consts so a retuned working set cannot report its old geometry.
    const workingFiles = 32;
    const workingIterations = 20;
    for (let iteration = 0; iteration < workingIterations; iteration++) for (let index = 0; index < workingFiles; index++) {
      const name = `file-${String(index).padStart(5, '0')}`;
      workingSamples.push(timed(() => { statSync(join(base.mountpoint, 'wide', name)); readFileSync(join(base.mountpoint, 'wide', name)); }).ms);
      nativeSamples.push(timed(() => { statSync(join(native, 'wide', name)); readFileSync(join(native, 'wide', name)); }).ms);
    }
    const fuseWalk = timed(() => recursiveWalk(base.mountpoint));
    const nativeWalk = timed(() => recursiveWalk(native));

    const ranges = randomRanges(48, 64 * 1024);
    const rangeReads = ranges.map(({ offset, length }, index) => {
      const measured = timed(() => rangeRead(join(base.mountpoint, 'range-file.bin'), offset, length));
      const expected = canonicalRange(TREE_SEED, offset, length);
      return { ...buildRangeIntent({ operationId: `range-${index}`, attemptId, exactKey: 'range-file.bin', byteOffset: offset, byteLength: length }), latencyMs: measured.ms, verified: Buffer.compare(measured.value, Buffer.from(expected)) === 0 };
    });
    const hot = ranges.slice(0, 8);
    const miss = hot.map(({ offset, length }) => timed(() => rangeRead(join(base.mountpoint, 'range-file.bin'), offset, length)).ms);
    const hits: number[] = [];
    for (let pass = 0; pass < 20; pass++) for (const { offset, length } of hot) hits.push(timed(() => rangeRead(join(base.mountpoint, 'range-file.bin'), offset, length)).ms);

    const linkPath = join(base.mountpoint, 'link-to-hello');
    const hardA = statSync(join(base.mountpoint, 'hard-a')); const hardB = statSync(join(base.mountpoint, 'hard-b'));
    const execStat = statSync(join(base.mountpoint, 'exec.sh'));
    const execAttempt = spawnSync(join(base.mountpoint, 'exec.sh'), [], { encoding: 'utf8', timeout: 3_000 });

    const overlayRoot = join(parent, 'overlay'); mkdirSync(overlayRoot); mkdirSync(join(overlayRoot, 'upper')); mkdirSync(join(overlayRoot, 'work')); mkdirSync(join(overlayRoot, 'merged'));
    const overlay = mountSyscall('overlay', join(overlayRoot, 'merged'), 'overlay', 0, `lowerdir=${base.mountpoint},upperdir=${join(overlayRoot, 'upper')},workdir=${join(overlayRoot, 'work')}`);
    const overlayComposed = overlay.ok;
    const overlayRead = overlayComposed ? readFileSync(join(overlayRoot, 'merged', 'hello.txt'), 'utf8') === 'fuse probe\n' : undefined;
    if (overlayComposed) umount2(join(overlayRoot, 'merged'), 0);

    const poisoned = mountReference(parent, 2_000, { poisonChunk: 3 }).session;
    let refused = false; let servedWrongBytes = false; let poisonErrno: string | undefined;
    if (poisoned !== undefined) {
      try {
        const bytes = rangeRead(join(poisoned.mountpoint, 'range-file.bin'), 3 * CHUNK_BYTES, 4096);
        servedWrongBytes = Buffer.compare(bytes, Buffer.from(canonicalRange(TREE_SEED, 3 * CHUNK_BYTES, 4096))) !== 0;
      } catch (error) { refused = true; poisonErrno = error instanceof Error ? errorCode(error) : undefined; }
      removeSession(poisoned);
    }
    const badDigest = mountReference(parent, 2_000, { poisonDigest: true }).session;
    let digestRefused = false; let digestErrno: string | undefined;
    if (badDigest !== undefined) {
      try { readFileSync(join(badDigest.mountpoint, 'bad-digest.bin')); } catch (error) { digestRefused = true; digestErrno = error instanceof Error ? errorCode(error) : undefined; }
      removeSession(badDigest);
    }

    return {
      stage: 'stage1', attemptId, startedAt, finishedAt: new Date().toISOString(), census: censusResult, openat2: openat2Result,
      mountAttempts, mounted: true, mountpoint: base.mountpoint, bootstrapSamples, coldRootChallengeMs, firstStatRead,
      workingSet: { files: workingFiles, iterations: workingIterations, fuse: { ...summarizeLatencies(workingSamples)! }, native: { ...summarizeLatencies(nativeSamples)! } },
      fullWalk: { fuseFiles: fuseWalk.value, fuseMs: fuseWalk.ms, nativeFiles: nativeWalk.value, nativeMs: nativeWalk.ms },
      rangeReads, cache: { reps: hits.length, missP50Ms: summarizeLatencies(miss)!.p50Ms, hitP50Ms: summarizeLatencies(hits)!.p50Ms },
      integrity: { poisonChunk: 3, refused, servedWrongBytes, errnoName: poisonErrno, digestRefusal: { refused: digestRefused, errnoName: digestErrno } },
      links: { symlinkResolvedContentOk: readFileSync(linkPath, 'utf8') === 'fuse probe\n', lstatIsLink: lstatSync(linkPath).isSymbolicLink(), hardlinkSameInoAndNlink2: hardA.ino === hardB.ino && hardA.nlink === 2 },
      execMetadata: { mode0755Preserved: (execStat.mode & 0o777) === 0o755, execAttempted: true, execOk: execAttempt.status === 0, note: 'exec result is supplementary: a privileged uid can bypass some DAC checks; mode is the metadata proof.' },
      overlay: { attempted: true, composed: overlayComposed, readVerified: overlayRead, errnoName: overlay.errnoName },
      mountsPresentAtExit: mountLines('fuse-probe'),
    };
  } finally {
    removeSession(base);
    rmSync(native, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
}

function stage2(): Stage2Report {
  const startedAt = new Date().toISOString(); const attemptId = randomUUID();
  const parent = mkdtempSync(join(tmpdir(), 'fuse-probe-restart-'));
  const priorInstanceMountLines = mountLines('fuse-probe');
  const sessionResult = mountReference(parent, 1_000);
  const session = sessionResult.session;
  if (session === undefined) {
    return {
      stage: 'stage2', attemptId, startedAt, finishedAt: new Date().toISOString(),
      restartResidue: { priorInstanceMountLines, freshInstanceClean: priorInstanceMountLines.length === 0 }, remountOk: false,
      stuckMountDrill: { hungDetected: false, forcedUnmountOk: false },
      cleanup: { unmountOk: false, residueMounts: [], strayDaemonProcesses: daemonProcessCount(), backingDirsRemoved: false, replayClean: false },
    };
  }
  try {
    // Kill a live daemon before unmounting. A correct cleanup path must notice
    // the hung mount, detach it, then prove /proc/self/mounts has no residue.
    try { process.kill(session.pid, 'SIGKILL'); }
    catch (error) { if (!(error instanceof Error && isProcessGone(error))) throw error; }
    const hung = spawnSync('sh', ['-c', `ls ${JSON.stringify(session.mountpoint)} >/dev/null`], { timeout: 500 }).signal === 'SIGTERM';
    const forced = unmount(session, true);
    const residue = mountLines(session.mountpoint);
    const replay = unmount(session, true);
    rmSync(session.root, { recursive: true, force: true });
    return {
      stage: 'stage2', attemptId, startedAt, finishedAt: new Date().toISOString(),
      restartResidue: { priorInstanceMountLines, freshInstanceClean: priorInstanceMountLines.length === 0 }, remountOk: true,
      stuckMountDrill: { hungDetected: hung, forcedUnmountOk: forced.ok },
      cleanup: { unmountOk: forced.ok, residueMounts: residue, strayDaemonProcesses: daemonProcessCount(), backingDirsRemoved: !existsSync(session.root), replayClean: replay.ok || residue.length === 0 },
    };
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

function print(report: Stage1Report | Stage2Report): void {
  console.log('__FUSE_PROBE_RESULT__');
  console.log(JSON.stringify(report));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'unprivileged-mount') runUnprivilegedMount(args[0]!);
if (mode === 'daemon') runDaemon(v.parse(DaemonConfigSchema, JSON.parse(Buffer.from(args[1]!, 'base64').toString('utf8'))));
if (mode === 'race') runRace(args[0]!, args[1]!, Number(args[2]));
if (mode === 'stage1') print(stage1());
else if (mode === 'stage2') print(stage2());
else throw new Error('usage: probe.ts stage1|stage2');
