'use strict';

const { log, errorDetail } = require('./log.js');

/**
 * A sealed folder through Landlock (Linux 5.19+, ABI 2): no new entry can be made directly in it, while what is already
 * there stays writable, removable and can be moved out. A read-only bind of the folder (the mounts' seal) cannot do
 * that: unlinking an entry writes its folder, so a home sealed for a missing ~/.zshrc refused even `rm ~/old.txt`.
 *
 * Landlock is an allow-list whose rules cover a whole hierarchy, so "no making directly in S" is every directory off
 * the path to S granted MAKE_*, and the directories on that path (S and its ancestors) granted none. An ancestor of a
 * sealed folder therefore takes no new entry at its own level either: / and /home never did for an owner, and a temp
 * root holding a sealed home (a test's) is given a TMPDIR below it (sandbox.js). REFER, which a ruleset denies unless
 * it handles it, is granted everywhere, so files still move between folders; Landlock refuses a move that would gain
 * MAKE_* (a sealed folder into a granted one).
 *
 * The rules are made inside the sandbox, by SEAL_LAUNCHER, over the tree the command sees, then the command is exec'd
 * from the same thread with the ruleset in force. It fails closed: a seal it cannot apply runs nothing.
 */

/** Where the daemon's own Bun sits inside the sandbox, to run SEAL_LAUNCHER. */
const SEAL_RUNTIME = '/kinu-seal/bun';

/** The Landlock ABI the seal needs: 2, for REFER; under 1 every move between folders is refused. */
const SEAL_ABI = 2;

/** The x86_64 and aarch64 numbers, alike since Linux 5.13 (asm-generic/unistd.h). */
const SYS_LANDLOCK_CREATE_RULESET = 444;

const LANDLOCK_CREATE_RULESET_VERSION = 1;

let abi = null;

/** This kernel's Landlock ABI, 0 when it has none or this is not Linux. */
function landlockAbi() {
  if (abi !== null) return abi;
  abi = 0;

  if (process.platform !== 'linux' || !('bun' in process.versions)) return abi;

  try {
    const { dlopen } = require('bun:ffi');
    const { symbols } = dlopen('libc.so.6', { syscall: { args: ['i64', 'i64', 'i64', 'i64'], returns: 'i64' } });
    const version = Number(symbols.syscall(SYS_LANDLOCK_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION));

    abi = version > 0 ? version : 0;
  } catch (error) {
    // A libc this cannot open (not glibc): the seal falls back to mounts, which the plan's notes name.
    log('sandbox.landlock_unprobed', errorDetail(error));
  }

  return abi;
}

/**
 * Run by `bun -e` inside the sandbox as `SEAL_RUNTIME --config=/dev/null -e SEAL_LAUNCHER -- <spec> <program> <args…>`,
 * with no environment and `/` its directory, so neither a repository's bunfig nor an agent's variables reach Bun. The
 * spec is `{ sealed, cwd, env }`. Before the ruleset is in force it runs nothing but its own reads.
 */
const SEAL_LAUNCHER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { dlopen, ptr } = require('bun:ffi');
const fail = (why) => { process.stderr.write("Kinu's sandbox could not seal this command's folders, so it did not run it: " + why + '\n'); process.exit(126); };
const [specText, ...program] = process.argv.slice(1);
let spec;
try { spec = JSON.parse(specText); } catch { fail('its plan was unreadable'); }
const libc = dlopen('libc.so.6', {
  syscall: { args: ['i64', 'i64', 'i64', 'i64', 'i64'], returns: 'i64' },
  prctl: { args: ['i32', 'u64', 'u64', 'u64', 'u64'], returns: 'i32' },
  open: { args: ['ptr', 'i32'], returns: 'i32' },
  close: { args: ['i32'], returns: 'i32' },
  chdir: { args: ['ptr'], returns: 'i32' },
  execve: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
  __errno_location: { args: [], returns: 'ptr' },
}).symbols;
const errno = () => new Int32Array(require('bun:ffi').toArrayBuffer(libc.__errno_location(), 0, 4))[0];
const cstr = (text) => Buffer.from(text + '\0');
const MAKE = 0x1fc0, REFER = 0x2000;
const abi = Number(libc.syscall(444, 0, 0, 1, 0));
if (abi < 2) fail('this kernel has no Landlock ABI 2 (it answered ' + abi + ')');
const attr = new BigUint64Array([BigInt(MAKE | REFER)]);
const ruleset = Number(libc.syscall(444, ptr(attr), 8, 0, 0));
if (ruleset < 0) fail('creating its ruleset failed (errno ' + errno() + ')');
const grant = (dir, access) => {
  const name = cstr(dir);
  const fd = libc.open(ptr(name), 0o10000000 | 0o2000000);
  if (fd < 0) return;
  const rule = Buffer.alloc(12);
  rule.writeBigUInt64LE(BigInt(access), 0);
  rule.writeInt32LE(fd, 8);
  const added = Number(libc.syscall(445, ruleset, 1, ptr(rule), 0, 0));
  libc.close(fd);
  if (added < 0) fail('granting ' + dir + ' failed (errno ' + errno() + ')');
};
const chain = new Set();
for (const sealed of spec.sealed) for (let dir = sealed; ; dir = path.dirname(dir)) { chain.add(dir); if (dir === path.dirname(dir)) break; }
grant('/', REFER);
const walk = (dir) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (chain.has(full)) walk(full); else grant(full, MAKE | REFER);
  }
};
walk('/');
if (libc.prctl(38, 1, 0, 0, 0) !== 0) fail('no_new_privs could not be set (errno ' + errno() + ')');
if (Number(libc.syscall(446, ruleset, 0, 0, 0, 0)) !== 0) fail('its ruleset could not be enforced (errno ' + errno() + ')');
libc.close(ruleset);
const cwd = cstr(spec.cwd);
if (libc.chdir(ptr(cwd)) !== 0) fail('its directory ' + spec.cwd + ' could not be entered (errno ' + errno() + ')');
const dirs = String(spec.env.PATH ?? '/usr/bin:/bin').split(':');
const file = program[0].includes('/') ? program[0] : dirs.map((dir) => path.join(dir, program[0])).find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
if (file === undefined) fail(program[0] + ' was not found on its PATH');
const strings = (list) => { const bufs = list.map(cstr); const table = new BigUint64Array(bufs.length + 1); bufs.forEach((buf, at) => { table[at] = BigInt(ptr(buf)); }); return { bufs, table }; };
const args = strings(program);
const env = strings(Object.entries(spec.env).map(([name, value]) => name + '=' + value));
const target = cstr(file);
libc.execve(ptr(target), ptr(args.table), ptr(env.table));
fail('exec ' + file + ' failed (errno ' + errno() + ')');
`;

module.exports = { SEAL_RUNTIME, SEAL_ABI, SEAL_LAUNCHER, landlockAbi };
