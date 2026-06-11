/**
 * Sandbox spawn construction — turn a SandboxPolicy into the argv that
 * OS-enforces it, per available backend:
 *
 *   Linux  : bubblewrap (`bwrap`) — full filesystem + network enforcement.
 *            `unshare -Ucn` fallback — network isolation ONLY (no Landlock
 *            binding exists for Bun/Node without native deps; filesystem
 *            enforcement degrades with a loud warning).
 *   macOS  : `sandbox-exec` with a generated Seatbelt (SBPL) profile.
 *            Implemented from Codex's published profile structure; honestly
 *            UNTESTED on this Linux host — exercised by shape tests only.
 *   none   : the inner argv unchanged, with a warning that states exactly
 *            what is missing and that execution is UNSANDBOXED.
 *
 * Pure functions (no node imports): backends probe availability themselves
 * and pass the chosen SandboxBackend in. The pc-agent daemon mirrors this
 * logic in dependency-free plain JS (packages/pc-agent/src/index.js) — this
 * module is the canonical model; keep them in sync.
 */

import {
  type SandboxPolicy,
  type SandboxEnforcement,
} from './sandbox-policy.js';

export type SandboxBackend = 'bwrap' | 'unshare' | 'seatbelt' | 'none';

export interface SandboxLaunch {
  readonly argv: readonly string[];
  /** What the OS will actually enforce for this launch. */
  readonly enforced: SandboxEnforcement;
  /** Set when enforcement degrades below what the policy asks for. The text
   *  states exactly what is missing — callers must surface it loudly. */
  readonly warning?: string;
}

export interface SandboxSpawnOpts {
  /** Files bound read-only INTO the sandbox even where the policy mounts a
   *  fresh tmpfs over their directory (e.g. the executor's /tmp wrapper
   *  script under 'read-only'). */
  readonly readOnlyFiles?: readonly string[];
}

/** Build the spawn argv enforcing `policy` via `backend` around `innerArgv`. */
export function buildSandboxedSpawn(
  policy: SandboxPolicy,
  backend: SandboxBackend,
  innerArgv: readonly string[],
  opts?: SandboxSpawnOpts,
): SandboxLaunch {
  if (policy.mode === 'full') {
    return { argv: [...innerArgv], enforced: { filesystem: false, network: false } };
  }
  switch (backend) {
    case 'bwrap':
      return bwrapLaunch(policy, innerArgv, opts);
    case 'seatbelt':
      return seatbeltLaunch(policy, innerArgv);
    case 'unshare':
      return unshareLaunch(policy, innerArgv);
    case 'none':
      return {
        argv: [...innerArgv],
        enforced: { filesystem: false, network: false },
        warning:
          `sandbox mode '${policy.mode}' is NOT enforced: no OS sandbox is available on this host ` +
          `(Linux: install bubblewrap [bwrap] for filesystem+network enforcement, or util-linux unshare ` +
          `with user namespaces for network-only isolation; macOS: sandbox-exec). ` +
          `Commands run UNSANDBOXED with the user's full permissions.`,
      };
  }
}

function bwrapLaunch(policy: SandboxPolicy, innerArgv: readonly string[], opts?: SandboxSpawnOpts): SandboxLaunch {
  const argv = ['bwrap', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  if (policy.mode === 'read-only') {
    // Fresh tmpfs over /tmp: scratch writes vanish, the real fs stays untouched.
    argv.push('--tmpfs', '/tmp');
    for (const file of opts?.readOnlyFiles ?? []) argv.push('--ro-bind', file, file);
  } else {
    for (const root of policy.writableRoots) argv.push('--bind', root, root);
  }
  if (!policy.network) argv.push('--unshare-net');
  argv.push('--', ...innerArgv);
  return { argv, enforced: { filesystem: true, network: !policy.network } };
}

function unshareLaunch(policy: SandboxPolicy, innerArgv: readonly string[]): SandboxLaunch {
  const fsWarning =
    `bubblewrap (bwrap) not found — the filesystem restrictions of sandbox mode '${policy.mode}' are ` +
    `NOT enforced on this host. Install bubblewrap for full enforcement.`;
  if (policy.network) {
    // Nothing unshare can enforce: the only restriction left is filesystem.
    return { argv: [...innerArgv], enforced: { filesystem: false, network: false }, warning: fsWarning };
  }
  return {
    // -U new user ns, -c map current user, -n new (empty) network ns.
    argv: ['unshare', '-Ucn', '--', ...innerArgv],
    enforced: { filesystem: false, network: true },
    warning: `${fsWarning} Network isolation IS enforced via 'unshare -Ucn'.`,
  };
}

function seatbeltLaunch(policy: SandboxPolicy, innerArgv: readonly string[]): SandboxLaunch {
  return {
    argv: ['sandbox-exec', '-p', buildSeatbeltProfile(policy), ...innerArgv],
    enforced: { filesystem: true, network: !policy.network },
  };
}

/**
 * Generate the Seatbelt (SBPL) profile for a policy. Deny-by-default with
 * read access everywhere, writes only in the policy's writable roots, and
 * network only when the policy allows it — the same structure Codex ships.
 *
 * HONEST STATUS: written on a Linux host where sandbox-exec cannot run; the
 * profile is covered by shape tests only and needs a macOS verification pass.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target same-sandbox))',
    '(allow file-read*)',
    // /dev/null and friends: redirects like `>/dev/null` must not trip the sandbox.
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
  ];
  if (policy.mode === 'workspace-write' && policy.writableRoots.length > 0) {
    const subpaths = policy.writableRoots.map((r) => `(subpath "${sbplEscape(r)}")`).join(' ');
    lines.push(`(allow file-write* ${subpaths})`);
  }
  if (policy.network) {
    lines.push('(allow network*)', '(allow system-socket)');
  }
  return lines.join('\n');
}

function sbplEscape(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
