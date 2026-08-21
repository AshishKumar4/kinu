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
  JsonValueSchema,
  type DeviceCheckpointHint, type DeviceStatus, type DeviceTransport, type JsonValue,
} from '@kinu.run/core';
import * as v from 'valibot';
import { shellQuote } from './cli/install-command';
import type { UserCaller } from './user/workspace-capability';

/** How long the cached device-status snapshot stays fresh before status()
 *  kicks a background re-check against the user hub. */
const DEVICE_STATUS_TTL_MS = 5_000;

/** No machine, and nothing known about one. The `toolchain: null` is not a
 *  detail: it is what keeps "we have not asked" from reading as "it has no
 *  python" once a device does attach. */
const DISCONNECTED: DeviceStatus = { connected: false, registered: false, toolchain: null };

/** The UserDO surface the device transport needs (a DO-to-DO RPC stub view).
 *  Both methods are attenuated at the hub, so both carry the caller identity. */
export interface DeviceHubClient {
  /** Presence AND what the attached machine can run — the hub asks the machine
   *  itself, because a Worker isolate has no PATH to look at. */
  deviceRuntimeStatus(caller: UserCaller): Promise<DeviceStatus>;
  deviceRpc(
    caller: UserCaller,
    method: string,
    params: JsonValue[],
    opts?: DeviceRpcOptions,
  ): Promise<string | undefined>;
}

export interface DeviceRpcOptions {
  agentName?: string;
  checkpoint?: DeviceCheckpointHint;
  timeoutMs?: number;
}

export interface HubDeviceTransportOpts {
  /** Fresh hub stub per call; null when the agent has no owner user yet. */
  hub(): DeviceHubClient | null;
  /** This actor's proof of workspace identity to the hub. Rejects when the
   *  workspace has no capability token — the device plane then reads as
   *  disconnected, which is the fail-closed direction. */
  caller(): Promise<UserCaller>;
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
  let snapshot: DeviceStatus = DISCONNECTED;
  let checkedAt = 0;
  let inFlight: Promise<DeviceStatus> | null = null;

  const refreshStatus = (): Promise<DeviceStatus> => {
    if (inFlight) return inFlight;
    const hub = opts.hub();
    if (!hub) {
      snapshot = DISCONNECTED;
      checkedAt = now();
      return Promise.resolve(snapshot);
    }
    inFlight = opts.caller()
      .then((caller) => hub.deviceRuntimeStatus(caller))
      .then((status) => {
        snapshot = status;
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
    rpc: async (method, params, rpcOpts) => {
      const hub = opts.hub();
      if (!hub) {
        snapshot = DISCONNECTED;
        checkedAt = now();
        throw new Error(NO_DEVICE_CONNECTED);
      }
      try {
        const cwd = opts.cliCwd();
        const effectiveParams: JsonValue[] = method === 'exec' && cwd
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
        const deviceOptions: DeviceRpcOptions = { agentName: opts.agentName, checkpoint };
        if (rpcOpts?.timeoutMs !== undefined) deviceOptions.timeoutMs = rpcOpts.timeoutMs;
        const rawResult = await hub.deviceRpc(
          await opts.caller(), method, effectiveParams, deviceOptions,
        );
        // A call getting through re-proves presence and nothing else: the
        // toolchain answer is the machine's, not this call's, so it is carried
        // forward rather than dropped. Overwriting it here would blank the row
        // the moment the agent used the device.
        snapshot = { ...snapshot, connected: true, registered: true };
        checkedAt = now();
        return rawResult === undefined
          ? undefined
          : v.parse(JsonValueSchema, JSON.parse(rawResult));
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
