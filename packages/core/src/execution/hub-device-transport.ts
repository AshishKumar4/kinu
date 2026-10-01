/**
 * DeviceTransport over the user-level device hub (UserDO). `status()` is the last answer; `refreshStatus()`
 * awaits the hub.
 */
import { WORKSPACE_HAS_NO_OWNER, isDeviceAmbiguityError, isDeviceNotConnectedError, nextDeviceRequestId } from './device-tunnel';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { shellQuote } from '../utils/shell';
import { type DeviceCheckpointHint } from '../checkpoints/types';
import { sameDeviceStatus, type DeviceStatus } from './device-status';
import { type DeviceTransport } from './device-tunnel-executor';
import { Effect } from 'effect';
import { KinuError, deduped, diagnostics, renderThrownChain, settle, toKinuError, type LogEventName } from "../obs/index";
import * as v from 'valibot';
import { type UserCaller } from '../safety/workspace-capability';

/** A failed refresh is recorded, then tolerated: the last snapshot is kept. */
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
  onStatusChanged?: () => void;
}

export function createHubDeviceTransport(opts: HubDeviceTransportOpts): DeviceTransport {
  let snapshot: DeviceStatus = DISCONNECTED;
  let answered = false;

  const adopt = (next: DeviceStatus): void => {
    const moved = answered && !sameDeviceStatus(next, snapshot);
    answered = true;
    snapshot = next;

    if (moved) opts.onStatusChanged?.();
  };

  /** Authoritative hub check, one at a time. A failure keeps the last snapshot. */
  const refreshStatus = deduped(() => Effect.suspend(() => {
    const hub = opts.hub();

    if (!hub) {
      adopt(DISCONNECTED);

      return Effect.succeed(snapshot);
    }

    return Effect.tryPromise({
      try: async () => hub.deviceRuntimeStatus(await opts.caller()),
      catch: (cause) => toKinuError({ doing: 'refreshing the device status from the hub', cause, otherwise: 'unavailable' }),
    }).pipe(
      Effect.match({
        onSuccess: (status) => { adopt(status); },
        // Transient hub error: keep the last snapshot, record it.
        onFailure: (failure) => { diagnostics.failure(STATUS_RECHECK_FAILED, failure); },
      }),
      Effect.map(() => snapshot),
    );
  }));

  return {
    /** Never asks the hub: a read of the executors must not cost a cross-object call. */
    status: (): DeviceStatus => snapshot,
    refreshStatus,
    rpc: (method, params, rpcOpts) => settle(Effect.suspend(() => {
      const hub = opts.hub();

      if (!hub) {
        // A null hub means an unattached workspace, not an unlinked machine.
        adopt(DISCONNECTED);

        return Effect.die(new Error(WORKSPACE_HAS_NO_OWNER));
      }

      return Effect.tryPromise({
        try: async () => {
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
          adopt({ ...snapshot, connected: true, registered: true });

          return rawResult === undefined
            ? undefined
            : v.parse(JsonValueSchema, JSON.parse(rawResult));
        },
        catch: (cause) => ({ cause }),
      }).pipe(Effect.catch((failed) => {
        if (isDeviceNotConnectedError(failed)) adopt({ ...snapshot, connected: false });

        // Several machines live and none named: caller's error class, fixed before the executor's `io` wrap.
        return isDeviceAmbiguityError(failed)
          ? Effect.fail(new KinuError('bad_input', renderThrownChain(failed), { cause: failed.cause }))
          : Effect.die(failed.cause);
      }));
    })),
  };
}
