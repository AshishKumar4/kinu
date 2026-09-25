/**
 * Device status: live availability of the user's machines and what each can run, for per-turn context.
 * The user-level device hub (UserDO on CF) is the single source of truth; backends diff presence against
 * a persisted watermark at turn start. The account is a fleet: one row per machine, several may be live.
 */

import * as v from 'valibot';
import type { ExecutorCapability } from './types';
import { TOOLCHAIN_PROBED_CAPABILITIES, toolchainCapabilities } from './toolchain';
import { NO_DEVICE_CONNECTED } from './device-tunnel';

/** What an attached machine answered when asked what it can run. `asked` travels with the answer
 *  so an answer taken before the table grew does not read as newer capabilities measured absent. */
export interface DeviceToolchain {
  /** Capabilities the machine was shown to have. */
  readonly present: readonly ExecutorCapability[];
  /** In `asked` but not `present` means measured absent; outside `asked` means never measured. */
  readonly asked: readonly ExecutorCapability[];
  /** When the machine answered, by the hub's clock. */
  readonly probedAt: number;
}

/** How long an answer stays evidence. The hub normally re-asks a stale record first;
 *  expiry reads as never-probed, never as absent. */
export const DEVICE_TOOLCHAIN_TTL_MS = 120_000;

/** Shape a host's resolved binaries into evidence; the only constructor, so `present ⊆ asked`. */
export function deviceToolchainAnswer(
  binaries: Iterable<string>,
  probedAt: number,
): DeviceToolchain {
  return {
    present: toolchainCapabilities(binaries),
    asked: TOOLCHAIN_PROBED_CAPABILITIES,
    probedAt,
  };
}

/** One registered machine as an agent sees it before any grant: identity and liveness only. */
export interface DeviceFleetEntry {
  readonly id: string;
  /** The user-chosen name (default `user@hostname`). */
  readonly name: string;
  readonly os: string | null;
  readonly hostname: string | null;
  readonly connected: boolean;
  /** Whether this caller's workspace holds an action grant on this machine. Absent = unknown or
   *  not a workspace caller. Grants nothing; every call still crosses the consent chokepoint. */
  readonly granted?: boolean;
  /** How this machine runs a command for this workspace; absent when offline or not a workspace caller. */
  readonly sandbox?: DeviceSandboxStatus;
  /** Toolchain answer, or null when never asked or unable to answer (not the same as absent tools). */
  readonly toolchain?: DeviceToolchain | null;
  /** The directory named at `kinu connect`: the base tier's whole reach. Null from older daemons. */
  readonly consentedRoot?: string | null;
  /** This machine's home, as reported on HELLO. */
  readonly deviceHome?: string | null;
}

/** The fleet as one flat list — every registered machine with its liveness. */
export type DeviceFleet = readonly DeviceFleetEntry[];

/** Every machine in the fleet that is live right now, fleet order preserved. */
export function connectedDevices(fleet: DeviceFleet | undefined): DeviceFleetEntry[] {
  return (fleet ?? []).filter((device) => device.connected);
}

/** The ask returned when a command named no device and several machines could answer. */
export function deviceFleetAsk(fleet: DeviceFleet | undefined): string {
  const live = connectedDevices(fleet);

  if (live.length === 0) return NO_DEVICE_CONNECTED;
  const names = live.map((device) => `${device.name}${device.os ? ` (${device.os})` : ''}`).join(', ');

  return `name the machine this command runs on — connected: ${names}. Pass it as device: "<name>".`;
}

/** A connected device by name, or null when none or several live machines match. */
export function deviceByName(fleet: DeviceFleet | undefined, name: string): DeviceFleetEntry | null {
  const live = connectedDevices(fleet);
  const matches = live.filter((device) => device.name === name);

  return matches.length === 1 ? matches[0] : null;
}

/** What a device runs commands under: the owner's per-device Sandbox switch, on by default. */
export const DEVICE_TIERS = ['sandboxed', 'raw'] as const;

export type DeviceTier = (typeof DEVICE_TIERS)[number];

/**
 * What the daemon proved at start, not what it was asked for.
 *   `sandboxed`  the kernel sandbox probe passed.
 *   `files_only` the probe failed; no shell runs while the sandbox is on.
 *   `raw_only`   no sandbox to prove: commands run unconfined or not at all.
 * A machine that cannot sandbox is never silently downgraded to unconfined.
 */
export const DEVICE_SANDBOX_CAPABILITIES = ['sandboxed', 'files_only', 'raw_only'] as const;

export type DeviceSandboxCapability = (typeof DEVICE_SANDBOX_CAPABILITIES)[number];

/** Why a machine cannot sandbox; each value has one documented fix. The first six mirror
 *  `SANDBOX_STATUS` in `packages/pc-agent/src/sandbox.js` (hub tests hold them equal). `probe_failed`
 *  defers to `DeviceSandboxStatus.detail`; `daemon_outdated` is hub-assigned for daemons sending no field. */
export const DEVICE_SANDBOX_REASONS = [
  'no_bwrap', 'no_userns', 'wsl1', 'no_sandbox_exec', 'unsupported_platform', 'probe_failed',
  'daemon_outdated',
] as const;

export type DeviceSandboxReason = (typeof DEVICE_SANDBOX_REASONS)[number];

/** The owner's tier narrowed by what the machine proved. `files_only` is never granted. */
export type DeviceMode = DeviceTier | 'files_only';

/** Sandbox state of the connected device for one calling workspace (home and roots are per workspace). */
export interface DeviceSandboxStatus {
  /** What the owner set. */
  readonly tier: DeviceTier;
  /** What the machine proved. */
  readonly capability: DeviceSandboxCapability;
  /** Why the machine cannot sandbox, or null when it can or did not say. */
  readonly reason: DeviceSandboxReason | null;
  /** The words behind a non-`sandboxed` verdict (daemon's `reasonDetail`, else the hub's), or null. */
  readonly detail: string | null;
  /** GPU device nodes found, e.g. `/dev/nvidia0`. Empty means measured empty. */
  readonly gpu: readonly string[];
  /** This workspace's private, persistent home on the machine. Null when unknown; sandboxed commands need it. */
  readonly agentHome: string | null;
  /** Owner-consented directories, writable at their real paths inside the sandbox. */
  readonly roots: readonly string[];
}

const DeviceTierSchema = v.picklist(DEVICE_TIERS);

const DeviceSandboxCapabilitySchema = v.picklist(DEVICE_SANDBOX_CAPABILITIES);

const DeviceSandboxReasonSchema = v.picklist(DEVICE_SANDBOX_REASONS);

/** Narrow a stored tier; unrecognised is sandboxed, so a damaged row never reads as off. */
export function parseDeviceTier(raw: string | null | undefined): DeviceTier {
  const parsed = v.safeParse(DeviceTierSchema, raw);

  return parsed.success ? parsed.output : 'sandboxed';
}

/** Narrow a reported capability; unrecognised or missing is `files_only`. */
export function parseSandboxCapability(raw: string | null | undefined): DeviceSandboxCapability {
  const parsed = v.safeParse(DeviceSandboxCapabilitySchema, raw);

  return parsed.success ? parsed.output : 'files_only';
}

/** Narrow a reported reason; unrecognised is null ("did not say"). */
export function parseSandboxReason(raw: string | null | undefined): DeviceSandboxReason | null {
  const parsed = v.safeParse(DeviceSandboxReasonSchema, raw);

  return parsed.success ? parsed.output : null;
}

/** Owner setting plus machine fact → effective tier. Shared by the hub, prompt and Settings row. */
export function effectiveDeviceMode(
  sandbox: Pick<DeviceSandboxStatus, 'tier' | 'capability'>,
): DeviceMode {
  if (sandbox.tier === 'raw') return 'raw';

  return sandbox.capability === 'sandboxed' ? 'sandboxed' : 'files_only';
}

/** The owner-facing fix for each reason, shown by `kinu connect` and the Settings row. Surfaces drop
 *  the reason code, so the sentence must carry the action. Backticks render as code in Settings. */
const SANDBOX_REASON_FIX = {
  no_bwrap:
    'Install bubblewrap: `sudo apt install bubblewrap`, `sudo dnf install bubblewrap`, '
    + 'or `sudo pacman -S bubblewrap`.',
  no_userns:
    'Install the packaged bubblewrap (Ubuntu 23.10 and later), or run '
    + '`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.',
  wsl1: 'Run `wsl --set-version <distro> 2`, then connect again.',
  no_sandbox_exec: 'Turn Sandbox off for this device to run commands.',
  unsupported_platform:
    'The sandbox needs Linux or macOS. Turn Sandbox off for this device to run commands.',
  probe_failed: 'Fix what the daemon named, then run `kinu connect` on that machine again.',
  daemon_outdated: 'Update the Kinu CLI, then run `kinu connect` again.',
} satisfies Record<DeviceSandboxReason, string>;

/** What the owner can do about a reason; no reason gets the action that can still answer. */
export function sandboxReasonFix(reason: DeviceSandboxReason | null): string {
  return reason === null
    ? 'Run `kinu connect` on that machine to retry.'
    : SANDBOX_REASON_FIX[reason];
}

/** Why the machine cannot sandbox, as one phrase; every surface rendering a cause reads it here. */
export function sandboxCause(sandbox: Pick<DeviceSandboxStatus, 'reason' | 'detail'>): string {
  if (sandbox.reason !== null && sandbox.detail !== null) return `${sandbox.reason}: ${sandbox.detail}`;

  return sandbox.reason ?? sandbox.detail ?? 'the daemon reported no reason';
}

/** GPU nodes as a short phrase. `none` is measured absent, never unknown. */
export function describeGpuNodes(nodes: readonly string[]): string {
  const names = nodes.map((node) => node.replace(/^\/dev\//, '')).filter((name) => name.length > 0);

  return names.length > 0 ? names.join(', ') : 'none';
}

/** Hub snapshot of the user's device fleet, from the transport's perspective. */
export interface DeviceStatus {
  /** A live daemon socket is open on the user's device hub right now. */
  connected: boolean;
  /** The user has at least one registered (non-revoked) device. */
  registered: boolean;
  /** Toolchain answer, or null when never asked or unable to answer. */
  toolchain: DeviceToolchain | null;
  /** Every registered device, present only in the enriched snapshot. Absent is unknown, not "no devices". */
  devices?: readonly DeviceFleetEntry[];
  /** Whether this caller's workspace holds an action grant on the connected device, so the model
   *  knows if its first call raises the consent card. Absent = unknown / no device / non-workspace caller. */
  workspaceGranted?: boolean;
  /** The directory named at `kinu connect`. Null from older daemons: the base tier then fails closed. */
  consentedRoot?: string | null;
  /** The machine's home as reported on HELLO, so the hub never runs a command to learn it. */
  deviceHome?: string | null;
  /** How the connected device runs a command for this workspace; absent when none is connected. */
  sandbox?: DeviceSandboxStatus;
}

/** An answer still inside its window, or null (expiry reads as never-probed). */
export function freshDeviceToolchain(
  toolchain: DeviceToolchain | null | undefined,
  now: number,
): DeviceToolchain | null {
  if (!toolchain) return null;

  return now - toolchain.probedAt < DEVICE_TOOLCHAIN_TTL_MS ? toolchain : null;
}
