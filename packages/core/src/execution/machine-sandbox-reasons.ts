/**
 * Why a machine reports it cannot sandbox: the words the device daemon sends (pc-agent/src/sandbox.js requires this
 * module) and the hub reads (device-status.ts). Dependency-free, as the daemon is built with it.
 */
export const MACHINE_SANDBOX_REASONS = ['no_bwrap', 'no_userns', 'wsl1', 'no_sandbox_exec', 'unsupported_platform', 'probe_failed'] as const;
