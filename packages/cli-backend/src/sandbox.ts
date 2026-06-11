/**
 * Host sandbox for local execution — probes which OS enforcement this
 * machine supports (once, cached) and carries the live policy resolver every
 * local spawn site (host shell, codemode executor, laptop provider) wraps
 * through. The policy model and argv construction live in
 * @proteus/core/safety; this module owns the OS probing and the loud-once
 * degradation warning.
 */

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import {
  buildSandboxedSpawn,
  detectSandboxDenial,
  formatSandboxEscalation,
  type SandboxBackend,
  type SandboxLaunch,
  type SandboxPolicy,
  type SandboxSpawnOpts,
} from '@proteus/core';

/** The live sandbox context every local spawn site receives. */
export interface HostSandbox {
  readonly backend: SandboxBackend;
  /** Resolved fresh per spawn so operator mode changes apply immediately. */
  getPolicy(): SandboxPolicy;
}

let cachedBackend: SandboxBackend | null = null;

/**
 * Probe the strongest working sandbox backend on this host. Probes execute a
 * trivial command under each candidate (presence alone isn't enough — e.g.
 * bwrap exists but user namespaces are disabled), and the result is cached
 * for the process lifetime.
 */
export function detectSandboxBackend(): SandboxBackend {
  if (cachedBackend === null) cachedBackend = probeBackend();
  return cachedBackend;
}

function probeBackend(): SandboxBackend {
  if (platform() === 'darwin') {
    return probeOk('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']) ? 'seatbelt' : 'none';
  }
  if (probeOk('bwrap', [
    '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net',
    '--', '/bin/true',
  ])) return 'bwrap';
  if (probeOk('unshare', ['-Ucn', '/bin/true'])) return 'unshare';
  return 'none';
}

function probeOk(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

const warned = new Set<string>();

/**
 * Build the sandboxed argv for one spawn and surface any degradation warning
 * loudly — once per distinct warning per process, so a missing bwrap is
 * impossible to miss but doesn't spam every command.
 */
export function sandboxLaunch(
  sandbox: HostSandbox,
  innerArgv: readonly string[],
  opts?: SandboxSpawnOpts,
): { policy: SandboxPolicy; launch: SandboxLaunch } {
  const policy = sandbox.getPolicy();
  const launch = buildSandboxedSpawn(policy, sandbox.backend, innerArgv, opts);
  if (launch.warning && !warned.has(launch.warning)) {
    warned.add(launch.warning);
    console.warn(`[proteus sandbox] ${launch.warning}`);
  }
  return { policy, launch };
}

/**
 * Post-execution: when a failed command's stderr matches an enforced sandbox
 * denial, append the structured needs-escalation block so the failure is
 * never silent and the approval layer / user can act on it.
 */
export function annotateSandboxDenial(
  policy: SandboxPolicy,
  launch: SandboxLaunch,
  result: { exitCode: number; stderr: string },
): string {
  const escalation = detectSandboxDenial(policy, result, launch.enforced);
  if (!escalation) return result.stderr;
  return `${result.stderr}${result.stderr.endsWith('\n') || result.stderr === '' ? '' : '\n'}${formatSandboxEscalation(escalation)}`;
}
