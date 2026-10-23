// Kinu device sandbox — ONE path policy, two enforcers.
//
// The kernel enforces it for `exec` (bubblewrap on Linux, sandbox-exec on
// macOS) and this module enforces the same policy in JS for the file methods
// (readFile/writeFile/listFiles/…). That is the point of putting it here: two
// enforcers reading two policies is how a file method comes to serve a path the
// shell cannot see, and the owner would have no way to know which one is the
// truth. `viewFor` returns the object both ask.
//
// The visible set is an ALLOW-LIST. The rejected design was "read-only disk
// plus a deny-list of credential directories", and it fails on one miss:
// ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker/config.json, ~/.netrc,
// ~/.npmrc, ~/.config/gh, a second drive at /data, a mounted share —
// the list has no end. So on Linux a command sees the system trees a program
// needs to start, its own home and tmp, and the directories the owner named
// at `kinu connect`, and nothing else exists.
//
// Dependency-free CommonJS, like index.js: the CLI ships both files beside each
// other and there is no install step that could fetch a third.
'use strict';

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const util = require('node:util');

const { execFile } = require('node:child_process');

const update = require('./update.js');

const { fromDotenv, launchDotenv: suppliedBy, launchDotenvFiles, unsandboxedCommandEnvironment } = require('../../core/src/cli/command-env.ts');

const { MACHINE_SANDBOX_REASONS } = require('../../core/src/execution/machine-sandbox-reasons.ts');

const { RUN_LATER, RUN_LATER_NAMES } = require('../../core/src/execution/run-later-paths.ts');

const { SEAL_ABI, SEAL_LAUNCHER, SEAL_RUNTIME, landlockAbi } = require('./daemon/landlock.js');

const { runToExit } = update;

/** Why a machine cannot sandbox, keyed by the word upper-cased (`NO_BWRAP`). `ok` is the only status that runs a
 *  command; every other value is the hub's own `reason` word (core's MACHINE_SANDBOX_REASONS), reported to it, and it
 *  refuses `exec` and says so rather than silently running the command unprotected. `probe_failed` is for a bwrap that
 *  ran and failed in a way this module does not recognise. */
const SANDBOX_STATUS = Object.freeze({
  OK: 'ok',
  ...Object.fromEntries(MACHINE_SANDBOX_REASONS.map((reason) => [reason.toUpperCase(), reason])),
});

/** Every hint names the command that fixes the machine. A status the owner
 *  cannot act on is a status that reads as "Kinu is broken". */
const PROBE_HINTS = Object.freeze({
  [SANDBOX_STATUS.NO_BWRAP]:
    'bubblewrap is not installed. Fix: sudo apt install bubblewrap, '
    + 'sudo dnf install bubblewrap, or sudo pacman -S bubblewrap',
  [SANDBOX_STATUS.NO_USERNS]:
    'bwrap could not create a user namespace. On Ubuntu 23.10 and later this is '
    + 'kernel.apparmor_restrict_unprivileged_userns=1. Fix: sudo apt install bubblewrap '
    + "(the distro package ships the AppArmor profile that permits it), or "
    + 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
  [SANDBOX_STATUS.WSL1]:
    'WSL1 cannot create user namespaces. Fix: wsl --set-version <distro> 2',
  [SANDBOX_STATUS.NO_SANDBOX_EXEC]:
    'this macOS has no /usr/bin/sandbox-exec. Turn the device\'s Sandbox switch off in '
    + 'Settings to run commands without isolation, or wait for a Kinu release with a replacement',
  [SANDBOX_STATUS.UNSUPPORTED_PLATFORM]:
    'Kinu sandboxes commands on Linux and macOS only',
});

/** bwrap's own words for "no user namespace", across versions. Matched against
 *  stderr because bwrap's exit code does not distinguish this from any other
 *  setup failure, and the difference decides whether the owner is told to
 *  install a package or shown a raw error. */
const USERNS_REFUSALS = [
  'No permissions to create a new namespace',
  'setting up uid map',
  'Operation not permitted',
  'Permission denied',
];

/**
 * What a Linux command may READ beyond its own directories and the consented
 * ones: the trees a program needs to start, and no tree a person keeps files
 * in. Codex's bubblewrap sandbox reads the same list when a policy asks for
 * platform defaults (`LINUX_PLATFORM_DEFAULT_READ_ROOTS`,
 * codex-rs/linux-sandbox/src/bwrap.rs at openai/codex 39598ed17, read
 * 2026-09-22), plus `/lib32` and `/libx32` for multilib programs, `/opt`,
 * where ROCm, Arch's CUDA and conda install a GPU job's runtime, and `/sys`:
 * NVML and the CUDA driver find the GPU through it, and without it `cuInit`
 * answers CUDA_ERROR_OPERATING_SYSTEM (measured 2026-09-22, driver 595.84,
 * RTX 4080).
 */
const LINUX_READ_ROOTS = Object.freeze([
  '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/sys',
  '/nix/store', '/run/current-system/sw',
]);

/** The shared temp roots. Inside the sandbox each one IS the agent's tmp, so a
 *  tool that writes /var/tmp works and never sees another process's files. */
const LINUX_TEMP_ROOTS = Object.freeze(['/tmp', '/var/tmp']);

/** Sockets a consented directory could hold, shadowed by /dev/null because a
 *  tmpfs cannot replace a file. Membership of the docker group is root on the
 *  host, the one real escape hatch on an ordinary developer machine. */
const LINUX_MASK_FILES = Object.freeze([
  '/run/docker.sock', '/var/run/docker.sock',
]);

/** Entries a plan reads of each writable root looking for repositories and
 *  startup-file links; the bound on a plan's cost. A root with more is named in
 *  the plan result, so the model is told which repositories went unguarded.
 *  Measured 2026-09-27 on ext4 NVMe at load ~10, a root past the cap (150,000
 *  files): 51-61 ms warm. Cold is unmeasured here (no way to drop the dentry
 *  cache without root); review job 195 measured about 3.3 s on a huge shared
 *  folder. */
const GUARD_ENTRIES = 50_000;

/** Folders the guard's walk never enters: no repository the owner commits in lives in a dependency or cache tree. */
const WALK_SKIPPED = new Set(['node_modules', '.cache']);

/** Repositories asked of git at once: each question is two short git processes. */
const GIT_QUESTIONS_AT_ONCE = 8;

/** SBPL has no mount namespace to swap a home into, so macOS denies these
 *  subpaths and re-allows the agent home and the consented roots after. The
 *  later rule wins in SBPL, which is the mechanism this relies on. */
const MAC_DENY_SUBPATHS = Object.freeze([
  '/Users', '/Volumes', '/private/var/root',
]);

/**
 * A SANDBOXED command's environment, by ALLOW-LIST. The daemon inherits the
 * shell that ran `kinu connect`, so its own environment can hold the CLI
 * bearer, a GitHub PAT, cloud keys and SSH_AUTH_SOCK, and the sandbox that
 * hides ~/.aws/credentials must not hand over AWS_SECRET_ACCESS_KEY. Only the
 * names a POSIX command needs to find its tools, its home, its locale, its
 * clock, its terminal's colours and its proxy cross. NODE_OPTIONS and
 * BUN_INSPECT are excluded by not being here, which is the property an
 * allow-list has and a deny-list cannot.
 */
const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_RUNTIME_DIR', 'TZ', 'COLORTERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);

const ENV_ALLOWLIST_FAMILY = /^LC_[A-Z_]+$/;

/**
 * The values dotenv files put into this process at launch, by name: the files Bun loads from its working directory
 * for NODE_ENV and wrangler's `.dev.vars` (core's `launchDotenvFiles`). They are the project's secrets, not the owner's
 * shell, so no command inherits them. A file that is there but cannot be read stops the daemon, which could otherwise
 * pass on what it held.
 */
function launchDotenv(dir, nodeEnv) {
  return suppliedBy(launchDotenvFiles(nodeEnv).flatMap((file) => {
    let text;

    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }

    return [util.parseEnv(text)];
  }));
}

/** An UNSANDBOXED command's environment, as core decides it for the CLI's shell too (`unsandboxedCommandEnvironment`):
 *  this daemon's own, as the owner's shell would give it, less what Kinu reads from it and what a dotenv file supplied. */
function rawEnvironment(source, dotenv) {
  return unsandboxedCommandEnvironment(source, dotenv);
}

/** GPU character devices, enumerated at every exec rather than at daemon start
 *  so a driver loaded after the daemon is picked up. `/dev/dri` covers Intel,
 *  AMD, ROCm and every Vulkan/OpenCL stack; `/dev/kfd` is ROCm's compute node;
 *  `/dev/dxg` is WSL2's. `--dev /dev` alone is an empty devtmpfs with none of
 *  them, which is why a sandbox that stops there has no GPU at all. */
function gpuNodes(devDir = '/dev') {
  const found = [];
  let entries;

  try {
    entries = fs.readdirSync(devDir);
  } catch (err) {
    // No /dev to read is not a machine without a GPU, it is a machine this
    // function cannot answer about; an empty list is the honest answer and the
    // exec still runs. Anything other than "not there" is real breakage.
    if (!err || (err.code !== 'ENOENT' && err.code !== 'EACCES')) throw err;

    return found;
  }

  for (const entry of entries) {
    if (entry.startsWith('nvidia')) found.push(path.join(devDir, entry));
  }

  for (const extra of ['dri', 'kfd', 'dxg']) {
    const candidate = path.join(devDir, extra);

    if (fs.existsSync(candidate)) found.push(candidate);
  }

  return found.sort((a, b) => (a < b ? -1 : 1));
}

/**
 * `/dev/nvidia-uvm` and `/dev/nvidia-modeset` are created lazily by the setuid
 * `nvidia-modprobe`, which cannot run inside the sandbox because unprivileged
 * bwrap sets PR_SET_NO_NEW_PRIVS. So the daemon creates them from OUTSIDE,
 * once, exactly as nvidia-container-toolkit does. Failure is a detail, never
 * fatal: a machine without CUDA still runs commands.
 */
async function ensureUvmNode(devDir = '/dev') {
  if (!fs.existsSync(path.join(devDir, 'nvidiactl'))) return null;

  if (fs.existsSync(path.join(devDir, 'nvidia-uvm'))) return null;
  const { error } = await runToExit('nvidia-modprobe', ['-u', '-c', '0'], {});

  if (error === null) return null;

  if (error.code === 'ENOENT') return 'nvidia-modprobe is not installed, so /dev/nvidia-uvm was not created';

  if (!Number.isInteger(error.code)) return `nvidia-modprobe failed: ${error.message}`;

  return `nvidia-modprobe exited ${error.code}, so /dev/nvidia-uvm was not created`;
}

function trimPath(value) {
  const resolved = path.resolve(value);

  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/** The kernel's own bound on links followed in one lookup (Linux MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;

/** Gone, unreadable, or a loop: a path with nothing there yet, composed on rather than refused. */
function missingPath(err) {
  return err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'ELOOP');
}

/**
 * The requested path walked as the kernel walks it, one name at a time, each
 * link read where it is met: `reached` is the deepest directory or file that
 * exists, no link in it, and `rest` the names past it that do not exist yet.
 * A component that stops being a link between its lstat and its read is walked
 * again, within the kernel's own hop bound.
 */
function walkTarget(requested, hops = 0) {
  const parts = trimPath(requested).split('/').filter(Boolean);
  let reached = '/';

  for (const [at, part] of parts.entries()) {
    const entry = path.join(reached, part);
    let stat;

    try {
      stat = fs.lstatSync(entry);
    } catch (err) {
      if (!missingPath(err)) throw err;

      return { reached, rest: parts.slice(at) };
    }

    if (!stat.isSymbolicLink()) {
      reached = entry;
      continue;
    }

    if (hops >= MAX_LINK_HOPS) {
      throw Object.assign(new Error(`device path '${requested}' crosses too many symbolic links`), { code: 'ELOOP' });
    }

    let target;

    try {
      target = fs.readlinkSync(entry);
    } catch (err) {
      // Gone, or no longer a link, since its lstat: the path changed under this walk, so it starts over.
      if (err && (err.code === 'ENOENT' || err.code === 'EINVAL')) return walkTarget(requested, hops + 1);
      throw err;
    }

    return walkTarget(path.resolve(reached, target, ...parts.slice(at + 1)), hops + 1);
  }

  return { reached, rest: [] };
}

/** How many times a macOS path is walked again when realpath named something else meanwhile. */
const REALPATH_AGREEMENT_ATTEMPTS = 8;

/** The same path on a case- and normalization-insensitive volume, as macOS's are by default. */
function sameOnVolume(left, right) {
  const fold = (spelled) => spelled.normalize('NFD').toLowerCase();

  return fold(left) === fold(right);
}

/**
 * The path a syscall will actually REACH: every symlink followed, a DANGLING
 * one included, since a write through a link whose target is absent creates
 * that target; the part of the path that does not exist yet is composed on.
 *
 * Decided on the destination rather than the spelling, because a symlink in a
 * writable directory pointing into Kinu's own is a read of Kinu's own, and
 * every file method here follows links.
 *
 * Composed from the names asked for (`walkTarget`), never from realpath's word
 * alone: Bun 1.4.3's realpathSync answered mid-rename with a directory's new
 * name or its parent's, so a frame naming `project/inner` was judged, and
 * acted, at `project` (LEDGER-L111, 2026-10-19; daemon.test.js, "acts on the
 * path it named"). On macOS the volume ignores case, and the roots and Kinu's
 * own directory are compared in its own: there the existing part is named as
 * realpath names it, taken only where that is the walked path in another case,
 * so `/USERS/me/.KINU` is Kinu's own directory and a renamed sibling is never.
 */
function realTarget(requested) {
  let walked = walkTarget(requested);

  if (process.platform !== 'darwin') return path.join(walked.reached, ...walked.rest);

  for (let attempt = 0; attempt < REALPATH_AGREEMENT_ATTEMPTS; attempt += 1) {
    const real = realPathOrNull(walked.reached);

    if (real !== null && sameOnVolume(real, walked.reached)) return path.join(real, ...walked.rest);
    walked = walkTarget(requested);
  }

  throw Object.assign(new Error(`device path '${requested}' kept changing while it was checked; try again`), { code: 'EAGAIN' });
}

/** Whether `target` is `root` itself or below it, decided on resolved paths so
 *  a prefix like `/home/dev-old` never reads as inside `/home/dev`. */
function within(root, target) {
  if (target === root) return true;

  return target.startsWith(root === '/' ? '/' : `${root}/`);
}

/** The path a syscall reaches, or null when nothing is there. */
function realPathOrNull(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch (err) {
    if (!missingPath(err)) throw err;

    return null;
  }
}

/** A path's metadata, or null when it cannot be read: absent, or behind a directory this user may not open. */
function statOrNull(candidate) {
  try {
    return fs.statSync(candidate);
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'EACCES' && err.code !== 'ENOTDIR' && err.code !== 'ELOOP')) throw err;

    return null;
  }
}

/** A path's own metadata, a link's being the link's, or null when nothing is there. */
function lstatOrNull(candidate) {
  try {
    return fs.lstatSync(candidate);
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;

    return null;
  }
}

/** A directory's entries, or none when it cannot be listed. */
function entriesOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'EACCES' && err.code !== 'ENOTDIR' && err.code !== 'EPERM')) throw err;

    return [];
  }
}

/*
 * THE INVARIANT this section keeps, checked as a whole: code git runs on the
 * owner's ordinary commands, named by git's configuration, is never writable
 * to the agent. Every repository in or around a writable root (found down by
 * its `.git` or as a bare git directory, and out by asking git from each root
 * upward, repository after repository) is asked of git, with every
 * configuration level; each hooks and template directory, config file, and
 * program a config value names that lands in a writable root is bound
 * read-only, and so is each linked worktree's `.git` file and each worktree's
 * gitdir and commondir record. Every folder from a writable root down to a
 * kept path is pinned (pinAncestors), so none of them can be moved aside and
 * replaced by a writable copy; the cost is that the agent cannot rename or
 * remove a repository, or a folder holding one. What cannot be asked is named
 * in plan.unguarded, with why. Build and test scripts are code the owner runs
 * too, and are not covered: the consent line says so.
 */

/** git-config(1) keys, as of git 2.56, whose value is a program git runs (an alias only when it starts with `!`), as
 *  git prints them: lowercase but for a subsection. A key an older git lacks names a program it never runs. */
const PROGRAM_KEYS = new RegExp('^(core\\.(fsmonitor|pager|editor|sshcommand|askpass|gitproxy|alternaterefscommand)'
  + '|sequence\\.editor|pager\\..+|credential\\.(.+\\.)?helper|gpg\\.(.+\\.)?program|gpg\\.ssh\\.defaultkeycommand'
  + '|diff\\.external|diff\\..+\\.(command|textconv)|merge\\..+\\.driver|filter\\..+\\.(clean|smudge|process)'
  + '|(merge|diff)tool\\..+\\.(cmd|path)|interactive\\.difffilter|remote\\..+\\.(uploadpack|receivepack)'
  + '|hook\\..+\\.command|trailer\\..+\\.(cmd|command)|uploadpack\\.packobjectshook|gc\\.recentobjectshook'
  + '|imap\\.tunnel|(browser|man)\\..+\\.(cmd|path)|guitool\\..+\\.cmd|alias\\..+)$', 'u');

/** Values of those keys that switch a built-in on or off rather than name a program. */
const SWITCH_VALUES = new Set(['', 'true', 'false', 'yes', 'no', 'on', 'off', '1', '0']);

/** The environment git is asked in: none of the daemon's own GIT_*, which could answer for another repository. A
 *  `ceiling` keeps a repository git cannot read from being answered for by one around it. */
function gitEnvironment(home, ceiling) {
  const env = { HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: ceiling };

  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

/** `git -C <at> <args>`: its exit code (-1 when git could not run) and what it printed. */
function gitIn(at, args, env) {
  return new Promise((resolve) => {
    execFile('git', ['-C', at, ...args], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });

        return;
      }

      // A code that is no exit status is git failing to start (ENOENT).
      const code = Number.isInteger(error.code) ? error.code : -1;
      resolve({ code, stdout, stderr: code === -1 ? String(error.message) : stderr });
    });
  });
}

const leadingLine = (text) => text.trim().split('\n')[0];

/**
 * Every value git reads at `level` (all of them for `[]`) with where it read it, asked through
 * `git config --get-regexp --show-origin --includes -z`, each `<origin>\0<key>\n<value>\0`; nothing is parsed here.
 */
async function configAt(dir, env, level) {
  const read = await gitIn(dir, ['config', ...level, '--get-regexp', '--show-origin', '--includes', '-z', '.'], env);

  // 1 with nothing said: no value at that level.
  if (read.code === 1 && read.stderr.trim() === '') return { entries: [] };

  if (read.code !== 0) return { refused: leadingLine(read.stderr) };
  const fields = read.stdout.split('\0');
  const entries = [];

  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [key = '', ...value] = fields[index + 1].split('\n');
    entries.push({ origin: fields[index], key, value: value.join('\n') });
  }

  return { entries };
}

/**
 * One repository asked of git from `at` (its working tree, or its git directory when it is bare): the git directory,
 * the common one, the hooks directory git would run (worktrees, commondir, config.worktree, core.hooksPath at every
 * level through includes), and every value git reads for it. Neither command runs a hook or fsmonitor: neither
 * reads the index. Measured 2026-09-25: 1.6-1.9 ms for one repository, 7-21 ms for twenty asked concurrently.
 */
async function askRepository(at, home) {
  const env = gitEnvironment(home, path.dirname(at));
  const where = await gitIn(at, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--git-path', 'hooks'], env);

  if (where.code !== 0) return { refused: leadingLine(where.stderr) };
  const config = await configAt(at, env, []);

  if (config.refused !== undefined) return config;
  const [gitDir, commonDir, hooks] = where.stdout.trim().split('\n');

  return { gitDir, commonDir, hooks, entries: config.entries };
}

/** Where git runs for the repository that holds `from`: its working tree, or its git directory when `from` is in
 *  one (a bare repository's, or a `.git`). Null when none holds it, or `{ refused }`. */
async function repositoryHolding(from, env) {
  const where = await gitIn(from, ['rev-parse', '--path-format=absolute', '--git-dir', '--is-bare-repository', '--is-inside-git-dir'], env);

  if (where.code !== 0) return /not a git repository/u.test(where.stderr) ? null : { refused: leadingLine(where.stderr) };
  const [gitDir, bare, insideGitDir] = where.stdout.trim().split('\n');

  if (bare === 'true' || insideGitDir === 'true') return { at: gitDir };
  const top = await gitIn(from, ['rev-parse', '--path-format=absolute', '--show-toplevel'], env);

  return top.code === 0 ? { at: top.stdout.trim() } : { refused: leadingLine(top.stderr) };
}

/**
 * Git's answers, kept while every file each came from is as it was: a file method asks the guard on every write, and
 * git's processes are most of its cost (the daemon's link-swap race writes 2,000 times). A file's signature is its
 * inode, size, and change and modify times in nanoseconds; an answer whose file changed while git was being asked is
 * not kept, so a kept answer is never older than its files.
 */
const gitAnswers = new Map();

/** What `file` is now, to tell whether it changed: '-' when nothing is there. */
function signatureOf(file) {
  let stat;

  try {
    stat = fs.statSync(file, { bigint: true });
  } catch (err) {
    // Nothing there, or a file where a folder would be: that is the state too.
    if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;

    return '-';
  }

  return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeNs)}:${String(stat.ctimeNs)}`;
}

/** `ask`'s answer for `key`, asked again only when a file `filesOf` names for it has changed since it was kept. */
async function remembered(key, filesOf, ask) {
  const kept = gitAnswers.get(key);

  if (kept !== undefined && kept.files.every((file, at) => signatureOf(file) === kept.signatures[at])) return kept.answer;
  // Wall clock, as a file's change time is, a millisecond early for the clocks' rounding.
  const askedAt = BigInt(Date.now() - 1) * 1_000_000n;
  const answer = await ask();
  const files = filesOf(answer);
  const signatures = files.map(signatureOf);
  const changedMeanwhile = signatures.some((signature) => signature !== '-' && BigInt(signature.split(':')[3] ?? '0') >= askedAt);

  if (changedMeanwhile) gitAnswers.delete(key);
  else gitAnswers.set(key, { answer, files, signatures });

  return answer;
}

/** The files the owner's global and the machine's system git configuration are read from, as git looks for them. */
function globalConfigFiles(home) {
  return [path.join(home, '.gitconfig'), path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'git', 'config'), '/etc/gitconfig'];
}

/** Every file a configuration answer read, through its includes. */
const originsOf = (answer) => (answer.entries ?? []).filter((entry) => entry.origin.startsWith('file:')).map((entry) => entry.origin.slice('file:'.length));

/** Each directory from `from` up to the root: a `.git` made or removed in one changes it. */
function ancestorsOf(from) {
  const dirs = [];

  for (let dir = from; ; dir = path.dirname(dir)) {
    dirs.push(dir);

    if (dir === path.dirname(dir)) return dirs;
  }
}

/** Each repository `ask` answers for, GIT_QUESTIONS_AT_ONCE at a time. */
async function askEach(places, ask) {
  const answers = [];

  for (let at = 0; at < places.length; at += GIT_QUESTIONS_AT_ONCE) {
    answers.push(...await Promise.all(places.slice(at, at + GIT_QUESTIONS_AT_ONCE).map(async (place) => ({ place, answer: await ask(place) }))));
  }

  return answers;
}

/** A path a config value names, as git reads it: `~/` is the home, and a relative one is from `base`, or null when
 *  that depends on where git runs. */
function configuredPath(value, home, base) {
  if (value.startsWith('~/')) return path.join(home, value.slice(2));

  if (path.isAbsolute(value)) return value;

  return base === null ? null : path.resolve(base, value);
}

/** Backslash escapes inside double quotes, as sh(1) reads them; anywhere else a backslash is itself. */
const DOUBLE_QUOTED_ESCAPES = new Set(['\\', '"', '$', '`', '\n']);

/**
 * The first word of a program-valued config value as the shell git hands it to reads it (`!` marks a shell command):
 * single quotes keep everything, double quotes keep all but their escapes, a backslash outside quotes keeps the next
 * character, and unquoted whitespace ends the word. `"/opt/my tools/ssh" -v` runs `/opt/my tools/ssh`.
 */
function programWord(value) {
  const text = value.trim().replace(/^!/u, '').trimStart();
  let word = '';
  let quote = null;

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    const next = text[at + 1];

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (char === '\\' && next !== undefined && (quote === null || DOUBLE_QUOTED_ESCAPES.has(next))) {
      word += next;
      at += 1;
    } else if (char === '"') {
      quote = quote === null ? '"' : null;
    } else if (quote === null && char === "'") {
      quote = "'";
    } else if (quote === null && /\s/u.test(char)) {
      break;
    } else {
      word += char;
    }
  }

  return word;
}

/**
 * What stays read-only inside the writable roots, as `{ guarded, unguarded }` (THE INVARIANT above). `guarded` lists
 * `{ path, kind }`: a `directory` or `config` is created empty first when missing, git's own layout, so a command
 * cannot create it, and a `file` is bound where it exists. Every name a known startup file has in a writable root, as
 * a hard link or its link's target, is kept too. `unguarded` lists `{ path, why }` for what could not be asked: a
 * root whose walk stopped at GUARD_ENTRIES, a repository git refused, a relative program or directory whose place
 * depends on where git runs, a missing file a config names in a writable root, and a PATH directory in a writable root
 * ahead of a program a config names by bare name. Also not guarded: a repository made during a command, and one
 * inside node_modules.
 */
async function guardedPaths(writableRoots, home, deviceHome) {
  const guarded = new Map();
  const notes = new Map();

  const unguarded = { push: (note) => notes.set(`${note.path}\0${note.why}`, note) };

  const inRoot = (candidate) => writableRoots.some((root) => within(root, candidate));

  const keep = (candidate, kind, why = RUN_BY_THE_OWNER) => {
    const real = realTarget(candidate);

    if (inRoot(real) && !guarded.has(real)) guarded.set(real, { kind, why });
  };

  if (writableRoots.length === 0) return { guarded: [], unguarded: [] };
  const { linked, sealedFor } = runLaterGuards(home, inRoot, keep);

  const repositories = new Set();
  // A git directory the walk reaches is a bare repository: a `.git` is taken at its entry, never walked into.
  const isGitDirectory = (listed) => ['HEAD', 'objects', 'refs'].every((name) => listed.some((entry) => entry.name === name));

  const descend = (full, entry) => {
    if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
      repositories.add(path.dirname(full));

      return false;
    }

    if (entry.isDirectory()) return !WALK_SKIPPED.has(entry.name) && !within(deviceHome, full);
    const stat = entry.isFile() && linked.size > 0 ? statOrNull(full) : null;
    const linkedWhy = stat === null ? undefined : linked.get(`${String(stat.dev)}:${String(stat.ino)}`);

    if (linkedWhy !== undefined) keep(full, 'file', linkedWhy);

    return false;
  };

  const bare = (dir, listed) => {
    if (!isGitDirectory(listed)) return false;
    repositories.add(dir);

    return true;
  };

  // A root inside another is walked as part of it.
  const outermost = writableRoots.filter((candidate) => !writableRoots.some((other) => other !== candidate && within(other, candidate)));
  const unwalled = gitEnvironment(home, undefined);

  for (const root of outermost) {
    if (walkEntries(root, GUARD_ENTRIES, descend, bare)) unguarded.push({ path: root, why: `the sandbox stopped looking after ${String(GUARD_ENTRIES)} entries` });

    // Outward, repository after repository: a submodule's superproject, a monorepo around a shared package, a bare
    // repository whose git directory holds the root.
    for (let from = root; from !== path.dirname(from);) {
      const holding = await remembered(`holding\0${from}\0${home}`, (answer) => [...ancestorsOf(from), ...globalConfigFiles(home), ...answer?.at === undefined ? [] : [path.join(answer.at, '.git')]],
        async () => repositoryHolding(from, unwalled));

      if (holding === null) break;

      if (holding.refused !== undefined) {
        unguarded.push({ path: from, why: `git refused to read the repository around it: ${holding.refused}` });
        break;
      }

      repositories.add(holding.at);
      from = path.dirname(holding.at);
    }
  }

  const execPath = await remembered(`exec-path\0${process.env.PATH ?? ''}`, () => (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, 'git')),
    async () => gitIn('/', ['--exec-path'], unwalled));

  const searched = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));

  // A value names a program by path, relative to `base` (where git runs it; null when that depends on the caller),
  // or by bare name, which the shell finds through PATH.
  const keepProgram = ({ origin, key, value }, base) => {
    if (SWITCH_VALUES.has(value.trim().toLowerCase()) || (key.startsWith('alias.') && !value.trim().startsWith('!'))) return;
    const helper = key.startsWith('credential.') && !value.trim().startsWith('!') && !programWord(value).includes('/');
    const word = helper ? `git-credential-${programWord(value)}` : programWord(value);

    if (word.includes('/')) {
      const named = configuredPath(word, home, base);

      if (named === null) unguarded.push({ path: origin, why: `${key} names the relative program ${word}, which runs from wherever git runs` });
      else if (inRoot(realTarget(named)) && statOrNull(named) === null) unguarded.push({ path: named, why: `${key} names it, and it does not exist yet` });
      else keep(named, 'file');

      return;
    }

    const dirs = helper && execPath.code === 0 ? [execPath.stdout.trim(), ...searched] : searched;
    const found = dirs.findIndex((dir) => statOrNull(path.join(dir, word))?.isFile() === true);

    if (found !== -1) keep(path.join(dirs[found], word), 'file');

    for (const dir of (found === -1 ? dirs : dirs.slice(0, found)).filter(inRoot)) {
      unguarded.push({ path: dir, why: `${key} runs ${word} through PATH, and a program made in this directory would run instead` });
    }
  };

  const keepDirectory = ({ origin, key, value }, base) => {
    const named = configuredPath(value, home, base);

    if (named === null) unguarded.push({ path: origin, why: `${key} names the relative directory ${value}, whose place depends on where git runs` });
    else keep(named, 'directory');
  };

  const keepConfigured = (entries, base) => {
    for (const entry of entries) {
      if (entry.origin.startsWith('file:')) keep(path.resolve(base ?? '/', entry.origin.slice('file:'.length)), 'file');

      // A repository's own hooks directory is git's answer (askRepository); a relative global one is each repository's.
      const hooksPath = entry.key === 'core.hookspath' && base === null && configuredPath(entry.value, home, null) !== null;

      if (PROGRAM_KEYS.test(entry.key)) keepProgram(entry, base);
      else if (entry.key === 'init.templatedir' || hooksPath) keepDirectory(entry, base);
    }
  };

  // Once per plan, the owner's global and the machine's system configuration: a value there counts even where no
  // repository sits.
  for (const level of [['--global'], ['--system']]) {
    const config = await remembered(`config\0${level[0]}\0${home}`, (answer) => [...globalConfigFiles(home), ...originsOf(answer)], async () => configAt('/', unwalled, level));

    if (config.refused === undefined) keepConfigured(config.entries, null);
    else unguarded.push({ path: level[0], why: `git refused to read that configuration: ${config.refused}` });
  }

  const repositoryFiles = (at, answer) => [path.join(at, '.git'), at, ...globalConfigFiles(home), ...originsOf(answer),
    ...answer.commonDir === undefined ? [] : [path.join(answer.commonDir, 'config'), path.join(answer.gitDir, 'config.worktree'), path.join(answer.commonDir, 'worktrees')]];

  for (const { place, answer } of await askEach([...repositories], (at) => remembered(`repository\0${at}\0${home}`, (asked) => repositoryFiles(at, asked), async () => askRepository(at, home)))) {
    if (answer.refused !== undefined) {
      unguarded.push({ path: place, why: `git refused to read it: ${answer.refused}` });
      continue;
    }

    // The default hooks directory too: the config that points elsewhere could be changed by the owner later.
    for (const hooks of [answer.hooks, path.join(answer.commonDir, 'hooks')]) keep(hooks, 'directory');

    for (const config of [path.join(answer.commonDir, 'config'), path.join(answer.gitDir, 'config.worktree')]) keep(config, 'config');

    // Where the owner's git in a linked worktree finds its git directory, and where each worktree's record says the
    // common one and the worktree are: rewritten, they lead the owner's next command into a repository the agent made.
    if (statOrNull(path.join(place, '.git'))?.isFile() === true) keep(path.join(place, '.git'), 'file');

    for (const worktree of entriesOf(path.join(answer.commonDir, 'worktrees'))) {
      for (const record of ['gitdir', 'commondir']) keep(path.join(answer.commonDir, 'worktrees', worktree.name, record), 'file');
    }

    keepConfigured(answer.entries, place);
  }

  for (const [dir, missing] of sealedFor) {
    if (!guarded.has(dir)) guarded.set(dir, { kind: 'sealed', why: sealedWhy(dir, missing) });
  }

  pinAncestors(guarded, writableRoots);
  openSealed(guarded, deviceHome);

  return { guarded: [...guarded].map(([kept, entry]) => ({ path: kept, ...entry })), unguarded: [...notes.values()] };
}

/**
 * The run-later paths (core run-later-paths.ts) inside the writable roots: each that exists is kept (`keep`); for each
 * that does not, the folder that would hold it, in `sealedFor` with what would be made there. `linked` names each kept
 * file with other names, by device and inode: a hard link in a writable root is the same file.
 */
function runLaterGuards(home, inRoot, keep) {
  const linked = new Map();
  const sealedFor = new Map();

  for (const { tail, why } of RUN_LATER) {
    const real = realTarget(path.join(home, tail));

    if (!inRoot(real)) continue;
    const stat = statOrNull(real);

    if (stat !== null) {
      keep(real, 'file', why);

      if (stat.isFile() && stat.nlink > 1) linked.set(`${String(stat.dev)}:${String(stat.ino)}`, why);
      continue;
    }

    // Missing: no bind can hold a name that does not exist without making it, so the folder that would hold it takes
    // no new entry (never a placeholder in the owner's home, which would change what their shell or tool reads).
    let dir = path.dirname(real);

    while (statOrNull(dir) === null) dir = path.dirname(dir);
    sealedFor.set(dir, [...sealedFor.get(dir) ?? [], `~/${tail}`]);
  }

  return { linked, sealedFor };
}

/** Why a sealed folder takes no new entry, as a refusal says it after "device path '<path>' is ": what would land there,
 *  and what to do instead. */
function sealedWhy(dir, missing) {
  return `a new entry directly in ${dir}, which takes none: ${missing.join(', ')} would be made there, and ${missing.length === 1 ? 'it runs' : 'they run'} `
    + `outside the sandbox. Create it inside an existing folder instead, e.g. ${path.join(dir, 'projects')}/…`;
}

/**
 * Each entry already in a sealed folder stays writable, bound over itself (`open`), but for what the guard keeps there
 * and links, which a bind would follow out of the folder. Being a mount, an open entry cannot be renamed or removed.
 */
function openSealed(guarded, deviceHome) {
  // An entry this adds is `open`, which the loop passes over when it meets it.
  for (const [dir, entry] of guarded) {
    if (entry.kind !== 'sealed') continue;

    for (const child of entriesOf(dir)) {
      const full = path.join(dir, child.name);

      if (child.isSymbolicLink() || guarded.has(full) || within(deviceHome, full) || within(full, deviceHome)) continue;
      guarded.set(full, { kind: 'open', why: '' });
    }
  }
}

/**
 * Each folder between a writable root and a kept path becomes a `pin`: bound over itself, a mountpoint the command
 * cannot rename or remove (EBUSY). Without it, moving `.git` or any folder above it carries the read-only binds away,
 * and a writable copy put back in its place is what the owner's git reads next. A folder inside a kept directory is
 * already read-only, and a root is itself a mount.
 */
function pinAncestors(guarded, writableRoots) {
  const readOnlyDirs = [...guarded].filter(([, entry]) => entry.kind === 'directory' || entry.kind === 'file').map(([kept]) => kept);

  // A pin this adds is met in turn, and its ancestors are pinned as the kept path's would be.
  for (const kept of guarded.keys()) {
    for (let dir = path.dirname(kept); ; dir = path.dirname(dir)) {
      const inside = writableRoots.some((root) => root !== dir && within(root, dir));

      if (!inside || guarded.has(dir) || readOnlyDirs.some((readOnly) => within(readOnly, dir))) break;
      guarded.set(dir, { kind: 'pin', why: '' });
    }
  }
}

/** Walks `root` breadth first, following no link, handing `descend` each entry until `limit` are read; `descend`
 *  answers whether to walk into a directory, and `stop` whether a directory's listing ends the walk into it. True
 *  when an entry was left unread. */
function walkEntries(root, limit, descend, stop) {
  const pending = [root];
  let seen = 0;

  for (let at = 0; at < pending.length; at += 1) {
    const listed = entriesOf(pending[at]);

    if (at > 0 && stop(pending[at], listed)) continue;

    for (const entry of listed) {
      if (seen === limit) return true;
      seen += 1;
      const full = path.join(pending[at], entry.name);

      if (descend(full, entry)) pending.push(full);
    }
  }

  return false;
}

/**
 * The read-only half of the Linux view, as mounts. Each system tree is bound at
 * its own path, and a top-level link into another bound tree stays a link:
 * merged-/usr makes `/bin` a link to `usr/bin`, and `#!/bin/bash` needs the
 * name. `/etc/resolv.conf` points into `/run/systemd/resolve` on Ubuntu, so
 * that directory is bound too, or nothing in the sandbox resolves a host name
 * and nothing installs.
 */
/**
 * The read-only half of the Linux view, as mounts. Each system tree is bound at
 * its own path, and a top-level link into another bound tree stays a link:
 * merged-/usr makes `/bin` a link to `usr/bin`, and `#!/bin/bash` needs the
 * name. `/etc/resolv.conf` points into `/run/systemd/resolve` on Ubuntu, so
 * that directory is bound too, or nothing in the sandbox resolves a host name
 * and nothing installs.
 */
function linuxReadMounts(resolvConf = '/etc/resolv.conf') {
  const mounts = [];

  for (const logical of LINUX_READ_ROOTS) {
    const real = realPathOrNull(logical);

    if (real === null) continue;
    mounts.push({ path: logical, real, link: fs.lstatSync(logical).isSymbolicLink() });
  }

  const trees = mounts.filter((mount) => !mount.link).map((mount) => mount.real);

  const readMounts = mounts.map((mount) => (
    mount.link && trees.some((tree) => within(tree, mount.real))
      ? { kind: 'symlink', path: mount.path, target: fs.readlinkSync(mount.path), real: mount.real }
      : { kind: 'bind', path: mount.path, real: mount.real }
  ));

  const resolver = realPathOrNull(resolvConf);
  const resolverDir = resolver === null ? null : path.dirname(resolver);

  if (resolverDir !== null && !readMounts.some((mount) => within(mount.real, resolverDir))) {
    readMounts.push({ kind: 'bind', path: resolverDir, real: resolverDir });
  }

  return readMounts;
}

/** What the caller may do with a path, and where it actually lives. */
const VIEW_INVISIBLE = 'invisible';

const VIEW_READ_ONLY = 'read_only';

const VIEW_WRITABLE = 'writable';

const OUTSIDE_THE_SANDBOX = 'outside what this device\'s sandbox exposes, which does not expose '
  + 'files beyond the agent\'s home and the directories the owner shared';

const INSIDE_KINU = 'inside Kinu\'s own directory, which the tunnel never serves';

const RUN_BY_THE_OWNER = 'code the owner\'s shell or git runs outside the sandbox, which stays read-only to the agent';

/**
 * What a command's error output shows the guard refused (guardedPaths), as sentences that name each path and why; empty
 * when it shows none. A refused write on a line naming a kept path or a sealed folder, or "Device or resource busy" on
 * one naming a pinned or opened folder. `names` is what `guardNames` recorded at the start. Seatbelt's denial reads
 * "Operation not permitted" (unmeasured here: this is a Linux box).
 */
function guardNote(stderr, names) {
  const said = new Map();
  const lines = stderr.split('\n');
  const refused = (line) => /Read-only file system|Operation not permitted/u.test(line);
  // Landlock refuses a new entry in a sealed folder as EACCES (daemon/landlock.js).
  const refusedMaking = (line) => refused(line) || (names.sealedBy === 'landlock' && line.includes('Permission denied'));
  // What `rm`, `mv` and the shell say of an entry they could not take away; a seal by mounts refuses that too.
  const removing = (line) => /cannot (?:remove|move)|rename|rmdir|unlink/u.test(line);

  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // A kept path, by its full path or by its last name as a word of the line (a relative path, as a shell says it).
  const mentions = (line, kept) => [line.includes(kept), new RegExp(`(?:^|[\\s/'"])${escaped(path.basename(kept))}(?:[\\s:'"]|$)`, 'u').test(line)].includes(true);
  // A new entry directly in the sealed folder: its own last name follows the folder, then the line's punctuation.
  const newEntryIn = (line, dir) => new RegExp(`${escaped(dir)}/[^/\\s:'"]+(?:[\\s:'"]|$)`, 'u').test(line);

  for (const line of lines.filter(refusedMaking)) {
    const kept = refused(line) ? names.kept.filter((entry) => mentions(line, entry.path)) : [];

    for (const entry of kept) said.set(entry.path, `${entry.path} is ${entry.why}.`);

    for (const sealed of kept.length > 0 ? [] : names.sealed.filter((entry) => newEntryIn(line, entry.path))) {
      said.set(sealed.path, removing(line) && names.sealedBy !== 'landlock' ? removalRefused(sealed.path) : `That is ${sealed.why}`);
    }
  }

  for (const line of lines) {
    if (line.includes('Device or resource busy') && names.pinned.some((name) => line.includes(name))) {
      said.set('pinned', 'A folder holding what the sandbox keeps read-only, or an entry of a folder that takes no new entry, cannot be renamed or removed.');
    }
  }

  return said.size === 0 ? '' : `Kinu's sandbox refused that. ${[...said.values()].join(' ')}`;
}

/** Why an entry already in sealed folder `dir` could not be removed or renamed: a seal by mounts holds the folder
 *  read-only, which Landlock, missing from this kernel, would not (daemon/landlock.js). */
function removalRefused(dir) {
  return `${dir} takes no new entry, and on this machine, whose kernel has no Landlock (ABI ${String(SEAL_ABI)}, Linux 5.19), `
    + 'that also keeps what is already in it from being removed or renamed. Work inside a folder in it instead.';
}

/** What `guardNote` needs of a plan's guard: each kept path with why, each sealed folder with why, the last names of the
 *  pinned and opened folders, and how the sealed folders are sealed (`landlock`, `mounts`, or null when none is). */
function guardNames(guarded, sealedBy = null) {
  const kept = guarded.filter((entry) => entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'config');
  const pinned = [...new Set(guarded.filter((entry) => entry.kind === 'pin' || entry.kind === 'open').map((entry) => path.basename(entry.path)))];

  return {
    kept: kept.map((entry) => ({ path: entry.path, why: entry.why })),
    sealed: guarded.filter((entry) => entry.kind === 'sealed').map((entry) => ({ path: entry.path, why: entry.why })),
    pinned,
    sealedBy,
  };
}

/**
 * How this plan seals its sealed folders: `landlock` where the kernel has ABI 2 (an entry already there stays removable),
 * else `mounts` (the folder read-only, each entry in it bound writable again); null when nothing is sealed. A caller may
 * name one (a test of the other).
 */
function sealOf(guarded, wanted) {
  if (!guarded.some((entry) => entry.kind === 'sealed')) return null;

  if (wanted !== undefined) return wanted;

  return landlockAbi() >= SEAL_ABI ? 'landlock' : 'mounts';
}


/**
 * The policy, as one object, in one layout on Linux and macOS.
 *
 * `deviceHome` is Kinu's own directory. It is invisible in EVERY tier,
 * including raw, and inside a consented directory that holds it: it holds
 * device.json (this machine's long-lived token), config.json (the owner's CLI
 * bearer) and every workspace's agent home, so serving it is a machine clone
 * and an account takeover.
 *
 * The agent home is its own path, and HOME names it. `roots` are the
 * directories the owner named, writable at their own paths. The owner's home
 * is one when `kinu connect` ran there: it grants the files in it, never
 * Kinu's own directory inside it, of which the agent home alone is uncovered.
 * A root of `/` never reaches here: the daemon runs that frame raw, as the
 * owner consented.
 *
 * Every path is judged by where it LANDS on the host, so a link the agent
 * planted in its own home pointing at the owner's file is that file.
 */
function viewFor(options) {
  const platform = options.platform ?? os.platform();
  const home = trimPath(options.home ?? os.homedir());
  const agentHomeSpelled = trimPath(options.agentHome);
  const agentTmpSpelled = trimPath(options.agentTmp ?? path.join(path.dirname(agentHomeSpelled), 'tmp'));
  const agentHome = realTarget(agentHomeSpelled);
  const agentTmp = realTarget(agentTmpSpelled);
  const deviceHome = realTarget(options.deviceHome);

  // Longest first, so a root nested inside another root answers for itself.
  const roots = (Array.isArray(options.roots) ? options.roots : [])
    .map(realTarget)
    .sort((left, right) => right.length - left.length);

  const linux = platform !== 'darwin';
  // Every root is writable but for what the guard keeps (guardedPaths): git's hooks and settings in each repository,
  // and in a consented home the declared run-later paths (RUN_LATER), owner decision 2026-10-22.
  const writableRoots = roots;
  const scope = { home, deviceHome, own: [agentHome, agentTmp], writable: writableRoots };
  // Read by `guards()`, which a plan awaits first and a write method awaits in its queue (`refuseGuarded`); a read
  // never asks for them.
  let reading = null;
  let read = null;
  const guards = () => (reading ??= guardedPaths(writableRoots, home, deviceHome).then((found) => (read = found)));

  const guardsRead = () => {
    if (read === null) throw new Error('the guards of a consented directory were asked before they were read');

    return read;
  };

  // What the guard keeps that a write to `target` would change: a kept path holding it, or a sealed folder it would be
  // a new entry of.
  const guardedWrite = (target) => {
    if (read === null || within(agentHome, target) || within(agentTmp, target) || !writableRoots.some((root) => within(root, target))) return null;
    const { guarded } = read;
    const kept = guarded.find((entry) => (entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'config') && within(entry.path, target));

    if (kept !== undefined) return kept;
    const sealed = guarded.find((entry) => entry.kind === 'sealed' && entry.path === path.dirname(target));

    return sealed !== undefined && lstatOrNull(target) === null ? sealed : null;
  };

  const writeRefusal = (decision) => {
    if (decision.access === VIEW_READ_ONLY) return { why: decision.why };
    const refused = guardedWrite(decision.path);

    return refused === null ? null : { why: refused.why };
  };

  const readMounts = linux ? linuxReadMounts() : [];
  const readTrees = readMounts.map((mount) => mount.real);
  const bound = [...readTrees, ...roots];

  /** The host path a command in the namespace reaches by `requested`, before links are followed. */
  const hostSpelling = (requested) => {
    const lexical = trimPath(requested);

    const ownDirs = [agentHomeSpelled, agentTmpSpelled, agentHome, agentTmp];

    if (ownDirs.some((dir) => within(dir, lexical))) return lexical;

    if (roots.some((root) => within(root, lexical))) return lexical;

    if (linux) {
      for (const temp of LINUX_TEMP_ROOTS) {
        if (!within(temp, lexical)) continue;
        const relative = path.relative(temp, lexical);

        return relative === '' ? agentTmp : path.join(agentTmp, relative);
      }
    }

    return lexical;
  };

  /** Where a requested path lives on the host, and what may be done with it. */
  const classify = (requested) => {
    const target = realTarget(hostSpelling(requested));

    // The agent's OWN home is decided first, because it lives under Kinu's
    // directory (~/.kinu/agents/<workspace>/home) so that uninstall has one
    // path to remove.
    if (within(agentHome, target) || within(agentTmp, target)) {
      return { access: VIEW_WRITABLE, path: target };
    }

    if (within(deviceHome, target)) return { access: VIEW_INVISIBLE, path: target, why: INSIDE_KINU };

    if (writableRoots.some((root) => within(root, target))) return { access: VIEW_WRITABLE, path: target };

    if (linux) {
      if (readTrees.some((tree) => within(tree, target))) return { access: VIEW_READ_ONLY, path: target };

      return { access: VIEW_INVISIBLE, path: target, why: OUTSIDE_THE_SANDBOX };
    }

    for (const denied of MAC_DENY_SUBPATHS) {
      if (within(denied, target)) {
        return { access: VIEW_INVISIBLE, path: target, why: `inside ${denied}, which this device's sandbox does not expose` };
      }
    }

    return { access: VIEW_READ_ONLY, path: target };
  };

  return {
    platform,
    home,
    agentHome,
    agentTmp,
    deviceHome,
    roots,
    guards,
    /**
     * Refuses a write the guard keeps (`guardedPaths`) to `target`, a path this view already judged for writing, with
     * why, once the guards are read. A write method awaits it in its queue, right before it acts, so its path is judged
     * on arrival as ever and its order is kept.
     */
    async refuseGuarded(target) {
      await guards();
      const refused = guardedWrite(target);

      if (refused === null) return;
      const error = new Error(`device path '${target}' is ${refused.why}`);

      error.code = VIEW_READ_ONLY;
      throw error;
    },
    /** Each path kept read-only inside the writable roots, as `{ path, kind }` (guardedPaths), once `guards()` read them. */
    get guarded() {
      return guardsRead().guarded;
    },
    /** What went unguarded, as `{ path, why }` (guardedPaths), once `guards()` read it. */
    get unguarded() {
      return guardsRead().unguarded;
    },
    readMounts,
    // Kinu's own directory, wherever a bind would otherwise carry it in; the
    // mask goes on after every bind, so no bind can uncover it again.
    hiddenDirs: bound.some((dir) => within(dir, deviceHome)) ? [deviceHome] : [],
    hiddenFiles: [...new Set(LINUX_MASK_FILES.map(realPathOrNull))]
      .filter((file) => file !== null && roots.some((root) => within(root, file))),
    classify,
    /**
     * The same directory, named as the COMMAND sees it: its own path, but for
     * the agent's tmp, which a Linux command reaches as /tmp. Identity on
     * macOS, which has no mount namespace.
     */
    insidePath(target) {
      const resolved = trimPath(target);

      if (!linux) return resolved;

      if (within(agentTmp, resolved)) {
        const relative = path.relative(agentTmp, resolved);

        return relative === '' ? '/tmp' : path.join('/tmp', relative);
      }

      return resolved;
    },
    /**
     * The DIRECTORY ENTRY, authorized without following its last component.
     * `unlink` removes the name, not what it points at — native semantics —
     * so resolving the link first would delete the target instead, which is a
     * path the caller never named.
     */
    resolveEntryPath(requested, mode) {
      const resolved = trimPath(requested);
      const parent = this.resolvePath(path.dirname(resolved), mode);

      return path.join(parent, path.basename(resolved));
    },
    /**
     * The one answer a file method needs: the path to touch, or a throw that
     * names why. `mode` is 'read' or 'write'; a read-only path answers a read
     * and refuses a write, which is exactly what the kernel does to the shell.
     */
    resolvePath(requested, mode) {
      const decision = classify(requested);

      if (decision.access === VIEW_INVISIBLE) {
        const error = new Error(`device path '${requested}' is ${decision.why}`);
        error.code = VIEW_INVISIBLE;
        throw error;
      }

      const refused = mode === 'write' ? writeRefusal(decision) : null;

      if (refused !== null) {
        const consented = roots.length === 0 ? 'none' : roots.join(', ');

        const error = new Error(refused.why === undefined
          ? `device path '${requested}' is read-only in this device's sandbox; `
            + `write inside the agent's home or one of the consented directories (${consented})`
          : `device path '${requested}' is ${refused.why}`);

        error.code = VIEW_READ_ONLY;
        throw error;
      }

      return decision.path;
    },
    checkpointDirectory: (dir) => checkpointVerdict(scope, dir),
    workingTree: (dir) => workingTreeVerdict(scope, dir),
  };
}

const HOLDS_KINU = 'Kinu\'s own directory or holds it, and a checkpoint copies everything it covers';

const HOME_ITSELF = 'the owner\'s home folder itself, too much to copy before every command';

/**
 * Where a checkpoint of `dir` may be kept, as `{ path, why }`: `why` is null
 * when it may. A checkpoint names its directory by HOST path and copies all of
 * it into a store at rest, so it covers only a directory the frame may write,
 * never the owner's home folder itself, Kinu's own directory or one holding
 * it. `own` are the agent's directories, which live inside Kinu's; `writable`
 * is where else the frame may write, or null for anywhere.
 */
function checkpointVerdict(scope, dir) {
  const target = realTarget(dir);
  const own = scope.own.some((ownDir) => within(ownDir, target));

  if (target === realTarget(scope.home)) return { path: target, why: HOME_ITSELF };

  if (within(target, scope.deviceHome) || (!own && within(scope.deviceHome, target))) return { path: target, why: HOLDS_KINU };

  if (own || scope.writable === null || scope.writable.some((root) => within(root, target))) return { path: target, why: null };

  return { path: target, why: OUTSIDE_THE_SANDBOX };
}

/**
 * What a command's pre-mutation checkpoint covers, as `checkpointVerdict`
 * answers: its working tree, the nearest git root at or above `dir` that a
 * checkpoint may cover, or else `dir` itself.
 */
function workingTreeVerdict(scope, dir) {
  const start = checkpointVerdict(scope, dir);

  for (let candidate = start.path; checkpointVerdict(scope, candidate).why === null; candidate = path.dirname(candidate)) {
    if (fs.existsSync(path.join(candidate, '.git'))) return { path: candidate, why: null };

    if (candidate === path.dirname(candidate)) break;
  }

  return start;
}

/**
 * A view that enforces nothing but Kinu's own directory: the raw tier, which
 * is what a device whose Sandbox switch the owner turned OFF gets. Every other
 * path is the machine's own, read and write, exactly as before the sandbox
 * existed.
 */
function rawViewFor(options) {
  const deviceHome = realTarget(options.deviceHome);
  const scope = { home: trimPath(options.home ?? os.homedir()), deviceHome, own: [], writable: null };

  return {
    platform: options.platform ?? os.platform(),
    raw: true,
    deviceHome,
    roots: [],
    classify(requested) {
      const target = realTarget(requested);

      if (within(deviceHome, target)) return { access: VIEW_INVISIBLE, path: target, why: INSIDE_KINU };

      return { access: VIEW_WRITABLE, path: target };
    },
    resolveEntryPath(requested, mode) {
      const resolved = trimPath(requested);
      // Authorizes the parent, returns the NAME: raw returns paths as
      // requested, so the entry is the requested spelling of it.
      this.resolvePath(path.dirname(resolved), mode);

      return requested;
    },
    resolvePath(requested) {
      const decision = this.classify(requested);

      if (decision.access === VIEW_INVISIBLE) {
        const error = new Error(`device path '${requested}' is ${decision.why}`);
        error.code = VIEW_INVISIBLE;
        throw error;
      }

      // A raw path is returned as REQUESTED, not resolved: the tier's contract
      // is "exactly what it was before", and resolving would change the error
      // a missing path produces.
      return requested;
    },
    // The Sandbox switch is off: the owner chose no guard, and a write method's queue asks it of every view alike.
    refuseGuarded: async () => {},
    checkpointDirectory: (dir) => checkpointVerdict(scope, dir),
    workingTree: (dir) => workingTreeVerdict(scope, dir),
  };
}

/** The command environment, allow-listed out of `source`, with the sandbox's
 *  own overrides last. */
function sandboxEnvironment(source, overrides, dotenv = new Map()) {
  const env = {};

  for (const name of Object.keys(source)) {
    const value = source[name];
    const allowed = ENV_ALLOWLIST.includes(name) || ENV_ALLOWLIST_FAMILY.test(name);

    if (allowed && value !== undefined && !fromDotenv(dotenv, name, value)) env[name] = value;
  }

  for (const name of Object.keys(overrides)) {
    if (overrides[name] !== undefined) env[name] = overrides[name];
  }

  return env;
}

const LINUX_PATH_HEAD = ['.local/bin', '.cargo/bin', '.bun/bin'];

const LINUX_PATH_TAIL = [
  '/usr/local/cuda/bin', '/usr/local/sbin', '/usr/local/bin',
  '/usr/sbin', '/usr/bin', '/sbin', '/bin',
];

const MAC_PATH_TAIL = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

/** The agent's own tool directories, then the owner's where the owner consented
 *  them: a home shared as a root keeps its user-installed tools, after the
 *  agent's own. */
function toolDirs(view) {
  const owner = LINUX_PATH_HEAD.map((tail) => realTarget(path.join(view.home, tail)))
    .filter((dir) => view.roots.some((root) => within(root, dir)) && !within(view.deviceHome, dir));

  return [...LINUX_PATH_HEAD.map((tail) => path.join(view.agentHome, tail)), ...owner];
}

/**
 * The bwrap argv. ORDER IS THE POLICY: a later mount shadows an earlier one.
 * The root is an empty tmpfs, the system trees go in read-only, the agent's
 * tmp and the consented roots go in writable, Kinu's own directory is masked
 * after them so no root can uncover it, and the agent home goes in LAST, at its
 * own path inside that mask, so no root can shadow it.
 */
function buildLinuxArgv(view, options) {
  const argv = [
    'bwrap',
    '--unshare-user', '--unshare-pid', '--unshare-ipc',
    '--die-with-parent',
    '--cap-drop', 'ALL',
    '--tmpfs', '/',
  ];

  for (const mount of view.readMounts) {
    if (mount.kind === 'symlink') argv.push('--symlink', mount.target, mount.path);
    else argv.push('--ro-bind', mount.real, mount.path);
  }

  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/dev/shm');

  if (options.statusFd !== undefined) argv.push('--json-status-fd', String(options.statusFd));

  // `--dev-bind-try`, so a node that disappears between enumeration and mount
  // (a driver reload) does not fail the command.
  for (const node of options.gpu) argv.push('--dev-bind-try', node, node);

  // The agent tmp lands on the temp roots before anything under them, because
  // a home under /tmp is a home: bound after it, the `/tmp` bind shadowed it
  // and every command started with `bwrap: Can't chdir to /tmp/<home>: No such
  // file or directory` (the first-run tier's daemons, each given a scratch
  // HOME under the runner's tmpdir, measured 2026-09-04).
  for (const temp of LINUX_TEMP_ROOTS) argv.push('--bind', view.agentTmp, temp);

  // Shortest first here: a root nested inside another must be mounted after
  // its parent, or the parent's bind hides it. `-try`, because a directory the
  // owner shared and later deleted is no reason to refuse every command.
  for (const root of [...view.roots].reverse()) argv.push('--bind-try', root, root);

  const landlock = options.seal === 'landlock';

  argv.push(...guardedMounts(options.guarded ?? [], landlock));

  for (const dir of view.hiddenDirs) argv.push('--tmpfs', dir);

  for (const file of view.hiddenFiles) argv.push('--ro-bind', '/dev/null', file);

  // Kinu's own directories a confined program of the daemon writes or reads (a checkpoint store), after the mask that
  // hides them.
  for (const dir of options.writable ?? []) argv.push('--bind', dir, dir);

  for (const dir of options.readable ?? []) argv.push('--ro-bind', dir, dir);
  // Last: a root holding it (the owner's home) would shadow it, and the mask on
  // Kinu's own directory, which holds it, would hide it.
  argv.push('--bind', view.agentHome, view.agentHome);

  const program = options.program ?? ['bash', '-c', options.command];

  if (landlock) return [...argv, ...sealedLaunch(view, options, program)];

  argv.push('--chdir', view.insidePath(options.cwd));
  argv.push('--clearenv');

  for (const name of Object.keys(options.env)) argv.push('--setenv', name, options.env[name]);
  argv.push('--', ...program);

  return argv;
}

/**
 * The binds that keep what the guard keeps (guardedPaths), over the writable roots that hold them, outer before inner,
 * so a pin or an opened entry never covers a read-only bind below it. Sealed by Landlock, a sealed folder is pinned (it
 * cannot be renamed or removed) and the launcher refuses new entries in it; sealed by mounts, it is read-only, then each
 * entry already in it writable again. Git's own directories and config are made first when missing; nothing else is.
 */
function guardedMounts(guarded, landlock) {
  const argv = [];

  for (const { path: kept, kind } of [...guarded].sort((a, b) => a.path.length - b.path.length)) {
    if (kind === 'open' && landlock) continue;

    if (kind === 'pin' || kind === 'open' || (kind === 'sealed' && landlock)) {
      argv.push('--bind-try', kept, kept);
      continue;
    }

    if (kind === 'directory') fs.mkdirSync(kept, { recursive: true });
    else if (kind === 'config') fs.closeSync(fs.openSync(kept, 'a'));

    if (fs.existsSync(kept)) argv.push('--ro-bind', kept, kept);
  }

  return argv;
}

/**
 * The end of a Landlock-sealed plan's argv (daemon/landlock.js): the daemon's own Bun bound in, and SEAL_LAUNCHER run
 * from `/` with no environment, which seals the folders, enters the command's directory and execs `program` with its
 * environment. Bun reads no config: not a repository's bunfig in the command's directory, nor one an agent named.
 */
function sealedLaunch(view, options, program) {
  const sealed = (options.guarded ?? []).filter((entry) => entry.kind === 'sealed').map((entry) => view.insidePath(entry.path));
  const spec = JSON.stringify({ sealed, cwd: view.insidePath(options.cwd), env: options.env });

  return [
    '--ro-bind', process.execPath, SEAL_RUNTIME,
    '--chdir', '/',
    '--clearenv',
    '--', SEAL_RUNTIME, '--config=/dev/null', '-e', SEAL_LAUNCHER, '--', spec, ...program,
  ];
}

/** The SBPL profile. Rules evaluate in order and the LAST match wins, which is
 *  what makes "read everything, then deny the user's home, then re-allow the
 *  agent's own" expressible without enumerating what to hide. Kinu's own
 *  directory is denied after the consented roots, which may hold it, and the
 *  agent's directories inside it are allowed again after that. */
function buildMacProfile(view, daemonDirs = {}) {
  const subpath = (dir) => `(subpath ${JSON.stringify(dir)})`;
  // Kinu's directories a confined program of the daemon writes (a checkpoint store) are allowed again with the agent's.
  const own = [view.agentHome, view.agentTmp, ...(daemonDirs.writable ?? [])];
  const daemonReadable = daemonDirs.readable ?? [];
  const readable = daemonReadable.length === 0 ? [] : [`(allow file-read* ${daemonReadable.map(subpath).join(' ')})`];
  const writable = [...own, ...view.roots, '/private/tmp', '/private/var/tmp'];
  const guarded = daemonDirs.guarded ?? [];
  const readOnly = guarded.filter((entry) => entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'config');
  const pinned = guarded.filter((entry) => entry.kind === 'pin');
  const sealed = guarded.filter((entry) => entry.kind === 'sealed');
  const childOf = (dir) => `(regex #"^${dir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/[^/]+$")`;

  // A pin denies writing the folder's own entry (rename, removal), never what is created inside it; a sealed folder
  // denies creating an entry directly in it, while those already there stay writable.
  const kept = (readOnly.length === 0 ? '' : ` (deny file-write* ${readOnly.map((entry) => subpath(entry.path)).join(' ')})`)
    + (pinned.length === 0 ? '' : ` (deny file-write* ${pinned.map((entry) => `(literal ${JSON.stringify(entry.path)})`).join(' ')})`)
    + (sealed.length === 0 ? '' : ` (deny file-write-create ${sealed.map((entry) => childOf(entry.path)).join(' ')})`);

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec*) (allow process-fork) (allow signal (target same-sandbox))',
    '(allow file-read*)',
    `(deny file-read* file-write* ${MAC_DENY_SUBPATHS.map(subpath).join(' ')})`,
    `(allow file-read* file-write* ${writable.map(subpath).join(' ')})${kept}`,
    `(deny file-read* file-write* ${subpath(view.deviceHome)})`,
    `(allow file-read* file-write* ${own.map(subpath).join(' ')})`,
    ...readable,
    `(allow file-read-metadata (literal "/Users") (literal ${JSON.stringify(view.home)}))`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    '(allow pseudo-tty) (allow ipc-posix-sem)',
    '(allow ipc-posix-shm (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB"))',
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo")'
      + ' (global-name "com.apple.PowerManagement.control")'
      + ' (global-name "com.apple.SystemConfiguration.configd")'
      + ' (global-name "com.apple.dnssd.service")'
      + ' (global-name "com.apple.MTLCompilerService"))',
    '(allow iokit-open (iokit-user-client-class "RootDomainUserClient")'
      + ' (iokit-user-client-class "AGXDeviceUserClient")'
      + ' (iokit-user-client-class "AGXSharedUserClient")'
      + ' (iokit-user-client-class "AGXCommandQueue")'
      + ' (iokit-user-client-class "IOSurfaceRootUserClient")'
      + ' (iokit-user-client-class "IOAccelerationUserClient")'
      + ' (iokit-user-client-class "IOAcceleratorUserClient"))',
    '(allow network*)',
  ].join('\n');
}

const MAC_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * Everything the supervisor needs to run one command, computed by the daemon
 * so the supervisor stays dumb and this decision is testable without spawning
 * anything: `{ argv, env, view }`.
 *
 * The SANDBOX WRAPS THE COMMAND, never the supervisor. The supervisor is the
 * daemon's agent: it owns the state, result and ack files under the in-flight
 * root and it captures stdout and stderr through pipes that cross the
 * namespace. Wrapping it instead would put that ledger — and Kinu's whole
 * directory — inside the view the command can see.
 */
async function plan(options) {
  const platform = options.platform ?? os.platform();
  const command = options.command;

  if (options.tier === 'raw') {
    const view = rawViewFor({ platform, deviceHome: options.deviceHome, home: options.home });

    return {
      view,
      argv: ['bash', '-c', command],
      env: rawEnvironment(options.source ?? process.env, options.dotenv ?? new Map()),
      cwd: options.cwd,
      // The command's process starts there: nothing else puts it anywhere.
      spawnCwd: options.cwd,
    };
  }

  const view = viewFor({
    platform,
    home: options.home,
    agentHome: options.agentHome,
    agentTmp: options.agentTmp,
    deviceHome: options.deviceHome,
    roots: options.roots,
  });

  await view.guards();

  // A cwd the command cannot write is a cwd that fails on its first redirect,
  // so an unwritable one falls back to the agent's own home.
  const requestedCwd = options.cwd === undefined || options.cwd === null ? view.agentHome : trimPath(options.cwd);
  const cwdDecision = view.classify(requestedCwd);
  const cwd = cwdDecision.access === VIEW_WRITABLE ? cwdDecision.path : view.agentHome;

  if (platform === 'darwin') {
    const env = sandboxEnvironment(options.source ?? process.env, {
      HOME: view.agentHome,
      TMPDIR: view.agentTmp,
      PATH: [...toolDirs(view), ...MAC_PATH_TAIL].join(':'),
      KINU_SANDBOX: '1',
      XDG_RUNTIME_DIR: undefined,
    }, options.dotenv);

    return {
      view,
      argv: [MAC_SANDBOX_EXEC, '-p', buildMacProfile(view, { guarded: view.guarded }), 'bash', '-c', command],
      env,
      cwd,
      // No mount namespace to `--chdir` into, so the process starts there.
      spawnCwd: cwd,
      profile: buildMacProfile(view, { guarded: view.guarded }),
      unguarded: view.unguarded,
      guardNames: guardNames(view.guarded),
    };
  }

  // HOME is the agent home at its own path, as on macOS, so the path the model
  // is told is the path the command sees, and every tool's default (~/.local,
  // ~/.cache, ~/.cargo, ~/.npm) lands in the agent's own directory.
  const seal = sealOf(view.guarded, options.seal);
  const temp = sealedTemp(view, seal);

  const env = sandboxEnvironment(options.source ?? process.env, {
    HOME: view.agentHome,
    TMPDIR: temp,
    PATH: [...toolDirs(view), ...LINUX_PATH_TAIL].join(':'),
    XDG_RUNTIME_DIR: `${temp}/xdg`,
    NPM_CONFIG_PREFIX: path.join(view.agentHome, '.local'),
    KINU_SANDBOX: '1',
  }, options.dotenv);

  const gpu = options.gpu ?? gpuNodes();

  return {
    view,
    statusFd: options.statusFd,
    argv: buildLinuxArgv(view, { cwd, env, command, gpu, statusFd: options.statusFd, guarded: view.guarded, seal }),
    // bwrap carries the environment through `--setenv`, so the process that
    // spawns it needs none of it: an inherited variable here would be a second
    // path into the command's environment.
    env: {},
    // What the command runs with, set by bwrap or, sealed by Landlock, by the seal launcher.
    commandEnv: env,
    cwd,
    gpu,
    seal,
    unguarded: view.unguarded,
    guardNames: guardNames(view.guarded, seal),
  };
}

/**
 * The command's temp directory: /tmp, or below it when a folder sealed by Landlock lies under /tmp (a test's home):
 * /tmp is then on the sealed folder's path and takes no new entry at its own level (daemon/landlock.js), while a folder
 * of its own below it does. It is made in the agent's temp, which the sandbox binds at /tmp.
 */
function sealedTemp(view, seal) {
  if (seal !== 'landlock' || !view.guarded.some((entry) => entry.kind === 'sealed' && within('/tmp', entry.path))) return '/tmp';

  fs.mkdirSync(path.join(view.agentTmp, 'kinu-tmp', 'xdg'), { recursive: true, mode: 0o700 });

  return '/tmp/kinu-tmp';
}

/**
 * A program the DAEMON runs in a frame's sandbox (L111 #3): its checkpoint git, which reads and writes the frame's work
 * tree. The view's own mounts or profile, so a directory a command swapped for a link out of the roots leads nowhere;
 * `writable` and `readable` add Kinu's directories it needs (its store), and `env` is the daemon's own, passed whole. Starts
 * in the agent's home, which always exists; the program enters its directory itself, inside.
 */
function confined(options) {
  const platform = options.platform ?? os.platform();
  const { view, program, env } = options;
  const writable = options.writable ?? [];
  const readable = options.readable ?? [];

  if (platform === 'darwin') {
    return { argv: [MAC_SANDBOX_EXEC, '-p', buildMacProfile(view, { writable, readable }), ...program], env, cwd: view.agentHome };
  }

  return { argv: buildLinuxArgv(view, { cwd: view.agentHome, env, program, writable, readable, gpu: [] }), env: {}, cwd: view.agentHome };
}

/**
 * Whether this machine can sandbox a command, answered by RUNNING the real
 * argv shape with `/bin/true`. A probe that only looked for the binary would
 * report `ok` on every Ubuntu whose AppArmor profile forbids the namespace.
 *
 * No timeout: `/bin/true` under bwrap returns in milliseconds, and a bwrap
 * that hangs is a defect to surface rather than to paper over with a deadline.
 */
async function probe(options = {}) {
  const platform = options.platform ?? os.platform();
  const deviceHome = options.deviceHome ?? path.join(os.homedir(), '.kinu');

  if (platform !== 'linux' && platform !== 'darwin') {
    return { status: SANDBOX_STATUS.UNSUPPORTED_PLATFORM, detail: PROBE_HINTS[SANDBOX_STATUS.UNSUPPORTED_PLATFORM] };
  }

  if (platform === 'darwin') {
    if (!fs.existsSync(MAC_SANDBOX_EXEC)) {
      return { status: SANDBOX_STATUS.NO_SANDBOX_EXEC, detail: PROBE_HINTS[SANDBOX_STATUS.NO_SANDBOX_EXEC] };
    }
  } else {
    // WSL1 kernels end in `-Microsoft`; WSL2's `microsoft-standard-WSL2` is
    // plain Linux and takes the normal path.
    const release = readOsRelease(options.osReleasePath);

    if (release !== null && release.endsWith('-Microsoft')) {
      return { status: SANDBOX_STATUS.WSL1, detail: PROBE_HINTS[SANDBOX_STATUS.WSL1] };
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinu-sandbox-probe-'));

  try {
    const attempt = await plan({
      platform,
      home: os.homedir(),
      agentHome: path.join(scratch, 'home'),
      agentTmp: path.join(scratch, 'tmp'),
      deviceHome,
      roots: [],
      command: 'exit 0',
      cwd: path.join(scratch, 'home'),
      source: {},
      tier: 'sandboxed',
      gpu: [],
    });

    fs.mkdirSync(attempt.view.agentHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(attempt.view.agentTmp, { recursive: true, mode: 0o700 });

    const { error, stderr: printed } = await runToExit(attempt.argv[0], attempt.argv.slice(1), {
      env: attempt.env, encoding: 'utf8',
    });

    if (error !== null && error.code === 'ENOENT') {
      const status = platform === 'darwin' ? SANDBOX_STATUS.NO_SANDBOX_EXEC : SANDBOX_STATUS.NO_BWRAP;

      return { status, detail: PROBE_HINTS[status] };
    }

    if (error !== null && !Number.isInteger(error.code)) {
      return { status: SANDBOX_STATUS.PROBE_FAILED, detail: `sandbox probe could not run: ${error.message}` };
    }

    if (error === null) return { status: SANDBOX_STATUS.OK, detail: null };
    const stderr = String(printed).trim();

    if (platform === 'linux' && USERNS_REFUSALS.some((refusal) => stderr.includes(refusal))) {
      return { status: SANDBOX_STATUS.NO_USERNS, detail: PROBE_HINTS[SANDBOX_STATUS.NO_USERNS] };
    }

    const firstLine = stderr.split('\n')[0] || `exit ${error.code}`;

    return { status: SANDBOX_STATUS.PROBE_FAILED, detail: `sandbox probe failed: ${firstLine}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function readOsRelease(osReleasePath = '/proc/sys/kernel/osrelease') {
  try {
    return fs.readFileSync(osReleasePath, 'utf8').trim();
  } catch (err) {
    // A kernel that does not publish its release is not a WSL1 kernel; the
    // bwrap run below is the authority either way. Anything but "not there" is
    // this daemon's own breakage.
    if (!err || (err.code !== 'ENOENT' && err.code !== 'EACCES')) throw err;

    return null;
  }
}

/** What HELLO reports, in the hub's vocabulary rather than this module's: the
 *  hub decides the tier and needs one word for what this machine CAN do. */
function helloCapability(probeResult) {
  if (probeResult.status === SANDBOX_STATUS.OK) {
    return { capability: 'sandboxed', reason: null };
  }

  // `raw_only` for a machine that can never sandbox, `files_only` for one that
  // could if it were fixed: the first is a platform fact and the owner's only
  // move is the switch, the second names a command that changes the answer.
  const capability = probeResult.status === SANDBOX_STATUS.UNSUPPORTED_PLATFORM ? 'raw_only' : 'files_only';

  return { capability, reason: probeResult.status, reasonDetail: probeResult.detail };
}

module.exports = {
  SANDBOX_STATUS,
  PROBE_HINTS,
  LINUX_MASK_FILES,
  MAC_DENY_SUBPATHS,
  ENV_ALLOWLIST,
  ENV_ALLOWLIST_FAMILY,
  VIEW_INVISIBLE,
  VIEW_READ_ONLY,
  VIEW_WRITABLE,
  MAC_SANDBOX_EXEC,
  gpuNodes,
  ensureUvmNode,
  viewFor,
  rawViewFor,
  buildLinuxArgv,
  buildMacProfile,
  sandboxEnvironment,
  rawEnvironment,
  launchDotenv,
  plan,
  confined,
  probe,
  helloCapability,
  guardNote,
  RUN_BY_THE_OWNER,
  RUN_LATER,
  RUN_LATER_NAMES,
  GUARD_ENTRIES,
};
