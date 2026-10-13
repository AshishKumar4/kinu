/**
 * DeviceTransport over the user-level device hub (UserDO). `status()` is the last answer; `refreshStatus()`
 * awaits the hub.
 */
import {
  WORKSPACE_HAS_NO_OWNER, isDeviceAmbiguityError, isDeviceNotConnectedError, nextDeviceRequestId, type DeviceExecOutput,
} from './device-tunnel';
import { base64ToBytes } from '../utils/base64';
import type { OutputSink } from '../types/primitives';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { shellQuote } from '../utils/shell';
import { type DeviceCheckpointHint } from '../checkpoints/types';
import { sameDeviceStatus, type DeviceStatus } from './device-status';
import { type DeviceTransport } from './device-tunnel-executor';
import { Effect } from 'effect';
import { DEVICE_ERRORS, DEVICE_METHOD, deviceFailure } from './device-protocol';
import { KinuError, diagnostics, flight, renderThrownChain, settle, toKinuError, type LogEventName } from "../obs/index";
import * as v from 'valibot';
import { type UserCaller } from '../safety/workspace-capability';

/** A failed refresh is recorded, then tolerated: the last snapshot is kept. */
const STATUS_RECHECK_FAILED: LogEventName = 'device.status_refresh_failed';

/** No fleet known: before the hub answers, or with no hub to ask. */
const UNKNOWN: DeviceStatus = {};

/** The methods the daemon snapshots for undo before they change the machine; it reads the turn from their hint. */
const CHECKPOINTED: ReadonlySet<string> = new Set([DEVICE_METHOD.exec, DEVICE_METHOD.writeFile, DEVICE_METHOD.writeFileIfDigest]);

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
  /** The agent whose call this is: its Stop reaches the command, whichever turn ran it. */
  actorId?: string;
  checkpoint?: DeviceCheckpointHint;
  timeoutMs?: number;
  /** Canonical call id, so the caller can cancel by it. Minted by core's protocol authority. */
  requestId?: string;
  /** Durable job owning this call. Cloud-side only; never sent to the device. */
  backgroundJobId?: string;
  /** Target machine. Absent: hub answers a one-machine account and refuses several. */
  deviceId?: string;
  onOutput?: (output: DeviceExecOutput) => void;
}

function writeOutput(sink: OutputSink): (output: DeviceExecOutput) => void {
  return ({ chunks, dropped }) => {
    const unplaced = dropped - chunks.reduce((sum, { omitted = 0 }) => sum + omitted, 0);

    if (unplaced > 0) sink.lost(unplaced);

    for (const { stream, data, omitted = 0 } of chunks) {
      if (omitted > 0) sink.lost(omitted);
      sink.write(stream, base64ToBytes(data));
    }
  };
}

export interface HubDeviceTransportOpts {
  hub(): DeviceHubClient | null;
  /** Workspace identity proof to the hub. Rejects without a capability token (fail-closed). */
  caller(): Promise<UserCaller>;
  agentName: string;
  actorId: string;
  cliCwd(): string | null;
  /** Turn identity for the daemon's pre-mutation shadow-git snapshot. Null outside turns. */
  checkpointMeta?: () => { turnId: string; sessionId: string } | null;
  onStatusChanged?: () => void;
}

export function createHubDeviceTransport(opts: HubDeviceTransportOpts): DeviceTransport {
  let snapshot: DeviceStatus = UNKNOWN;
  let answered = false;

  const adopt = (next: DeviceStatus): void => {
    const moved = answered && !sameDeviceStatus(next, snapshot);
    answered = true;
    snapshot = next;

    if (moved) opts.onStatusChanged?.();
  };

  /** Authoritative hub check, one at a time. A failure keeps the last snapshot. */
  const refreshStatus = flight(() => Effect.suspend(() => {
    const hub = opts.hub();

    if (!hub) {
      adopt(UNKNOWN);

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

  /**
   * What a call's answer proves of presence. The machine it named, or the account's one machine, moves at once; any
   * other answer is the hub's to say (no fleet known, several machines and none named, a machine not listed), since the
   * hub chose the machine, so the fleet is read again.
   */
  const present = (connected: boolean, deviceId: string | undefined): Effect.Effect<void> => Effect.suspend(() => {
    const { devices } = snapshot;
    const named = deviceId ?? (devices?.length === 1 ? devices[0]?.id : undefined);

    if (devices === undefined || named === undefined || !devices.some((device) => device.id === named)) return Effect.asVoid(refreshStatus());
    adopt({ devices: devices.map((device) => (device.id === named ? { ...device, connected } : device)) });

    return Effect.void;
  });

  return {
    /** Never asks the hub: a read of the executors must not cost a cross-object call. */
    status: (): DeviceStatus => snapshot,
    refreshStatus: () => settle(refreshStatus()),
    rpc: (method, params, rpcOpts) => settle(Effect.suspend(() => {
      const hub = opts.hub();

      if (!hub) {
        // A null hub means an unattached workspace, not an unlinked machine.
        adopt(UNKNOWN);

        return Effect.fail(deviceFailure(DEVICE_ERRORS.noOwner, WORKSPACE_HAS_NO_OWNER));
      }

      return Effect.tryPromise({
        try: async () => {
          const cwd = opts.cliCwd();
          const first = params.at(0);

          // Only a string first param is a command to prefix with `cd`.
          const effectiveParams: JsonValue[] = method === DEVICE_METHOD.exec && cwd && v.is(v.string(), first)
            ? [`cd ${shellQuote(cwd)} && ${first}`]
            : params;

          const meta = CHECKPOINTED.has(method) ? opts.checkpointMeta?.() ?? null : null;

          const checkpoint: DeviceCheckpointHint | undefined = meta ? {
            agent: opts.agentName,
            turnId: meta.turnId,
            sessionId: meta.sessionId,
            dir: method === DEVICE_METHOD.exec ? cwd : null,
          } : undefined;

          const requestId = method === DEVICE_METHOD.exec ? rpcOpts?.requestId ?? nextDeviceRequestId() : undefined;
          const deviceOptions: DeviceRpcOptions = { agentName: opts.agentName, actorId: opts.actorId, checkpoint };

          if (rpcOpts?.deviceId !== undefined) deviceOptions.deviceId = rpcOpts.deviceId;

          if (rpcOpts?.timeoutMs !== undefined) deviceOptions.timeoutMs = rpcOpts.timeoutMs;

          if (requestId !== undefined) deviceOptions.requestId = requestId;

          if (rpcOpts?.backgroundJobId !== undefined) {
            deviceOptions.backgroundJobId = rpcOpts.backgroundJobId;
          }

          if (rpcOpts?.output !== undefined) deviceOptions.onOutput = writeOutput(rpcOpts.output);

          const caller = await opts.caller();
          const rawResult = await hub.deviceRpc(caller, method, effectiveParams, deviceOptions);

          // A supervisor result stays replayable until this separate durable ACK succeeds.
          if (requestId !== undefined) {
            await hub.acknowledgeDeviceRequest(caller, requestId);
          }

          return rawResult === undefined
            ? undefined
            : v.parse(JsonValueSchema, JSON.parse(rawResult));
        },
        catch: (cause) => ({ cause }),
      }).pipe(
        // A successful call re-proves presence only; keep the toolchain answer.
        Effect.tap(() => present(true, rpcOpts?.deviceId)),
        Effect.catch((failed) => Effect.andThen(
          isDeviceNotConnectedError(failed) ? present(false, rpcOpts?.deviceId) : Effect.void,
          // Several machines live and none named: caller's error class, fixed before the executor's `io` wrap.
          () => (isDeviceAmbiguityError(failed)
            ? Effect.fail(new KinuError('bad_input', renderThrownChain(failed), { cause: failed.cause }))
            : Effect.die(failed.cause)),
        )),
      );
    })),
  };
}
