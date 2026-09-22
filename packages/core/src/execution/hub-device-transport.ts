/**
 * DeviceTransport over the user-level device hub (UserDO). `status()` is sync and serves a TTL cache
 * refreshed in the background; `refreshStatus()` awaits the hub and runs at turn start.
 */
import { WORKSPACE_HAS_NO_OWNER, isDeviceAmbiguityError, isDeviceNotConnectedError, nextDeviceRequestId } from './device-tunnel';
import type { Clock } from '../types/clock';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { shellQuote } from '../utils/shell';
import { type DeviceCheckpointHint } from '../checkpoints/types';
import { type DeviceStatus } from './device-status';
import { type DeviceTransport } from './device-tunnel-executor';
import { KinuError, diagnostics, renderThrownChain, toKinuError, type LogEventName } from "../obs/index";
import * as v from 'valibot';
import { type UserCaller } from '../safety/workspace-capability';

/** Runtime status cache freshness; independent of DEVICE_ROSTER_POLL_MS. */
const DEVICE_STATUS_TTL_MS = 5_000;

/** A background re-check failure is recorded, then tolerated: the stale snapshot is kept. */
const STATUS_RECHECK_FAILED: LogEventName = 'device.status_refresh_failed';

/** `toolchain: null` distinguishes "not asked" from "has no toolchain". */
const DISCONNECTED: DeviceStatus = { connected: false, registered: false, toolchain: null };

/** UserDO surface the transport needs. Both methods are attenuated, so both carry caller identity. */
export interface DeviceHubClient {
  /** Presence and toolchain; the hub asks the machine (a Worker has no PATH). */
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
  /** Canonical call id, so the caller can cancel by it. Minted by core's protocol authority. */
  requestId?: string;
  /** Durable job owning this call. Cloud-side only; never sent to the device. */
  backgroundJobId?: string;
  /** Target machine. Absent: hub answers a one-machine account and refuses several. */
  deviceId?: string;
}

export interface HubDeviceTransportOpts {
  hub(): DeviceHubClient | null;
  /** Workspace identity proof to the hub. Rejects without a capability token (fail-closed). */
  caller(): Promise<UserCaller>;
  agentName: string;
  cliCwd(): string | null;
  /** Turn identity for the daemon's pre-mutation shadow-git snapshot. Null outside turns. */
  checkpointMeta?: () => { turnId: string; sessionId: string } | null;
  clock: Clock;
}

interface StatusRefresh {
  promise: Promise<DeviceStatus> | null;
}

export function createHubDeviceTransport(opts: HubDeviceTransportOpts): DeviceTransport {
  let snapshot: DeviceStatus = DISCONNECTED;
  let checkedAt = 0;
  let inFlight: StatusRefresh | null = null;

  /** Authoritative hub check, deduped. Failure keeps the last snapshot; the slot is released only by its owner. */
  const beginStatusRefresh = (): StatusRefresh => {
    if (inFlight?.promise) return inFlight;
    const hub = opts.hub();

    if (!hub) {
      snapshot = DISCONNECTED;
      checkedAt = opts.clock.now();

      return { promise: Promise.resolve(snapshot) };
    }

    const owner: StatusRefresh = { promise: null };
    inFlight = owner;
    owner.promise = (async (): Promise<DeviceStatus> => {
      try {
        const status = await opts.caller().then((caller) => hub.deviceRuntimeStatus(caller));
        snapshot = status;
      } catch (cause) {
        // Transient hub error: keep the last snapshot, but record it.
        diagnostics.failure(STATUS_RECHECK_FAILED, toKinuError({
          doing: 'refreshing the device status from the hub',
          cause,
          otherwise: 'unavailable',
        }));
      } finally {
        checkedAt = opts.clock.now();

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
    /** Serves the cache and kicks a re-check when stale; the `inFlight` slot owns it and `refreshStatus` never rejects. */
    status: (): DeviceStatus => {
      if (!inFlight && opts.clock.now() - checkedAt >= DEVICE_STATUS_TTL_MS) beginStatusRefresh();

      return snapshot;
    },
    refreshStatus,
    rpc: async (method, params, rpcOpts) => {
      const hub = opts.hub();

      if (!hub) {
        // A null hub means an unattached workspace, not an unlinked machine.
        snapshot = DISCONNECTED;
        checkedAt = opts.clock.now();
        throw new Error(WORKSPACE_HAS_NO_OWNER);
      }

      try {
        const cwd = opts.cliCwd();
        const first = params.at(0);

        // Only a string first param is a command to prefix with `cd`.
        const effectiveParams: JsonValue[] = method === 'exec' && cwd && v.is(v.string(), first)
          ? [`cd ${shellQuote(cwd)} && ${first}`]
          : params;

        const meta = (method === 'exec' || method === 'writeFile') ? opts.checkpointMeta?.() ?? null : null;

        const checkpoint: DeviceCheckpointHint | undefined = meta ? {
          agent: opts.agentName,
          turnId: meta.turnId,
          sessionId: meta.sessionId,
          dir: method === 'exec' ? cwd : null,
        } : undefined;

        const requestId = method === 'exec' ? rpcOpts?.requestId ?? nextDeviceRequestId() : undefined;
        const deviceOptions: DeviceRpcOptions = { agentName: opts.agentName, checkpoint };

        if (rpcOpts?.deviceId !== undefined) deviceOptions.deviceId = rpcOpts.deviceId;

        if (rpcOpts?.timeoutMs !== undefined) deviceOptions.timeoutMs = rpcOpts.timeoutMs;

        if (requestId !== undefined) deviceOptions.requestId = requestId;

        if (rpcOpts?.backgroundJobId !== undefined) {
          deviceOptions.backgroundJobId = rpcOpts.backgroundJobId;
        }

        const caller = await opts.caller();
        const rawResult = await hub.deviceRpc(caller, method, effectiveParams, deviceOptions);

        // A supervisor result stays replayable until this separate durable ACK succeeds.
        if (requestId !== undefined) {
          await hub.acknowledgeDeviceRequest(caller, requestId);
        }

        // A successful call re-proves presence only; keep the toolchain answer.
        snapshot = { ...snapshot, connected: true, registered: true };
        checkedAt = opts.clock.now();

        return rawResult === undefined
          ? undefined
          : v.parse(JsonValueSchema, JSON.parse(rawResult));
      } catch (err) {
        if (isDeviceNotConnectedError({ cause: err })) {
          snapshot = { ...snapshot, connected: false };
          checkedAt = opts.clock.now();
        }

        // Several machines live and none named: caller's error class, fixed before the executor's `io` wrap.
        if (isDeviceAmbiguityError({ cause: err })) {
          throw new KinuError('bad_input', renderThrownChain({ cause: err }), { cause: err });
        }

        throw err;
      }
    },
  };
}
