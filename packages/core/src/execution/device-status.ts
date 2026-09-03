/**
 * Device status — the laptop runtime's live availability AND what that machine
 * can run, as the agent's per-turn context must see it.
 *
 * The user-level device hub (UserDO on CF) is the single source of truth for
 * whether the user's PC is reachable. These helpers reduce a hub snapshot to
 * the three-state presence the prompt cares about and render the one-turn
 * change notice for mid-session connect/disconnect transitions. Backends diff
 * `devicePresence` against the last presence they observed (a watermark, not
 * a second source of truth) at turn start — no polling between turns.
 *
 * The snapshot also carries the machine's own answer to the toolchain question
 * (`execution/toolchain.ts`), because the `laptop` capability row is otherwise
 * only what the tunnel's existence establishes: honest, and useless for routing
 * language work to a machine that may well have node, bun and python on it.
 */

import * as v from 'valibot';
import type { ExecutorCapability } from './types';
import { TOOLCHAIN_PROBED_CAPABILITIES, toolchainCapabilities } from './toolchain';

/**
 * What an attached machine answered when asked what it can run.
 *
 * Built by `deviceToolchainAnswer` from the binaries a host resolved, so
 * `present ⊆ asked` holds by construction: a declaration cannot claim a wider
 * measurement than was taken. `asked` travels with the answer rather than being
 * re-read from the current table, because the answer outlives the code that
 * recorded it — an answer taken before the table grew must not read as "the new
 * capability was measured absent".
 */
export interface DeviceToolchain {
  /** Capabilities the machine was shown to have. */
  readonly present: readonly ExecutorCapability[];
  /** What this answer covers. In `asked` and not in `present` means MEASURED
   *  ABSENT; outside `asked` means never measured, which is not the same thing. */
  readonly asked: readonly ExecutorCapability[];
  /** When the machine answered, by the hub's clock. */
  readonly probedAt: number;
}

/**
 * How long an answer stays evidence.
 *
 * A toolchain changes under a long session — the agent can `npm i -g` onto that
 * very machine — so a cached row that outlives its measurement is the failure
 * the probe exists to prevent. The hub re-asks a stale record before answering,
 * so this bound normally only fires when a backend is serving a device snapshot
 * it could not refresh. Expiring reads as never-probed, never as absent.
 */
export const DEVICE_TOOLCHAIN_TTL_MS = 120_000;

/**
 * Shape a host's raw answer — the binary names it resolved on its own PATH —
 * into the row's evidence. The ONE constructor, so the measured scope is always
 * the scope the table actually asked about and no caller can widen it.
 */
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

/** One registered machine, as an agent may see it BEFORE any grant: its
 *  identity and liveness, never its contents. Visibility without reach is the
 *  whole point — the agent must know asking is possible, and nothing here
 *  grants a single call. */
export interface DeviceFleetEntry {
  readonly id: string;
  /** The user-chosen name (default `user@hostname`). */
  readonly name: string;
  readonly os: string | null;
  readonly hostname: string | null;
  readonly connected: boolean;
}

/**
 * What a device runs commands under. The owner sets it per device in Settings
 * — one switch, "Sandbox", on by default. The model never picks a tier, and no
 * agent can change one.
 */
export const DEVICE_TIERS = ['sandboxed', 'raw'] as const;
export type DeviceTier = (typeof DEVICE_TIERS)[number];

/**
 * What the daemon PROVED when it started, which is not what it was asked for.
 *
 *   `sandboxed`  the kernel sandbox probe passed, so this machine can honour
 *                the sandboxed tier.
 *   `files_only` the probe failed. No shell runs while the sandbox is on.
 *   `raw_only`   this machine has no sandbox to prove: the daemon runs a
 *                command unconfined or not at all.
 *
 * A machine that cannot sandbox is never silently downgraded to unconfined.
 * The owner turns the sandbox off, or the machine runs no commands.
 */
export const DEVICE_SANDBOX_CAPABILITIES = ['sandboxed', 'files_only', 'raw_only'] as const;
export type DeviceSandboxCapability = (typeof DEVICE_SANDBOX_CAPABILITIES)[number];

/** Why a machine cannot sandbox. A closed vocabulary, because each value has
 *  ONE documented fix the owner can act on and free text has none.
 *
 *  `daemon_outdated` is the one the hub assigns rather than the machine: every
 *  daemon deployed before this contract sends no sandbox field at all, and
 *  "it did not say" is not something an owner can act on. It names the build,
 *  and its fix is the only fix. */
export const DEVICE_SANDBOX_REASONS = [
  'no_bwrap', 'no_userns', 'wsl1', 'no_sandbox_exec', 'unsupported_platform',
  'daemon_outdated',
] as const;
export type DeviceSandboxReason = (typeof DEVICE_SANDBOX_REASONS)[number];

/** How a device runs a command right now: the tier the owner set, narrowed by
 *  what the machine proved. `files_only` is never granted — it is where a
 *  device that cannot sandbox lands while the sandbox stays on. */
export type DeviceMode = DeviceTier | 'files_only';

/** The sandbox state of the connected device, for ONE calling workspace. The
 *  home and the roots are per workspace, so two workspaces on one machine read
 *  two different values here. */
export interface DeviceSandboxStatus {
  /** What the owner set. */
  readonly tier: DeviceTier;
  /** What the machine proved. */
  readonly capability: DeviceSandboxCapability;
  /** Why the machine cannot sandbox, or null when it can — or when it could
   *  not say. */
  readonly reason: DeviceSandboxReason | null;
  /** GPU device nodes the daemon found, e.g. `/dev/nvidia0`. An empty list is
   *  MEASURED empty: the daemon looked. */
  readonly gpu: readonly string[];
  /** This workspace's own home on the machine, which persists across turns and
   *  which no other workspace can read. Null when the daemon has not said
   *  where agent homes live, and a sandboxed command cannot run without it. */
  readonly agentHome: string | null;
  /** Directories on the machine the owner consented, writable at their real
   *  paths inside the sandbox. */
  readonly roots: readonly string[];
}

const DeviceTierSchema = v.picklist(DEVICE_TIERS);
const DeviceSandboxCapabilitySchema = v.picklist(DEVICE_SANDBOX_CAPABILITIES);
const DeviceSandboxReasonSchema = v.picklist(DEVICE_SANDBOX_REASONS);

/** Narrow a stored tier. Anything unrecognised is the sandboxed tier: the
 *  switch is on by default, and a damaged row must not read as "off". */
export function parseDeviceTier(raw: string | null | undefined): DeviceTier {
  const parsed = v.safeParse(DeviceTierSchema, raw);
  return parsed.success ? parsed.output : 'sandboxed';
}

/** Narrow a reported capability. Anything unrecognised — including the silence
 *  of a daemon too old to answer — is `files_only`: a machine that has not
 *  proved it can sandbox has not proved it can sandbox. */
export function parseSandboxCapability(raw: string | null | undefined): DeviceSandboxCapability {
  const parsed = v.safeParse(DeviceSandboxCapabilitySchema, raw);
  return parsed.success ? parsed.output : 'files_only';
}

/** Narrow a reported reason. Unrecognised is null — "it did not say", which
 *  the surfaces render as exactly that rather than inventing a cause. */
export function parseSandboxReason(raw: string | null | undefined): DeviceSandboxReason | null {
  const parsed = v.safeParse(DeviceSandboxReasonSchema, raw);
  return parsed.success ? parsed.output : null;
}

/**
 * The one rule that turns an owner setting plus a machine fact into what
 * actually happens. Written once because the hub enforces it, the prompt
 * renders it, and the Settings row explains it — three readers, one answer.
 */
export function effectiveDeviceMode(
  sandbox: Pick<DeviceSandboxStatus, 'tier' | 'capability'>,
): DeviceMode {
  if (sandbox.tier === 'raw') return 'raw';
  return sandbox.capability === 'sandboxed' ? 'sandboxed' : 'files_only';
}

/** The fix for each reason, in the words the owner needs. `kinu connect`
 *  prints it, and the Settings device row shows the same sentence. Each one
 *  states the action and stops: no UI surface prints the reason code itself
 *  (the CLI line and the Settings row both drop it), so this sentence carries
 *  everything the owner can act on. Commands stay in
 *  backticks, which the Settings row renders as code. */
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
  daemon_outdated: 'Update the Kinu CLI, then run `kinu connect` again.',
} satisfies Record<DeviceSandboxReason, string>;

/** What the owner can do about a reason. A machine that named no reason gets
 *  the one action that can still answer the question. */
export function sandboxReasonFix(reason: DeviceSandboxReason | null): string {
  return reason === null
    ? 'Run `kinu connect` on that machine to retry.'
    : SANDBOX_REASON_FIX[reason];
}

/** The GPU nodes as one short phrase for a status line. `none` is measured
 *  absent, never unknown — the daemon enumerates /dev on every exec. */
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
  /** The attached machine's toolchain answer, or null when it was never asked
   *  or could not answer — an old daemon with no probe method is not a machine
   *   without python. */
  toolchain: DeviceToolchain | null;
  /** Every registered device with name, platform and live state. Present only
   *  when the hub serves the enriched snapshot; absent reads as "unknown",
   *  never as "no devices". */
  devices?: readonly DeviceFleetEntry[];
  /** Whether THIS caller's workspace holds an action grant on the connected
   *  device — what the executor row renders so the model knows whether its
   *  first call raises the consent card or just runs. Absent = unknown /
   *  no device / non-workspace caller. */
  workspaceGranted?: boolean;
  /** The directory the owner named at `kinu connect`, which is the whole of
   *  the base tier's reach. Null when the connected daemon predates the field:
   *  the base tier then has no scope, which fails closed rather than falling
   *  back to the home directory. */
  consentedRoot?: string | null;
  /** The machine's own home, as the machine reported it on HELLO. The file
   *  view opens here under the full tier; carried so the hub never runs a
   *  command on the machine to learn a path. */
  deviceHome?: string | null;
  /** How the connected device runs a command for THIS caller's workspace: the
   *  owner's tier, what the machine proved, and the workspace's own home and
   *  roots on it. Absent when no device is connected. */
  sandbox?: DeviceSandboxStatus;
}

/** What the turn context says about the user's PC. */
export type DevicePresence = 'connected' | 'offline' | 'none';

/** Config key under which backends persist the last presence they observed. */
export const DEVICE_PRESENCE_CONFIG_KEY = 'device_last_presence';

export function devicePresence(status: DeviceStatus): DevicePresence {
  if (status.connected) return 'connected';
  return status.registered ? 'offline' : 'none';
}

/**
 * An answer still inside its window, or null.
 *
 * Expiry reads as never-probed, which is the whole point: the row loses the
 * languages it can no longer vouch for instead of asserting their absence.
 */
export function freshDeviceToolchain(
  toolchain: DeviceToolchain | null | undefined,
  now: number,
): DeviceToolchain | null {
  if (!toolchain) return null;
  return now - toolchain.probedAt < DEVICE_TOOLCHAIN_TTL_MS ? toolchain : null;
}

/** Parse a persisted watermark. Unknown/missing values mean "never observed". */
export function parseDevicePresence(value: string | null | undefined): DevicePresence | null {
  return value === 'connected' || value === 'offline' || value === 'none' ? value : null;
}

/** The key-value surface observeDevicePresence persists its watermark in —
 *  satisfied by the AgentConfigStore's generic accessors. */
export interface DevicePresenceStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * Record a fresh hub observation at turn start: diff it against the last
 * persisted presence, advance the watermark, and return the one-turn change
 * notice (or null). The notice fires exactly once per transition — the
 * watermark only advances here, so a connect between turns is announced on
 * the next turn and never again.
 */
export function observeDevicePresence(
  store: DevicePresenceStore,
  status: DeviceStatus,
) {
  const presence = devicePresence(status);
  const lastSeen = parseDevicePresence(store.get(DEVICE_PRESENCE_CONFIG_KEY));
  if (lastSeen !== presence) store.set(DEVICE_PRESENCE_CONFIG_KEY, presence);
  return { presence, notice: deviceChangeNotice(lastSeen, presence) };
}

/**
 * The clearly-marked context block injected at the latest position of the
 * next turn when device availability changed mid-session. Null when nothing
 * changed, on the first observation (nothing to diff against), or for
 * transitions that don't change what the agent can reach (offline ↔ none).
 */
export function deviceChangeNotice(prev: DevicePresence | null, current: DevicePresence): string | null {
  if (prev === null || prev === current) return null;
  if (current === 'connected') {
    return '## Context update\n' +
      "Your user's PC just connected — the `laptop` runtime is now available. " +
      'Consent will be requested on its first use; that prompt is expected, not an error.';
  }
  if (prev === 'connected') {
    return '## Context update\n' +
      "Your user's PC just disconnected — the `laptop` runtime is offline" +
      (current === 'offline'
        ? '. The user can reconnect it by running `kinu connect` on their machine.'
        : ' and the device is no longer registered.');
  }
  return null;
}
