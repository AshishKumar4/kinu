// DeviceTunnel — JSON-RPC over a single reverse-WebSocket to a user's machine.
//
// The user's device daemon dials in and this side issues `{id,method,params}`
// requests, correlating `{id,result|error}` responses by id with a timeout.
// It owns ONE socket and lives where the socket is accepted — the UserDO (the
// user-level device hub). Agents reach it indirectly via a DO RPC forward, so
// one connected device serves all of a user's agents.
//
// Extracted from the old per-agent SSH executor so the wire logic has a single,
// unit-testable home shared by the connection owner (UserDO) regardless of which
// agent ultimately drives a command.

import * as v from 'valibot';
import { JsonValueSchema, parseJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { renderThrownChain, tolerate } from '../obs/index';

/** Minimal socket surface — platform WebSocket or any send()/readyState impl. */
export interface TunnelSocket {
  send(data: string): void;
  readyState: number;
}

/** WebSocket.OPEN is 1 across every implementation. */
const WS_OPEN = 1;

/**
 * Deadline for a CONTROL round-trip — a file read, a directory listing, an
 * existence check. Work the daemon answers immediately or not at all, so a
 * wall clock on it is a real signal.
 *
 * It is deliberately NOT the bound on `exec`. The same 30s used to apply to
 * every call, which meant any laptop command outliving half a minute — a
 * build, a test suite, an install — failed as `device RPC timeout`, a message
 * indistinguishable from a dead device. Liveness had been welded onto the work
 * budget. A call with no deadline of its own now rides {@link LIVENESS_PROBE_MS}
 * instead: it fails when the DEVICE stops being there, not when the work takes
 * a while, and says which of the two happened.
 */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * How often a deadline-free call checks that the device is still there.
 *
 * Liveness, not a work budget: the question is whether the DEVICE is alive,
 * which is answered by the device speaking, not by the work finishing. A
 * socket close already rejects in-flight calls; this covers the half-open
 * case where no close event ever arrives.
 */
const LIVENESS_PROBE_MS = 30_000;

/** The heartbeat's probe method. The daemon answers ANY unrecognized method
 *  with an error frame, so a frame coming back is proof of life and this needs
 *  no daemon-side protocol support (and no version negotiation with the
 *  already-installed `pc-agent`). */
const LIVENESS_METHOD = 'ping';

/** What a deadline-free call rejects with when the device stopped answering
 *  while its socket was still nominally open. Distinct from a work timeout:
 *  nothing about the work is being judged here. */
export const DEVICE_UNRESPONSIVE = 'device stopped responding';

/** Per-call options. */
export interface DeviceRpcOptions {
  /** Extra fields riding on the frame next to id/method/params (e.g. the
   *  pre-mutation `checkpoint` hint the daemon acts on before executing). */
  extra?: JsonObject;
  /** Wall clock for THIS call. Pass 0 for arbitrary-length work — the call
   *  then ends only when the device answers, the caller aborts, or the device
   *  goes away. Defaults to the tunnel's control-RPC deadline. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: JsonValue | undefined) => void;
  reject: (err: Error) => void;
  /** Cancels whichever bound this call is riding — a work deadline or the
   *  liveness probe. */
  stop: () => void;
}

const RpcResponseSchema = v.object({
  id: v.optional(v.string()),
  result: v.optional(JsonValueSchema),
  error: v.optional(v.string()),
});

export const TUNNEL_DISCONNECTED = 'device tunnel not connected';

/** Thrown by the user-level device hub (UserDO) when no device socket is
 *  live. Matchers in other packages key on this exact string — never reword
 *  the throw sites without it. */
export const NO_DEVICE_CONNECTED = 'no device connected';

/** Both the hub's "no socket" rejection and the tunnel's "socket dropped"
 *  rejection mean the same thing to callers: the device is not connected. */
export function isDeviceNotConnectedError<T>(err: T): boolean {
  const message = renderThrownChain({ cause: err });
  return message.includes(NO_DEVICE_CONNECTED) || message.includes(TUNNEL_DISCONNECTED);
}

/**
 * The prefix the daemon answers for a method it does not implement
 * (`packages/pc-agent/src/index.js`: `'unknown method: ' + method`).
 *
 * Load-bearing for any OPTIONAL method: an install too old to know it is not a
 * failed call, and for the toolchain probe the difference is the difference
 * between "this machine has no python" and "nobody could ask". Pinned against
 * the daemon's own source in cf-backend's device-hub test, since the daemon
 * ships as one dependency-free file and cannot import this.
 */
export const DEVICE_UNKNOWN_METHOD = 'unknown method';

/** Whether a rejection is the daemon saying it has never heard of the method. */
export function isDeviceUnknownMethodError<T>(err: T): boolean {
  return (renderThrownChain({ cause: err })).includes(DEVICE_UNKNOWN_METHOD);
}

export class DeviceTunnel {
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** Calls running with no work deadline — the set the heartbeat guards. */
  private readonly openEnded = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** When the device last said anything at all. Any frame counts. */
  private lastFrameAt = 0;
  /** When the last unanswered liveness probe went out, or 0 for none. */
  private probeSentAt = 0;

  constructor(
    private readonly socket: TunnelSocket,
    private readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    /** Heartbeat cadence for deadline-free calls. */
    private readonly probeMs: number = LIVENESS_PROBE_MS,
  ) {}

  isConnected(): boolean {
    return this.socket.readyState === WS_OPEN;
  }

  /**
   * Issue a JSON-RPC call and await its correlated response.
   *
   * Two different bounds, never conflated. A call with a deadline
   * (`timeoutMs > 0`, the default for control round-trips) fails when the
   * deadline passes and SAYS the work may still be running on the device. A
   * call with `timeoutMs: 0` — arbitrary user work — is bounded only by the
   * device still being there: a socket close rejects it at once, and the
   * heartbeat catches the half-open case at the next probe. Either way the
   * message names the device, not a deadline the work never actually hit.
   */
  rpc(method: string, params: JsonValue[], opts?: DeviceRpcOptions): Promise<JsonValue | undefined> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) { reject(new Error(TUNNEL_DISCONNECTED)); return; }
      const id = `rpc-${++this.seq}`;
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
        const timer = setTimeout(() => settle(new Error(
          `device RPC timeout after ${deadline}ms: ${method} — the call may still be running on the device`,
        )), deadline);
        stop = () => clearTimeout(timer);
      } else {
        // No work deadline: the shared heartbeat guards this call instead, so
        // it ends when the DEVICE goes away rather than when the work gets long.
        this.openEnded.add(id);
        this.armHeartbeat();
        stop = () => { this.openEnded.delete(id); this.disarmIdleHeartbeat(); };
      }
      this.pending.set(id, { resolve, reject, stop });
      try {
        this.socket.send(JSON.stringify({ ...opts?.extra, id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        stop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Feed an incoming socket message; resolves/rejects the matching pending call.
   *  Ignores non-response frames (e.g. the daemon's HELLO).
   *
   *  A frame that is not JSON at all is the ONE failure this boundary accepts —
   *  the socket carries whatever the device wrote, not a validated protocol.
   *  Naming it means anything else still reaches the socket's error handler
   *  instead of looking like a frame that simply did not correlate. */
  handleMessage(raw: string): void {
    const decoded = tolerate(() => parseJsonValue(raw), 'malformed-input');
    if (decoded === undefined) return;
    const parsed = v.safeParse(RpcResponseSchema, decoded);
    if (!parsed.success) return;
    const msg = parsed.output;
    // Any well-formed frame — a result, an error, the daemon's HELLO — is the
    // device speaking, which is the only thing liveness actually asks about.
    this.lastFrameAt = Date.now();
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    p.stop();
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  /** Reject all in-flight calls — called when the socket closes. */
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
    this.heartbeat = setInterval(() => this.probeLiveness(), this.probeMs);
  }

  private disarmIdleHeartbeat(): void {
    if (this.openEnded.size > 0 || !this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.probeSentAt = 0;
  }

  /**
   * One heartbeat tick, guarding every deadline-free call at once.
   *
   * A probe outstanding since the previous tick with no frame of any kind
   * since it went out is the failure this exists for: the socket still reads
   * OPEN, and the device is gone. Everything else is proof of life — including
   * an error frame, since a daemon that can refuse a call is a daemon that is
   * running.
   */
  private probeLiveness(): void {
    if (this.openEnded.size === 0) { this.disarmIdleHeartbeat(); return; }
    if (!this.isConnected()) { this.failOpenEnded(TUNNEL_DISCONNECTED); return; }
    if (this.probeSentAt > 0 && this.lastFrameAt < this.probeSentAt) {
      this.failOpenEnded(DEVICE_UNRESPONSIVE);
      return;
    }
    this.probeSentAt = Date.now();
    // Fire-and-forget: the answer is irrelevant, its ARRIVAL is the signal,
    // and handleMessage records that for any frame. A rejection is not itself
    // proof of death — an error frame rejects the call and PROVES life, already
    // recorded above — so the socket is asked directly, the same readyState
    // question `isConnected` already owns. A probe that outlives the connection
    // now ends the calls it was guarding here rather than a tick later.
    void this.rpc(LIVENESS_METHOD, []).catch(() => {
      if (!this.isConnected()) this.failOpenEnded(TUNNEL_DISCONNECTED);
    });
  }

  private failOpenEnded(reason: string): void {
    for (const id of this.openEnded) {
      const p = this.pending.get(id);
      if (!p) { this.openEnded.delete(id); continue; }
      this.pending.delete(id);
      p.stop();
      p.reject(new Error(`${reason}: the call was abandoned, and may still be running on the device`));
    }
    this.disarmIdleHeartbeat();
  }
}
