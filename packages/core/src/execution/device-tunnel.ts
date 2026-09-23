// DeviceTunnel: JSON-RPC over one reverse-WebSocket to a user's device daemon,
// owned by the UserDO; agents reach it via a DO RPC forward.

import * as v from 'valibot';
import { JsonValueSchema, parseJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { renderThrownChain, tolerate } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { every, REAL_CLOCK, type Clock } from '../types/clock';

/** Minimal socket surface — platform WebSocket or any send()/readyState impl. */
export interface TunnelSocket {
  send(data: string): void;
  readyState: number;
}

/** WebSocket.OPEN is 1 across every implementation. */
const WS_OPEN = 1;

/** Deadline for control round-trips only; deadline-free work rides {@link LIVENESS_PROBE_MS}. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Heartbeat for deadline-free calls; covers half-open sockets that never close. */
const LIVENESS_PROBE_MS = 30_000;

/** The daemon answers any unknown method with an error frame, so any reply proves life. */
const LIVENESS_METHOD = 'ping';

/** Rejection for a deadline-free call whose device went silent on an open socket. */
export const DEVICE_UNRESPONSIVE = 'device stopped responding';

export interface DeviceRpcOptions {
  /** Extra fields on the frame beside id/method/params (e.g. `checkpoint`). */
  extra?: JsonObject;
  /** Pass 0 for arbitrary-length work: bounded only by device liveness. */
  timeoutMs?: number;
  /** Pass when the caller may need to cancel; the daemon keys the process group on it. */
  requestId?: string;
  /** Called only on a device-sent terminal frame; not on timeout/socket loss/liveness failure. */
  onTerminal?: () => void;
}

interface Pending {
  resolve: (value: JsonValue | undefined) => void;
  reject: (err: Error) => void;
  stop: () => void;
  onTerminal?: () => void;
}

const RpcResponseSchema = v.object({
  id: v.optional(v.string()),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});

export const TUNNEL_DISCONNECTED = 'device tunnel not connected';

/** Matchers in other packages key on this exact string. */
export const NO_DEVICE_CONNECTED = 'no device connected';

/** Unclaimed workspace: no hub to ask. Classified as not-connected, but reworded
 *  because "connect a device" is the wrong remedy. */
export const WORKSPACE_HAS_NO_OWNER =
  'this workspace has no owner account yet, so it can reach no machine';

/** Several devices live and the call named none; the throw site appends their names. */
export const SEVERAL_DEVICES_CONNECTED = 'several devices are connected and the call named none';

/** Hub → daemon frame `{ type: 'ROTATE', token }` carrying the device's next token. */
export const DEVICE_TOKEN_ROTATION = 'ROTATE';

/** Daemon ack once the rotated token is on disk; the hub drops the superseded hash on it. */
export const DEVICE_TOKEN_ROTATION_ACK = 'ROTATE_ACK';

export function isDeviceNotConnectedError(input: { cause: unknown }): boolean {
  const message = renderThrownChain(input);

  return message.includes(NO_DEVICE_CONNECTED)
    || message.includes(TUNNEL_DISCONNECTED)
    || message.includes(WORKSPACE_HAS_NO_OWNER);
}

export function isWorkspaceUnattachedError(input: { cause: unknown }): boolean {
  return renderThrownChain(input).includes(WORKSPACE_HAS_NO_OWNER);
}

export function isDeviceAmbiguityError(input: { cause: unknown }): boolean {
  return renderThrownChain(input).includes(SEVERAL_DEVICES_CONNECTED);
}

/** Either end refusing to run a command at its tier; never downgraded to unconfined. */
export const SANDBOX_UNAVAILABLE = 'sandbox_unavailable';

export function isSandboxUnavailableError(input: { cause: unknown }): boolean {
  return renderThrownChain(input).includes(SANDBOX_UNAVAILABLE);
}

/** Daemon prefix for unimplemented methods (`packages/pc-agent/src/index.js`). */
export const DEVICE_UNKNOWN_METHOD = 'unknown method';

export function isDeviceUnknownMethodError(input: { cause: unknown }): boolean {
  return renderThrownChain(input).includes(DEVICE_UNKNOWN_METHOD);
}

/** Kills one in-flight command's process group by request id. Pinned against `packages/pc-agent/src/index.js`. */
export const DEVICE_CANCEL_METHOD = 'execCancel';

/** The daemon retains supervisor state until this ack arrives. */
export const DEVICE_EXEC_ACK_METHOD = 'execAck';

/** Opens a device terminal; the hub composes the same `sandbox` block as for `exec`. */
export const DEVICE_PTY_OPEN_METHOD = 'ptyOpen';

/** Uncorrelated session frames; `PTY_IN`/`PTY_OUT` carry base64. */
export const DEVICE_PTY_INPUT = 'PTY_IN';

export const DEVICE_PTY_RESIZE = 'PTY_RESIZE';

export const DEVICE_PTY_CLOSE = 'PTY_CLOSE';

export const DEVICE_PTY_OUTPUT = 'PTY_OUT';

export const DEVICE_PTY_EXIT = 'PTY_EXIT';

/** Mirrored as `MAX_AXIS` in `packages/pc-agent/src/pty.js`; `packages/pc-agent/tests/pty.test.js` asserts they agree. */
export const DEVICE_PTY_MAX_AXIS = 1000;

/** Sent with every cancel; a mismatched daemon refuses rather than guessing. */
export const DEVICE_CANCEL_PROTOCOL = 1;

/** Pinned against the daemon's wording. */
export const DEVICE_CANCEL_VERSION_REFUSAL = 'unsupported cancellation protocol';

/** `terminated`: the kernel confirmed the process group died. `unknown`: no active entry. */
export const DeviceCancelResultSchema = v.object({
  requestId: v.string(),
  cancelled: v.picklist(['terminated', 'unknown']),
});

export type DeviceCancelResult = v.InferOutput<typeof DeviceCancelResultSchema>;

export const DEVICE_CANCEL_MISPAIRED = 'device answered a cancellation for another command';

/** A `terminated` naming another request id says nothing about this one; every caller reads through here. */
export function parseDeviceCancelAnswer(
  requestId: string, answer: JsonValue | undefined,
): DeviceCancelResult {
  const parsed = v.parse(DeviceCancelResultSchema, answer);

  if (parsed.requestId !== requestId) {
    throw new Error(
      `${DEVICE_CANCEL_MISPAIRED}: asked about ${requestId}, answered for ${parsed.requestId}`,
    );
  }

  return parsed;
}

export const DEVICE_DUPLICATE_REQUEST = 'device RPC id is already in flight';

// Epoch guards against a rebuilt counter pairing a late answer with a new call.
// Minted lazily: Workers reject CSPRNG calls during module evaluation.
let requestEpoch: string | null = null;

let requestSeq = 0;

/** `rpc-<epoch>-<n>`; also the cancellation handle the daemon keys on. */
export function nextDeviceRequestId(): string {
  requestEpoch ??= nanoid(10);
  requestSeq += 1;

  return `rpc-${requestEpoch}-${requestSeq}`;
}

export class DeviceTunnel {
  private readonly pending = new Map<string, Pending>();
  private readonly openEnded = new Set<string>();
  private heartbeat: (() => void) | null = null;
  /** Any frame counts. */
  private lastFrameAt = 0;
  /** 0 when no probe is outstanding. */
  private probeSentAt = 0;

  constructor(
    private readonly socket: TunnelSocket,
    private readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    private readonly probeMs: number = LIVENESS_PROBE_MS,
    // D19: tests advance the clock.
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  isConnected(): boolean {
    return this.socket.readyState === WS_OPEN;
  }

  /** A deadline-free call (`timeoutMs: 0`) is bounded only by device liveness. Duplicate in-flight ids are refused. */
  rpc(method: string, params: JsonValue[], opts?: DeviceRpcOptions): Promise<JsonValue | undefined> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error(TUNNEL_DISCONNECTED));

        return;
      }

      const id = opts?.requestId ?? nextDeviceRequestId();

      if (this.pending.has(id)) {
        reject(new Error(`${DEVICE_DUPLICATE_REQUEST}: ${id}`));

        return;
      }

      const deadline = opts?.timeoutMs ?? this.timeoutMs;

      const settle = (err: Error) => {
        const p = this.pending.get(id);

        if (!p) return;
        this.pending.delete(id);
        p.stop();
        reject(err);
      };

      let stop: () => void;

      if (deadline > 0) {
        stop = this.clock.after(deadline, () => settle(new Error(
          `device RPC timeout after ${deadline}ms: ${method} — the call may still be running on the device`,
        )));
      } else {
        this.openEnded.add(id);
        this.armHeartbeat();
        stop = () => { this.openEnded.delete(id); this.disarmIdleHeartbeat(); };
      }

      this.pending.set(id, { resolve, reject, stop, onTerminal: opts?.onTerminal });

      try {
        this.socket.send(JSON.stringify({ ...opts?.extra, id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        stop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send an uncorrelated frame; throws when the socket is gone. */
  notify(frame: JsonObject): void {
    if (!this.isConnected()) throw new Error(TUNNEL_DISCONNECTED);
    this.socket.send(JSON.stringify(frame));
  }

  /** Non-JSON frames are tolerated; any well-formed frame counts as liveness. */
  handleMessage(raw: string): void {
    const decoded = tolerate(() => parseJsonValue(raw), 'malformed-input');

    if (decoded === undefined) return;
    const parsed = v.safeParse(RpcResponseSchema, decoded);

    if (!parsed.success) return;
    const msg = parsed.output;
    this.lastFrameAt = this.clock.now();

    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);

    if (!p) return;
    this.pending.delete(msg.id);
    p.stop();

    try {
      p.onTerminal?.();
    } finally {
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  dispose(reason = TUNNEL_DISCONNECTED): void {
    for (const [, p] of this.pending) {
      p.stop();
      p.reject(new Error(reason));
    }

    this.pending.clear();
    this.openEnded.clear();
    this.disarmIdleHeartbeat();
  }

  private armHeartbeat(): void {
    if (this.heartbeat) return;
    this.probeSentAt = 0;
    this.heartbeat = every(this.clock, this.probeMs, () => this.probeLiveness());
  }

  private disarmIdleHeartbeat(): void {
    if (this.openEnded.size > 0 || !this.heartbeat) return;
    this.heartbeat();
    this.heartbeat = null;
    this.probeSentAt = 0;
  }

  /** Fails deadline-free calls when a probe got no frame of any kind before the next tick. */
  private probeLiveness(): void {
    if (this.openEnded.size === 0) {
      this.disarmIdleHeartbeat();

      return;
    }

    if (!this.isConnected()) {
      this.failOpenEnded(TUNNEL_DISCONNECTED);

      return;
    }

    if (this.probeSentAt > 0 && this.lastFrameAt < this.probeSentAt) {
      this.failOpenEnded(DEVICE_UNRESPONSIVE);

      return;
    }

    this.probeSentAt = this.clock.now();

    try {
      this.notify({ id: nextDeviceRequestId(), method: LIVENESS_METHOD, params: [] });
    } catch (cause) {
      this.failOpenEnded(TUNNEL_DISCONNECTED, { cause });
    }
  }

  private failOpenEnded(reason: string, options?: ErrorOptions): void {
    for (const id of this.openEnded) {
      const p = this.pending.get(id);

      if (!p) { this.openEnded.delete(id); continue; }

      this.pending.delete(id);
      p.stop();
      p.reject(new Error(`${reason}: the call was abandoned, and may still be running on the device`, options));
    }

    this.disarmIdleHeartbeat();
  }
}
