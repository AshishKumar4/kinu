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

const update = require('./update.js');

const { runToExit } = update;

/** Why a machine cannot sandbox. `ok` is the only status that runs a command;
 *  every other value is reported to the hub, which refuses `exec` and says so
 *  rather than silently running the command unprotected. The first five are
 *  the hub's own `reason` vocabulary; `probe_failed` is the sixth, for a bwrap
 *  that ran and failed in a way this module does not recognise. */
const SANDBOX_STATUS = Object.freeze({
  OK: 'ok',
  NO_BWRAP: 'no_bwrap',
  NO_USERNS: 'no_userns',
  WSL1: 'wsl1',
  NO_SANDBOX_EXEC: 'no_sandbox_exec',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  PROBE_FAILED: 'probe_failed',
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
 * What never crosses into a command of either tier: the credentials Kinu's
 * CLI reads from its environment (cli-backend model-resolver.ts
 * PROVIDER_CREDENTIAL_ENV and SESSION_CREDENTIAL_ENV, branch-process.ts
 * BRANCH_CREDENTIAL_ENV; this file ships alone and cannot import them, so
 * cli-backend's cwd-plane test holds the lists together), and the two
 * settings this daemon itself reads: its update key and its predecessor.
 */
const WITHHELD_ENV = Object.freeze([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'CODEX_ACCESS_TOKEN',
  'KINU_TOKEN', 'KINU_AUTH', 'AI_GATEWAY_AUTH', 'KINU_LLM_HEADERS', 'KINU_PROVIDER_CREDENTIALS',
  update.RELEASE_SIGNING_PUBLIC_KEY_ENV, update.PREDECESSOR_ENV,
]);

/**
 * The values dotenv files put into this process at launch, by name: the files
 * Bun loads from its working directory for NODE_ENV (bun.sh/docs/runtime/env;
 * `.env.local` is skipped under test) and wrangler's `.dev.vars`. They are the
 * project's secrets, not the owner's shell, so no command inherits them.
 */
function launchDotenv(dir, nodeEnv) {
  const mode = nodeEnv === undefined || nodeEnv === '' ? 'development' : nodeEnv;
  const files = ['.env', `.env.${mode}`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}.local`, '.dev.vars'];
  const supplied = new Map();

  for (const file of files) {
    let text;

    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EACCES')) continue;
      throw err;
    }

    for (const [name, value] of Object.entries(util.parseEnv(text))) supplied.set(name, value);
  }

  return supplied;
}

/** An UNSANDBOXED command's environment: this daemon's own, as the owner's
 *  shell would give it, less what {@link WITHHELD_ENV} names and what a
 *  dotenv file supplied. */
function rawEnvironment(source, dotenv) {
  const withheld = new Set(WITHHELD_ENV);
  const env = {};

  for (const name of Object.keys(source)) {
    const value = source[name];

    if (value === undefined || withheld.has(name) || dotenv.get(name) === value) continue;
    env[name] = value;
  }

  return env;
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

/**
 * The path a syscall will actually REACH: symlinks followed where the target
 * exists, and composed onto the nearest existing ancestor where it does not.
 *
 * Decided on the destination rather than the spelling, because a symlink in a
 * writable directory pointing into Kinu's own is a read of Kinu's own, and
 * every file method here follows links.
 */
function realTarget(requested) {
  const resolved = trimPath(requested);
  const followable = (err) => err && err.code !== 'ENOENT' && err.code !== 'EACCES' && err.code !== 'ELOOP';

  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    if (followable(err)) throw err;
  }

  let parent = path.dirname(resolved);

  while (parent !== path.dirname(parent)) {
    try {
      return path.join(fs.realpathSync(parent), path.relative(parent, resolved));
    } catch (err) {
      if (followable(err)) throw err;
      parent = path.dirname(parent);
    }
  }

  return resolved;
}

/** Whether `target` is `root` itself or below it, decided on resolved paths so
 *  a prefix like `/home/dev-old` never reads as inside `/home/dev`. */
function within(root, target) {
  if (target === root) return true;

  return target.startsWith(root === '/' ? '/' : `${root}/`);
}

/** The path a syscall reaches, or null when nothing is there to mount. */
function realPathOrNull(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'EACCES' && err.code !== 'ELOOP')) throw err;

    return null;
  }
}

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

/**
 * The policy, as one object.
 *
 * `deviceHome` is Kinu's own directory. It is invisible in EVERY tier,
 * including raw, and inside a consented directory that holds it: it holds
 * device.json (this machine's long-lived token) and config.json (the owner's
 * CLI bearer), so serving it is a machine clone and an account takeover.
 *
 * `roots` are the directories the owner named, writable, and decided BEFORE
 * the home swap: a root inside the real home (~/work/thing, the common case)
 * is re-bound over the swapped home and is reachable inside. A root of `/`
 * never reaches here: the daemon runs that frame raw, as the owner consented.
 *
 * Every path is judged by where it LANDS on the host, after it is named the
 * way a command in the namespace names it: `~/x` is the agent's own `x`, and a
 * link the agent planted there pointing at the owner's real file is that file.
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
  const readMounts = linux ? linuxReadMounts() : [];
  const readTrees = readMounts.map((mount) => mount.real);
  const bound = [...readTrees, ...roots];

  /** The host path a command in the namespace reaches by `requested`, before links are followed. */
  const hostSpelling = (requested) => {
    const lexical = trimPath(requested);

    const ownDirs = [agentHomeSpelled, agentTmpSpelled, agentHome, agentTmp];

    if (ownDirs.some((dir) => within(dir, lexical))) return lexical;

    if (roots.some((root) => within(root, lexical))) return lexical;

    if (within(home, lexical)) {
      const relative = path.relative(home, lexical);

      return relative === '' ? agentHome : path.join(agentHome, relative);
    }

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

    if (roots.some((root) => within(root, target))) return { access: VIEW_WRITABLE, path: target };

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
    readMounts,
    // Kinu's own directory, wherever a bind would otherwise carry it in; the
    // mask goes on after every bind, so no bind can uncover it again.
    hiddenDirs: bound.some((dir) => within(dir, deviceHome)) ? [deviceHome] : [],
    hiddenFiles: [...new Set(LINUX_MASK_FILES.map(realPathOrNull))]
      .filter((file) => file !== null && roots.some((root) => within(root, file))),
    classify,
    /**
     * The same directory, named as the COMMAND sees it. There are two
     * coordinate systems and confusing them is a broken `--chdir`: the daemon's
     * file methods run outside the namespace and address the agent home by its
     * real path, while inside the namespace that directory is mounted over
     * `home` and its own path does not exist. Identity on macOS, which has no
     * mount namespace.
     */
    insidePath(target) {
      const resolved = trimPath(target);

      if (!linux) return resolved;

      if (within(agentHome, resolved)) {
        const relative = path.relative(agentHome, resolved);

        return relative === '' ? home : path.join(home, relative);
      }

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

      if (decision.access === VIEW_READ_ONLY && mode === 'write') {
        const consented = roots.length === 0 ? 'none' : roots.join(', ');

        const error = new Error(
          `device path '${requested}' is read-only in this device's sandbox; `
          + `write inside the agent's home or one of the consented directories (${consented})`,
        );

        error.code = VIEW_READ_ONLY;
        throw error;
      }

      return decision.path;
    },
    checkpointDirectory: (dir) => checkpointVerdict({ deviceHome, own: [agentHome, agentTmp], writable: roots }, dir),
  };
}

const HOLDS_KINU = 'Kinu\'s own directory or holds it, and a checkpoint copies everything it covers';

/**
 * Where a checkpoint of `dir` may be kept, as `{ path, why }`: `why` is null
 * when it may. A checkpoint names its directory by HOST path and copies all of
 * it into a store at rest, so it covers only a directory the frame may write,
 * never Kinu's own directory and never one holding it. `own` are the agent's
 * directories, which live inside Kinu's; `writable` is where else the frame may
 * write, or null for anywhere.
 */
function checkpointVerdict(scope, dir) {
  const target = realTarget(dir);
  const own = scope.own.some((ownDir) => within(ownDir, target));

  if (within(target, scope.deviceHome) || (!own && within(scope.deviceHome, target))) return { path: target, why: HOLDS_KINU };

  if (own || scope.writable === null || scope.writable.some((root) => within(root, target))) return { path: target, why: null };

  return { path: target, why: OUTSIDE_THE_SANDBOX };
}

/**
 * A view that enforces nothing but Kinu's own directory: the raw tier, which
 * is what a device whose Sandbox switch the owner turned OFF gets. Every other
 * path is the machine's own, read and write, exactly as before the sandbox
 * existed.
 */
function rawViewFor(options) {
  const deviceHome = realTarget(options.deviceHome);

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
    checkpointDirectory: (dir) => checkpointVerdict({ deviceHome, own: [], writable: null }, dir),
  };
}

/** The command environment, allow-listed out of `source`, with the sandbox's
 *  own overrides last. */
function sandboxEnvironment(source, overrides, dotenv = new Map()) {
  const env = {};

  for (const name of Object.keys(source)) {
    const value = source[name];
    const allowed = ENV_ALLOWLIST.includes(name) || ENV_ALLOWLIST_FAMILY.test(name);

    if (allowed && value !== undefined && dotenv.get(name) !== value) env[name] = value;
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

/**
 * The bwrap argv. ORDER IS THE POLICY: a later mount shadows an earlier one.
 * The root is an empty tmpfs, the system trees go in read-only, the agent's
 * own directories and the consented roots go in writable, and Kinu's own
 * directory is masked last so no bind can uncover it.
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

  // The agent tmp lands on the temp roots BEFORE the agent home lands on the
  // real home path, because a home under /tmp is a home: bound the other way
  // round, the `/tmp` bind shadowed it and every command started with
  // `bwrap: Can't chdir to /tmp/<home>: No such file or directory` — the
  // first-run tier's daemons, each given a scratch HOME under the runner's
  // tmpdir, measured 2026-09-04.
  for (const temp of LINUX_TEMP_ROOTS) argv.push('--bind', view.agentTmp, temp);
  // The agent home lands ON the real home path, so `~` inside the sandbox is
  // the agent's own directory and every tool's default (~/.local, ~/.cache,
  // ~/.cargo, ~/.npm) lands there with no environment tricks.
  argv.push('--bind', view.agentHome, view.home);

  // Shortest first here: a root nested inside another must be mounted after
  // its parent, or the parent's bind hides it. `-try`, because a directory the
  // owner shared and later deleted is no reason to refuse every command.
  for (const root of [...view.roots].reverse()) argv.push('--bind-try', root, root);

  for (const dir of view.hiddenDirs) argv.push('--tmpfs', dir);

  for (const file of view.hiddenFiles) argv.push('--ro-bind', '/dev/null', file);
  argv.push('--chdir', view.insidePath(options.cwd));
  argv.push('--clearenv');

  for (const name of Object.keys(options.env)) argv.push('--setenv', name, options.env[name]);
  argv.push('--', 'bash', '-c', options.command);

  return argv;
}

/** The SBPL profile. Rules evaluate in order and the LAST match wins, which is
 *  what makes "read everything, then deny the user's home, then re-allow the
 *  agent's own" expressible without enumerating what to hide. Kinu's own
 *  directory is denied after the consented roots, which may hold it, and the
 *  agent's directories inside it are allowed again after that. */
function buildMacProfile(view) {
  const subpath = (dir) => `(subpath ${JSON.stringify(dir)})`;
  const own = [view.agentHome, view.agentTmp];
  const writable = [...own, ...view.roots, '/private/tmp', '/private/var/tmp'];

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec*) (allow process-fork) (allow signal (target same-sandbox))',
    '(allow file-read*)',
    `(deny file-read* file-write* ${MAC_DENY_SUBPATHS.map(subpath).join(' ')})`,
    `(allow file-read* file-write* ${writable.map(subpath).join(' ')})`,
    `(deny file-read* file-write* ${subpath(view.deviceHome)})`,
    `(allow file-read* file-write* ${own.map(subpath).join(' ')})`,
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
function plan(options) {
  const platform = options.platform ?? os.platform();
  const command = options.command;

  if (options.tier === 'raw') {
    const view = rawViewFor({ platform, deviceHome: options.deviceHome });

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

  // A cwd the command cannot write is a cwd that fails on its first redirect,
  // so an unwritable one falls back to the agent's own home.
  const requestedCwd = options.cwd === undefined || options.cwd === null ? view.home : trimPath(options.cwd);
  const cwdDecision = view.classify(requestedCwd);
  const cwd = cwdDecision.access === VIEW_WRITABLE ? cwdDecision.path : view.agentHome;

  if (platform === 'darwin') {
    const env = sandboxEnvironment(options.source ?? process.env, {
      HOME: view.agentHome,
      TMPDIR: view.agentTmp,
      PATH: [...LINUX_PATH_HEAD.map((tail) => path.join(view.agentHome, tail)), ...MAC_PATH_TAIL].join(':'),
      KINU_SANDBOX: '1',
      XDG_RUNTIME_DIR: undefined,
    }, options.dotenv);

    return {
      view,
      argv: [MAC_SANDBOX_EXEC, '-p', buildMacProfile(view), 'bash', '-c', command],
      env,
      cwd,
      // No mount namespace to `--chdir` into, so the process starts there.
      spawnCwd: cwd,
      profile: buildMacProfile(view),
    };
  }

  // Linux: HOME is the real path string, because the agent home is bind-mounted
  // over it. Inside the sandbox the two are the same directory, so a path the
  // model reads in the UI is the path the command sees.
  const env = sandboxEnvironment(options.source ?? process.env, {
    HOME: view.home,
    TMPDIR: '/tmp',
    PATH: [...LINUX_PATH_HEAD.map((tail) => path.join(view.home, tail)), ...LINUX_PATH_TAIL].join(':'),
    XDG_RUNTIME_DIR: '/tmp/xdg',
    NPM_CONFIG_PREFIX: path.join(view.home, '.local'),
    KINU_SANDBOX: '1',
  }, options.dotenv);

  const gpu = options.gpu ?? gpuNodes();

  return {
    view,
    statusFd: options.statusFd,
    argv: buildLinuxArgv(view, { cwd, env, command, gpu, statusFd: options.statusFd }),
    // bwrap carries the environment through `--setenv`, so the process that
    // spawns it needs none of it: an inherited variable here would be a second
    // path into the command's environment.
    env: {},
    cwd,
    gpu,
  };
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
    const attempt = plan({
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
  WITHHELD_ENV,
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
  probe,
  helloCapability,
};
