// Kinu PC agent — a file mutation acts where its path was judged, wherever a command has moved a link since.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const util = require('node:util');

const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = fs.constants;

/** Linux's O_PATH: a directory held by a walk that needs only search permission on it, as a path lookup does. */
const O_PATH = 0o10000000;

/** Why a judged path no longer holds: a command on this device swapped a link into it after the frame was judged. */
function movedUnderneath(judged, cause) {
  const error = new Error(`device path '${judged}' changed after it was checked: a directory in it is now a link`);
  error.code = 'EACCES';
  error.cause = cause;

  return error;
}

/** The entry at the path `at`, through node:fs; `follow` 0 opens through a link in its last component. */
function entryAt(at, follow = 0) {
  return {
    open: (flags, mode) => fs.openSync(at, flags | follow, mode),
    mkdir: (recursive) => { fs.mkdirSync(at, { recursive }); },
    unlink: () => { fs.unlinkSync(at); },
    rmdir: () => { fs.rmdirSync(at); },
    stat: () => fs.lstatSync(at, { throwIfNoEntry: false }),
    list: (read) => read(fs.readdirSync(at, { withFileTypes: true }).map((entry) => listed(entry.name, entry, () => fs.lstatSync(path.join(at, entry.name), { throwIfNoEntry: false })))),
  };
}

/**
 * One entry of a held directory: its name, its kind as the directory reports it, and its own stat, a link's being the
 * link's (`stat()`, undefined once it is gone), read through the directory while `list(read)` runs `read`. A link is never
 * followed here: what it leads to is judged by the caller.
 */
function listed(name, dirent, stat) {
  return { name, isDirectory: () => dirent.isDirectory(), isSymbolicLink: () => dirent.isSymbolicLink(), stat };
}

/**
 * `name` in the directory the descriptor `dir` holds, on Linux: `/proc/self/fd/<dir>/<name>` is resolved from that
 * directory wherever it is now, so each call is node:fs's own on that path, and a failure names `shown` instead.
 */
function procEntry(dir, name, shown) {
  const at = `/proc/self/fd/${dir}/${name}`;
  const entry = entryAt(at, O_NOFOLLOW);

  const named = (call) => (...args) => {
    try {
      return call(...args);
    } catch (cause) {
      if (typeof cause.path === 'string') {
        cause.message = cause.message.split(cause.path).join(shown);
        cause.path = shown;
      }

      throw cause;
    }
  };

  return {
    openDir: named(() => fs.openSync(at, O_PATH | O_DIRECTORY | O_NOFOLLOW)),
    exists: () => fs.existsSync(at),
    isLink: () => fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === true,
    open: named(entry.open),
    mkdir: named(entry.mkdir),
    unlink: named(entry.unlink),
    rmdir: named(entry.rmdir),
    stat: named(() => fs.lstatSync(at, { throwIfNoEntry: false })),
    // The directory is held by its own descriptor while it is read, so a link swapped in for it meanwhile reads nothing.
    list: named((read) => {
      const held = fs.openSync(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);

      try {
        const through = `/proc/self/fd/${held}`;

        return read(fs.readdirSync(through, { withFileTypes: true })
          .map((child) => listed(child.name, child, () => fs.lstatSync(`${through}/${child.name}`, { throwIfNoEntry: false }))));
      } finally {
        fs.closeSync(held);
      }
    }),
  };
}

const procRoot = () => fs.openSync('/', O_PATH | O_DIRECTORY | O_NOFOLLOW);

// macOS's own flags, from sys/fcntl.h (Xcode 26.6 SDK). O_SEARCH holds a directory for lookups through it with only
// search permission on it, as Linux's O_PATH does: measured 2026-10-18 on macOS 15 and 26, it opens a mode 0311
// directory O_RDONLY cannot, and openat and mkdirat work through it. O_CLOEXEC is what node:fs adds to its own opens.
const DARWIN_O_SEARCH = 0x40000000 | O_DIRECTORY;

const DARWIN_O_CLOEXEC = 0x1000000;

// sys/fcntl.h: O_SYMLINK opens a link itself; O_NONBLOCK keeps a stat's open of a FIFO from waiting for a writer.
const DARWIN_O_SYMLINK = 0x200000;

const DARWIN_O_NONBLOCK = 0x4;

const DARWIN_AT_REMOVEDIR = 0x80;

let libSystem = null;

/**
 * The directory-relative calls macOS has and node:fs does not expose, from libSystem. `openat`'s mode is variadic, and
 * arm64 macOS reads a variadic argument from the stack, never a register: the mode goes in both, its own register and,
 * past the four unused ones, the first stack slot, as Go's runtime does (runtime/sys_darwin_arm64.s); x86_64 reads it
 * from its register. Measured 2026-10-18 with Bun 1.4.3: bound with four arguments, every file openat created on arm64
 * macOS 26.6 had mode 0510 whatever was asked, and on x86_64 macOS 15 the mode asked; bound this way, both had it.
 */
function darwinCalls() {
  if (libSystem !== null) return libSystem;
  const { dlopen, read } = require('bun:ffi');

  const { symbols } = dlopen('/usr/lib/libSystem.B.dylib', {
    openat: { args: ['i32', 'buffer', 'i32', 'u32', 'u64', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' },
    mkdirat: { args: ['i32', 'buffer', 'u16'], returns: 'i32' },
    unlinkat: { args: ['i32', 'buffer', 'i32'], returns: 'i32' },
    faccessat: { args: ['i32', 'buffer', 'i32', 'i32'], returns: 'i32' },
    readlinkat: { args: ['i32', 'buffer', 'buffer', 'u64'], returns: 'i64' },
    __error: { args: [], returns: 'ptr' },
  });

  /** The failure the call just made, as node:fs words one; called first, before anything else can set errno. */
  const failure = (syscall, shown) => {
    const errno = read.i32(symbols.__error(), 0);
    const code = util.getSystemErrorName(-errno);

    return Object.assign(new Error(`${code}: ${util.getSystemErrorMessage(-errno)}, ${syscall} '${shown}'`), {
      errno: -errno, code, syscall, path: shown,
    });
  };

  libSystem = {
    symbols,
    failure,
    openat: (dir, name, flags, mode) => symbols.openat(dir, name, flags | DARWIN_O_CLOEXEC, mode, 0, 0, 0, 0, mode),
  };

  return libSystem;
}

/** `name` in the directory the descriptor `dir` holds, on macOS: each call relative to it, a failure naming `shown`. */
function darwinEntry(dir, name, shown) {
  // A C string ends at its first NUL, so such a name would reach another entry: refused, as node:fs refuses the path.
  if (name.includes('\0')) {
    throw Object.assign(new TypeError(`The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(shown)}`), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
  }

  const { symbols, failure, openat } = darwinCalls();
  const bytes = Buffer.from(`${name}\0`);

  const ok = (result, syscall) => {
    if (result < 0) throw failure(syscall, shown);

    return result;
  };

  return {
    openDir: () => ok(openat(dir, bytes, DARWIN_O_SEARCH | O_NOFOLLOW, 0), 'open'),
    exists: () => symbols.faccessat(dir, bytes, 0, 0) === 0,
    isLink: () => symbols.readlinkat(dir, bytes, Buffer.alloc(1), 1) >= 0,
    open: (flags, mode = 0o666) => ok(openat(dir, bytes, flags | O_NOFOLLOW, mode), 'open'),
    mkdir: (recursive) => {
      if (symbols.mkdirat(dir, bytes, 0o777) === 0) return;
      const cause = failure('mkdir', shown);

      // A recursive mkdir of a directory already there, or of a link to one, makes nothing and succeeds, as node:fs's.
      // A trailing slash resolves only a directory, with no permission on it (measured 2026-10-18, macOS 15 and 26).
      if (!recursive || cause.code !== 'EEXIST' || symbols.faccessat(dir, Buffer.from(`${name}/\0`), 0, 0) !== 0) throw cause;
    },
    unlink: () => { ok(symbols.unlinkat(dir, bytes, 0), 'unlink'); },
    rmdir: () => { ok(symbols.unlinkat(dir, bytes, DARWIN_AT_REMOVEDIR), 'rmdir'); },
    // The entry itself, a link's being the link's: opened without following it (O_SYMLINK for a link), then fstat.
    stat: () => {
      const opened = openat(dir, bytes, O_RDONLY | O_NOFOLLOW | DARWIN_O_NONBLOCK, 0);
      const held = opened >= 0 ? opened : linkOrMissing(() => openat(dir, bytes, O_RDONLY | DARWIN_O_SYMLINK, 0), () => failure('open', shown));

      if (held === null) return undefined;

      try {
        return fs.fstatSync(held);
      } finally {
        fs.closeSync(held);
      }
    },
    // macOS opens /dev/fd/N as a dup of descriptor N, so the held directory is read where it is, not by its path.
    list: (read) => {
      const held = ok(openat(dir, bytes, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0), 'open');

      try {
        return read(fs.readdirSync(`/dev/fd/${held}`, { withFileTypes: true }).map((entry) => {
          const inside = darwinEntry(held, entry.name, path.join(shown, entry.name));

          return listed(entry.name, entry, () => inside.stat());
        }));
      } finally {
        fs.closeSync(held);
      }
    },
  };
}

/** A link's own descriptor (`openLink`, O_SYMLINK), when the no-follow open met one; null when nothing is there now.
 *  `failure` is the last open's error, read before anything else can set it. */
function linkOrMissing(openLink, failure) {
  const cause = failure();

  if (cause.code === 'ENOENT') return null;

  if (cause.code !== 'ELOOP') throw cause;
  const link = openLink();

  if (link < 0) throw failure();

  return link;
}

const darwinRoot = () => fs.openSync('/', O_RDONLY | O_DIRECTORY);

/**
 * Runs one synchronous mutation `act` on the path a sandboxed view judged, where it still is when the mutation runs: a
 * frame waits in the checkpoint queue, and a command on this device may meanwhile swap a directory of the path for a
 * link out of the consented root. The directory is opened from `/` one component at a time without following a link,
 * each held by its descriptor, and a missing one `createParents` allows is made inside the one held. `act` gets the
 * entry relative to the last, `{ open(flags, mode), mkdir(recursive), unlink(), rmdir() }`: no later swap moves it, and
 * a judged path names no link, so `open` refuses one found in its place. Linux reaches a held directory through
 * /proc/self/fd, macOS through libSystem's *at calls. A raw view judged nothing the device's commands cannot reach
 * themselves, so its path is used as it is, links and all.
 */
function atJudged(view, judged, { createParents = false } = {}, act) {
  if (view.raw === true) {
    if (createParents) fs.mkdirSync(path.dirname(judged), { recursive: true });

    return act(entryAt(judged));
  }

  const darwin = process.platform === 'darwin';
  const entryOf = darwin ? darwinEntry : procEntry;
  let fd = darwin ? darwinRoot() : procRoot();

  try {
    for (const name of path.dirname(judged).split('/').filter((part) => part !== '')) {
      const next = entryOf(fd, name, judged);
      let opened;

      try {
        if (createParents && !next.exists()) next.mkdir(false);
        opened = next.openDir();
      } catch (cause) {
        if (next.isLink()) throw movedUnderneath(judged, cause);
        throw cause;
      }

      fs.closeSync(fd);
      fd = opened;
    }

    return act(entryOf(fd, path.basename(judged), judged));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { atJudged, movedUnderneath };
