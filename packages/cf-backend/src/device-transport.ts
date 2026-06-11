/**
 * The laptop runtime's DeviceTransport over the user-level device hub (UserDO).
 *
 * `status()` is sync + hot (it gates per-turn tool exposure), so it serves a
 * cached snapshot refreshed from the hub in the background once it goes stale —
 * a device connecting AFTER the runtime was built becomes visible within the
 * TTL, without a DO restart. `refreshStatus()` awaits the hub authoritatively;
 * the orchestrator calls it at turn start so the turn's context never lags a
 * mid-session connect/disconnect. Actual calls stay authoritative either way:
 * the hub rejects when no device is connected, and each call's outcome
 * re-seeds the snapshot.
 */
import {
  NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  type DeviceCheckpointHint, type DeviceStatus, type DeviceTransport,
} from '@proteus/core';
import { shellQuote } from './cli/install-command.js';

/** How long the cached device-status snapshot stays fresh before status()
 *  kicks a background re-check against the user hub. */
const DEVICE_STATUS_TTL_MS = 5_000;

/** The UserDO surface the device transport needs (a DO-to-DO RPC stub view). */
export interface DeviceHubClient {
  listDevices(): Promise<Array<{ connected: boolean }>>;
  deviceRpc(
    method: string,
    params: unknown[],
    opts?: { agentName?: string; checkpoint?: DeviceCheckpointHint },
  ): Promise<unknown>;
}

export interface HubDeviceTransportOpts {
  /** Fresh hub stub per call; null when the agent has no owner user yet. */
  hub(): DeviceHubClient | null;
  /** Passed with every RPC so the hub can enforce per-agent consent. */
  agentName: string;
  /** CLI-forwarded working directory for laptop exec calls, when present. */
  cliCwd(): string | null;
  /** Current turn identity for the daemon's pre-mutation shadow-git snapshot
   *  (deduped daemon-side per turn). Null outside turns / when unwired. */
  checkpointMeta?: () => { turnId: string; sessionId: string } | null;
  now?: () => number;
}

export function createHubDeviceTransport(opts: HubDeviceTransportOpts): DeviceTransport {
  const now = opts.now ?? Date.now;
  let snapshot: DeviceStatus = { connected: false, registered: false };
  let checkedAt = 0;
  let inFlight: Promise<DeviceStatus> | null = null;

  const refreshStatus = (): Promise<DeviceStatus> => {
    if (inFlight) return inFlight;
    const hub = opts.hub();
    if (!hub) {
      snapshot = { connected: false, registered: false };
      checkedAt = now();
      return Promise.resolve(snapshot);
    }
    inFlight = hub.listDevices()
      .then((devices) => {
        snapshot = { connected: devices.some((d) => d.connected), registered: devices.length > 0 };
        return snapshot;
      })
      .catch(() => snapshot) // transient hub error — keep the last snapshot
      .finally(() => { checkedAt = now(); inFlight = null; });
    return inFlight;
  };

  return {
    status: () => {
      if (!inFlight && now() - checkedAt >= DEVICE_STATUS_TTL_MS) void refreshStatus();
      return snapshot;
    },
    refreshStatus,
    rpc: async (method, params) => {
      const hub = opts.hub();
      if (!hub) {
        snapshot = { connected: false, registered: false };
        checkedAt = now();
        throw new Error(NO_DEVICE_CONNECTED);
      }
      try {
        const cwd = opts.cliCwd();
        const effectiveParams = method === 'exec' && cwd
          ? [`cd ${shellQuote(cwd)} && ${String(params[0] ?? '')}`]
          : params;
        // Mutating methods carry the pre-mutation snapshot hint; the daemon
        // checkpoints the target dir before executing (invisible, per-turn).
        const meta = (method === 'exec' || method === 'writeFile') ? opts.checkpointMeta?.() ?? null : null;
        const checkpoint: DeviceCheckpointHint | undefined = meta ? {
          agent: opts.agentName,
          turnId: meta.turnId,
          sessionId: meta.sessionId,
          dir: method === 'exec' ? cwd : null,
        } : undefined;
        const result = await hub.deviceRpc(method, effectiveParams, { agentName: opts.agentName, checkpoint });
        snapshot = { connected: true, registered: true };
        checkedAt = now();
        return result;
      } catch (err) {
        if (isDeviceNotConnectedError(err)) {
          snapshot = { ...snapshot, connected: false };
          checkedAt = now();
        }
        throw err;
      }
    },
  };
}
