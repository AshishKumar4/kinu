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
  NO_DEVICE_CONNECTED, isDeviceNotConnectedError, nextDeviceRequestId,
  JsonValueSchema,
  type DeviceCheckpointHint, type DeviceStatus, type DeviceTransport, type JsonValue,
} from '@kinu.run/core';
import { diagnostics, toKinuError, type LogEventName } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { shellQuote } from './cli/install-command';
import type { UserCaller } from './user/workspace-capability';


/** How long the cached device-status snapshot stays fresh before status()
 *  kicks a background re-check against the user hub. */
const DEVICE_STATUS_TTL_MS = 5_000;

/**
 * What a background re-check does with a hub failure. The failure is RECORDED
 * first, then tolerated as a request-scope non-fatal: the answer to a stale
 * `status()` is still the snapshot it holds, and tearing a working snapshot
 * down to `disconnected` on a blip would blind the tool gating that reads it.
 * What the old detached `.catch(() => snapshot)` destroyed was the record — a
 * hub that had stopped answering read exactly like a hub with nothing to say.
 */
const STATUS_RECHECK_FAILED: LogEventName = 'device.status_refresh_failed';


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
  acknowledgeDeviceRequest(caller: UserCaller, requestId: string): Promise<void>;
}

export interface DeviceRpcOptions {
  agentName?: string;
  checkpoint?: DeviceCheckpointHint;
  timeoutMs?: number;
  /** The canonical identity to issue the call under, so the caller can cancel
   *  it by that same id. Minted by core's protocol authority. */
  requestId?: string;
  /** The durable background job that owns this call as it is issued, so the
   *  request is recorded as that job's rather than handed over afterwards.
   *  Cloud-side only: it never rides the frame to the device. */
  backgroundJobId?: string;
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

interface StatusRefresh {
  promise: Promise<DeviceStatus> | null;
}

export function createHubDeviceTransport(opts: HubDeviceTransportOpts): DeviceTransport {
  const now = opts.now ?? Date.now;
  let snapshot: DeviceStatus = DISCONNECTED;
  let checkedAt = 0;
  let inFlight: StatusRefresh | null = null;

  /**
   * The authoritative hub check, deduped while one is running. The failure
   * arm lives HERE, once, under a lexical owner: a device-status failure is
   * recorded (see `STATUS_RECHECK_FAILED`) and then represented as "keep the
   * last snapshot" — the transport's documented answer to a transient hub
   * error, and the fail-closed direction the turn start awaits. The slot is
   * released only while this round trip still owns it, so a later re-check
   * can never be cleared by an earlier failure.
   */
  const beginStatusRefresh = (): StatusRefresh => {
    if (inFlight?.promise) return inFlight;
    const hub = opts.hub();
    if (!hub) {
      snapshot = DISCONNECTED;
      checkedAt = now();
      return { promise: Promise.resolve(snapshot) };
    }
    const owner: StatusRefresh = { promise: null };
    inFlight = owner;
    owner.promise = (async (): Promise<DeviceStatus> => {
      try {
        const status = await opts.caller().then((caller) => hub.deviceRuntimeStatus(caller));
        snapshot = status;
      } catch (cause) {
        // Transient hub error — keep the last snapshot. The outcome is recorded
        // rather than only tolerated, so a hub gone dark is a line in the journal
        // and not silence wearing the cache.
        diagnostics.failure(STATUS_RECHECK_FAILED, toKinuError({
          doing: 'refreshing the device status from the hub',
          cause,
          otherwise: 'unavailable',
        }));
      } finally {
        checkedAt = now();
        if (inFlight === owner) inFlight = null;
      }
      return snapshot;
    })();
    return owner;
  };
  const refreshStatus = (): Promise<DeviceStatus> => (
    beginStatusRefresh().promise ?? Promise.resolve(snapshot)
  );

  return {
    /**
     * Sync + hot, so it serves the cache and KICKS a re-check when stale. The
     * kick is not a promise discarded into the air: the retained `inFlight`
     * slot IS the ownership — the same slot `refreshStatus()` dedupes against
     * — and the lexical `catch` inside that round trip is where a hub failure
     * becomes a recorded one. `refreshStatus` never rejects, so there is no
     * rejection to lose.
     */
    status: (): DeviceStatus => {
      if (!inFlight && now() - checkedAt >= DEVICE_STATUS_TTL_MS) beginStatusRefresh();
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
        const requestId = method === 'exec' ? rpcOpts?.requestId ?? nextDeviceRequestId() : undefined;
        const deviceOptions: DeviceRpcOptions = { agentName: opts.agentName, checkpoint };
        if (rpcOpts?.timeoutMs !== undefined) deviceOptions.timeoutMs = rpcOpts.timeoutMs;
        if (requestId !== undefined) deviceOptions.requestId = requestId;
        if (rpcOpts?.backgroundJobId !== undefined) {
          deviceOptions.backgroundJobId = rpcOpts.backgroundJobId;
        }
        const caller = await opts.caller();
        const rawResult = await hub.deviceRpc(caller, method, effectiveParams, deviceOptions);
        // The actor has received the UserDO result at this point. A normal
        // supervisor result remains replayable until this separate durable ACK
        // succeeds; a reset between the two calls leaves the UserDO row and
        // local result intact for reconciliation.
        if (requestId !== undefined) {
          await hub.acknowledgeDeviceRequest(caller, requestId);
        }
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
