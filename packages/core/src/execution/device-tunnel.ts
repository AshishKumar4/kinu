// JSON-RPC over the device's one reverse WebSocket.
import * as v from 'valibot';
import { Effect } from 'effect';
import { JsonValueSchema, parseJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { carriesCauseCode, KinuError, toKinuError } from '../obs/error';
import { detach, diagnostics, logged } from '../obs/log';
import { settle, settleSync, tolerate } from '../obs/effect';
import { nanoid } from '../utils/nanoid';
import { every, REAL_CLOCK, type Clock } from '../types/clock';
import { DEVICE_METHOD, DEVICE_FRAMES, DEVICE_ERRORS, deviceFailure } from './device-protocol';

export interface TunnelSocket {
  send(data: string): void;
  readyState: number;
}

const WS_OPEN = 1;

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

const LIVENESS_PROBE_MS = 30_000;

export interface DeviceRpcOptions {
  extra?: JsonObject;
  /** Zero: no work deadline; device silence still ends the call. */
  timeoutMs?: number;
  requestId?: string;
  onTerminal?: () => void;
  onOutput?: (output: DeviceExecOutput) => void;
}

/** What a device call hands the tunnel for its output: nothing unless someone watches, and a loss is logged, never thrown. */
export function watchedOutput(opts: { readonly onOutput?: (output: DeviceExecOutput) => void | Promise<void> } | undefined): Pick<DeviceRpcOptions, 'onOutput'> {
  const onOutput = opts?.onOutput;

  if (onOutput === undefined) return {};

  // The delivery settles on its own: a lost one is logged and never reaches the tunnel's frame handler.
  return {
    onOutput: (output: DeviceExecOutput) => {
      detach(logged('device.output_unsent', {
        doing: "handing a running command's output to its workspace", otherwise: 'unavailable',
      }, async () => { await onOutput(output); }));
    },
  };
}

interface Pending {
  complete: (answer: Effect.Effect<JsonValue | undefined, KinuError>) => void;
  stop: () => void;
  onTerminal?: () => void;
  onOutput?: (output: DeviceExecOutput) => void;
}

const RpcResponseSchema = v.union([
  v.strictObject({ id: v.string(), result: JsonValueSchema }),
  v.strictObject({ id: v.string(), error: v.object({ code: v.string(), message: v.string() }) }),
]);

const ExecOutputFrameSchema = v.object({
  type: v.literal(DEVICE_FRAMES.execOutput),
  request: v.string(),
  chunks: v.array(v.object({ stream: v.picklist(['stdout', 'stderr']), data: v.string(), omitted: v.optional(v.number()) })),
  dropped: v.number(),
});

export type DeviceExecOutput = Omit<v.InferOutput<typeof ExecOutputFrameSchema>, 'type' | 'request'>;

export const TUNNEL_DISCONNECTED = 'device tunnel not connected';

export const NO_DEVICE_CONNECTED = 'no device connected';

export const WORKSPACE_HAS_NO_OWNER = 'this workspace has no owner account yet, so it can reach no machine';

export const SEVERAL_DEVICES_CONNECTED = 'several devices are connected and the call named none';

const DEVICE_UNRESPONSIVE = 'device stopped responding';

export const DEVICE_TOKEN_ROTATION = DEVICE_FRAMES.rotate;

export const DEVICE_TOKEN_ROTATION_ACK = DEVICE_FRAMES.rotated;

export const SANDBOX_UNAVAILABLE = DEVICE_ERRORS.sandboxUnavailable;

export const DEVICE_UNKNOWN_METHOD = DEVICE_ERRORS.unknownMethod;

export const DEVICE_CANCEL_METHOD = DEVICE_METHOD.cancel;

export const DEVICE_EXEC_ACK_METHOD = DEVICE_METHOD.execAck;

export const DEVICE_PTY_OPEN_METHOD = DEVICE_METHOD.ptyOpen;

export const DEVICE_PTY_INPUT = DEVICE_FRAMES.ptyInput;

export const DEVICE_PTY_RESIZE = DEVICE_FRAMES.ptyResize;

export const DEVICE_PTY_OUTPUT = DEVICE_FRAMES.ptyOutput;

export const DEVICE_PTY_EXIT = DEVICE_FRAMES.ptyExit;

export const DEVICE_PTY_MAX_AXIS = 1000;

export const DEVICE_CANCEL_MISPAIRED = 'device answered a cancellation for another command';

export const DEVICE_DUPLICATE_REQUEST = 'device RPC id is already in flight';

export function isDeviceNotConnectedError(input: { cause: unknown }): boolean {
  return carriesCauseCode(input, DEVICE_ERRORS.disconnected, DEVICE_ERRORS.noOwner);
}

export function isWorkspaceUnattachedError(input: { cause: unknown }): boolean {
  return carriesCauseCode(input, DEVICE_ERRORS.noOwner);
}

export function isDeviceAmbiguityError(input: { cause: unknown }): boolean {
  return carriesCauseCode(input, DEVICE_ERRORS.ambiguous);
}

export function isSandboxUnavailableError(input: { cause: unknown }): boolean {
  return carriesCauseCode(input, DEVICE_ERRORS.sandboxUnavailable);
}

export const DeviceCancelResultSchema = v.object({
  requestId: v.string(),
  cancelled: v.picklist(['terminated', 'unknown']),
});

export type DeviceCancelResult = v.InferOutput<typeof DeviceCancelResultSchema>;

export function parseDeviceCancelAnswer(requestId: string, answer: JsonValue | undefined): DeviceCancelResult {
  return settleSync(Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => v.parse(DeviceCancelResultSchema, answer),
      catch: (cause) => new KinuError('io', 'device returned an unreadable cancellation answer', { cause }),
    });

    if (parsed.requestId !== requestId) {
      return yield* Effect.fail(new KinuError('io', `${DEVICE_CANCEL_MISPAIRED}: asked about ${requestId}, answered for ${parsed.requestId}`));
    }

    return parsed;
  }));
}

// Minted lazily: Workers reject CSPRNG calls during module evaluation.
let requestEpoch: string | null = null;

let requestSeq = 0;

export function nextDeviceRequestId(): string {
  requestEpoch ??= nanoid(10);
  requestSeq += 1;

  return `rpc-${requestEpoch}-${requestSeq}`;
}

function sendFrame(socket: TunnelSocket, frame: JsonObject): Effect.Effect<void, KinuError> {
  if (socket.readyState !== WS_OPEN) return Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, TUNNEL_DISCONNECTED));

  return Effect.try({
    try: () => socket.send(JSON.stringify(frame)),
    catch: (cause) => deviceFailure(DEVICE_ERRORS.disconnected, TUNNEL_DISCONNECTED, { cause }),
  });
}

export class DeviceTunnel {
  private readonly pending = new Map<string, Pending>();
  private readonly openEnded = new Set<string>();
  private heartbeat: (() => void) | null = null;
  private lastAnswerAt = 0;
  private probe: { id: string; sentAt: number } | null = null;

  constructor(
    private readonly socket: TunnelSocket,
    private readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    private readonly probeMs: number = LIVENESS_PROBE_MS,
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  isConnected(): boolean {
    return this.socket.readyState === WS_OPEN;
  }

  rpc(method: string, params: JsonValue[], opts?: DeviceRpcOptions): Promise<JsonValue | undefined> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!this.isConnected()) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, TUNNEL_DISCONNECTED));
      const id = opts?.requestId ?? nextDeviceRequestId();

      if (this.pending.has(id)) return yield* Effect.fail(new KinuError('bad_input', `${DEVICE_DUPLICATE_REQUEST}: ${id}`));
      const answer = Promise.withResolvers<Effect.Effect<JsonValue | undefined, KinuError>>();
      const deadline = opts?.timeoutMs ?? this.timeoutMs;

      const stop = deadline > 0
        ? this.clock.after(deadline, () => {
          this.finish(id, Effect.fail(new KinuError('timeout', `device RPC timeout after ${deadline}ms: ${method}: the call may still be running on the device`)));
        })
        : () => { this.openEnded.delete(id); this.disarmIdleHeartbeat(); };

      this.pending.set(id, { complete: answer.resolve, stop, onTerminal: opts?.onTerminal, onOutput: opts?.onOutput });

      if (deadline === 0) {
        this.openEnded.add(id);
        this.armHeartbeat();
      }

      return yield* Effect.gen({ self: this }, function* () {
        yield* sendFrame(this.socket, {
          ...opts?.extra, ...(opts?.onOutput !== undefined && { output: true }), id, method, params,
        });
        const ended = yield* Effect.promise(() => answer.promise);

        return yield* ended;
      }).pipe(Effect.ensuring(Effect.sync(() => {
        if (this.pending.get(id)?.complete === answer.resolve) this.pending.delete(id);
        stop();
      })));
    }));
  }

  cancel(requestId: string): Promise<DeviceCancelResult | null> {
    return settle(Effect.flatMap(
      Effect.tryPromise({
        try: () => this.rpc(DEVICE_METHOD.cancel, [requestId]),
        catch: (cause) => toKinuError({ doing: 'cancel device work', cause, otherwise: 'unavailable' }),
      }),
      (answer) => Effect.try({
        try: () => parseDeviceCancelAnswer(requestId, answer),
        catch: (cause) => toKinuError({ doing: 'read device cancellation', cause, otherwise: 'io' }),
      }),
    ).pipe(Effect.match({
      onSuccess: (answer) => {
        diagnostics.event('device.work_cancelled', { outcome: answer.cancelled });

        return answer;
      },
      onFailure: (failure) => {
        diagnostics.failure('device.work_cancel_failed', failure);

        return null;
      },
    })));
  }

  notify(frame: JsonObject): void {
    return settleSync(sendFrame(this.socket, frame));
  }

  handleMessage(raw: string): void {
    const decoded = tolerate(() => parseJsonValue(raw), 'malformed-input');

    if (decoded === undefined) return this.dropped('malformed');
    const output = v.safeParse(ExecOutputFrameSchema, decoded);

    if (output.success) {
      const { request, chunks, dropped } = output.output;
      const pending = this.pending.get(request);

      if (!pending?.onOutput) return this.dropped('unclaimed_output');
      this.lastAnswerAt = this.clock.now();
      pending.onOutput({ chunks, dropped });

      return;
    }

    const parsed = v.safeParse(RpcResponseSchema, decoded);

    if (!parsed.success) return this.dropped('invalid_response');
    const msg = parsed.output;

    if (msg.id === this.probe?.id) {
      if ('error' in msg || msg.result !== DEVICE_FRAMES.pong) return this.dropped('invalid_ping_answer');
      this.lastAnswerAt = this.clock.now();
      this.probe = null;

      return;
    }

    const pending = this.pending.get(msg.id);

    if (!pending) return this.dropped('unknown_request');
    this.lastAnswerAt = this.clock.now();

    const result = 'error' in msg
      ? Effect.fail(deviceFailure(msg.error.code, msg.error.message))
      : Effect.succeed(msg.result);

    return settleSync(Effect.try({
      try: () => pending.onTerminal?.(),
      catch: (cause) => toKinuError({ doing: 'record device completion', cause, otherwise: 'io' }),
    }).pipe(Effect.ensuring(Effect.sync(() => this.finish(msg.id, result)))));
  }

  dispose(reason = TUNNEL_DISCONNECTED): void {
    for (const id of this.pending.keys()) this.finish(id, Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, reason)));
    this.disarmIdleHeartbeat();
  }

  private finish(id: string, answer: Effect.Effect<JsonValue | undefined, KinuError>): void {
    const pending = this.pending.get(id);

    if (!pending) return;
    this.pending.delete(id);
    pending.stop();
    pending.complete(answer);
  }

  private dropped(reason: string): void {
    diagnostics.event('device.rpc_frame_dropped', { reason });
  }

  private armHeartbeat(): void {
    if (this.heartbeat) return;
    this.probe = null;
    this.heartbeat = every(this.clock, this.probeMs, () => detach(this.heartbeatTick()));
  }

  private disarmIdleHeartbeat(): void {
    if (this.openEnded.size > 0 || !this.heartbeat) return;
    this.heartbeat();
    this.heartbeat = null;
    this.probe = null;
  }

  private heartbeatTick(): Effect.Effect<void> {
    if (this.openEnded.size === 0) return Effect.sync(() => this.disarmIdleHeartbeat());

    if (!this.isConnected()) return this.failOpenEnded(DEVICE_ERRORS.disconnected, TUNNEL_DISCONNECTED);

    if (this.probe !== null && this.lastAnswerAt < this.probe.sentAt) {
      return this.failOpenEnded(DEVICE_ERRORS.unresponsive, DEVICE_UNRESPONSIVE);
    }

    this.probe = { id: nextDeviceRequestId(), sentAt: this.clock.now() };
    const frame = { id: this.probe.id, method: DEVICE_METHOD.ping, params: [] };

    return sendFrame(this.socket, frame).pipe(Effect.catch((failure) =>
      this.failOpenEnded(DEVICE_ERRORS.disconnected, TUNNEL_DISCONNECTED, { cause: failure.cause })));
  }

  private failOpenEnded(code: string, message: string, input?: { cause: unknown }): Effect.Effect<void> {
    return Effect.suspend(() => {
      const ending: Effect.Effect<void>[] = [];

      for (const id of this.openEnded) {
        const pending = this.pending.get(id);

        if (!pending) continue;
        this.pending.delete(id);
        pending.stop();

        const failed = (answer: DeviceCancelResult | null) => pending.complete(Effect.fail(deviceFailure(code,
          answer?.cancelled === 'terminated' ? `${message}: the device confirmed its work stopped`
            : `${message}: the call may still be running on the device; its stop was not confirmed`, input)));

        if (this.isConnected()) ending.push(Effect.map(Effect.promise(() => this.cancel(id)), failed));
        else failed(null);
      }

      this.disarmIdleHeartbeat();

      return Effect.asVoid(Effect.all(ending, { concurrency: 'unbounded' }));
    });
  }
}
