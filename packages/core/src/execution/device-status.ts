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

/** Hub snapshot of the user's device fleet, from the transport's perspective. */
export interface DeviceStatus {
  /** A live daemon socket is open on the user's device hub right now. */
  connected: boolean;
  /** The user has at least one registered (non-revoked) device. */
  registered: boolean;
  /** The attached machine's toolchain answer, or null when it was never asked
   *  or could not answer — an old daemon with no probe method is not a machine
   *  without python. */
  toolchain: DeviceToolchain | null;
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
