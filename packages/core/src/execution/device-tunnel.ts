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
import { nanoid } from '../utils/nanoid';

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
  /** The identity to issue this call under, from {@link nextDeviceRequestId}.
   *  Pass one when the caller may have to CANCEL the call: the daemon keys the
   *  command's process group on it, and it is the only handle a cancellation
   *  carries. Omitted lets the tunnel mint one for a call nobody has to reach
   *  again. */
  requestId?: string;
  /** Called only after the device supplied a terminal response frame. Timeout,
   *  socket loss and liveness failure do NOT call it: work may still be live. */
  onTerminal?: () => void;
}

interface Pending {
  resolve: (value: JsonValue | undefined) => void;
  reject: (err: Error) => void;
  /** Cancels whichever bound this call is riding — a work deadline or the
   *  liveness probe. */
  stop: () => void;
  /** Durable authority cleanup for a response the device actually sent. */
  onTerminal?: () => void;
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

/**
 * The frame the hub sends immediately after accepting a daemon socket, carrying
 * that device's NEXT long-lived token: `{ type: 'ROTATE', token }`.
 *
 * Rotation rides the socket rather than an HTTP response because this is the
 * one moment the machine has just proved possession of the current secret, and
 * a secret in a URL is a secret in a log. The daemon persists it over its own
 * `device.json` and answers {@link DEVICE_TOKEN_ROTATION_ACK}.
 */
export const DEVICE_TOKEN_ROTATION = 'ROTATE';

/**
 * The daemon's answer once the rotated token is on its disk:
 * `{ type: 'ROTATE_ACK' }`. The hub drops the superseded hash on this frame.
 *
 * Acknowledgement, not first use, is what ends the grace. The grace exists for
 * exactly one failure — a rotation lost with the socket, which would otherwise
 * brick the machine — and that failure is over the moment the machine says it
 * wrote the new secret. Ending it on "the next call that presents the current
 * token" instead left the superseded hash valid for however long the machine
 * stayed quiet, and a second holder of the old `device.json` could spend it.
 */
export const DEVICE_TOKEN_ROTATION_ACK = 'ROTATE_ACK';

/** Both the hub's "no socket" rejection and the tunnel's "socket dropped"
 *  rejection mean the same thing to callers: the device is not connected. */
export function isDeviceNotConnectedError<T>(err: T): boolean {
  const message = renderThrownChain({ cause: err });
  return message.includes(NO_DEVICE_CONNECTED) || message.includes(TUNNEL_DISCONNECTED);
}

/**
 * The classified code for "this machine cannot run a command under the tier it
 * was given". Both ends answer it: the hub refuses before the frame leaves,
 * and the daemon refuses again when its own probe disagrees with the frame.
 * Neither end ever downgrades a sandboxed command to an unconfined one.
 *
 * One spelling, matched on the way back the same way `NO_DEVICE_CONNECTED` is,
 * because a device error crosses an RPC boundary as its message.
 */
export const SANDBOX_UNAVAILABLE = 'sandbox_unavailable';

/** Whether a rejection is either end refusing to run a command unsandboxed. */
export function isSandboxUnavailableError<T>(err: T): boolean {
  return renderThrownChain({ cause: err }).includes(SANDBOX_UNAVAILABLE);
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

/**
 * The daemon method that TERMINATES one in-flight command, named by the request
 * identity it was issued under. It kills the command's whole process group, so
 * a stopped command takes the compiler, the test runner and the server it
 * backgrounded with it.
 *
 * Pinned against the daemon's own dispatch (`packages/pc-agent/src/index.js`),
 * which ships as one dependency-free file and cannot import this.
 */
export const DEVICE_CANCEL_METHOD = 'execCancel';

/** Cloud acceptance ACK for a durable exec result. The daemon retains normal
 * supervisor state until this arrives, so a socket/reset cannot lose replay. */
export const DEVICE_EXEC_ACK_METHOD = 'execAck';

/**
 * The daemon method that OPENS a terminal on the device, named by the session
 * the hub minted for it: `ptyOpen(session, cols, rows)`.
 *
 * Opening is a call and not a frame, because opening is the moment device
 * access is decided. It carries a request id, it answers once, and the hub
 * composes the same `sandbox` block onto it that it composes onto `exec` — so
 * a terminal is confined by the owner's own Sandbox switch, the agent home the
 * hub computed, and the folders they consented to. A session that skipped this
 * call would be a shell on the owner's machine with none of that.
 *
 * Pinned against the daemon's own dispatch (`packages/pc-agent/src/index.js`),
 * which ships dependency-free and cannot import this.
 */
export const DEVICE_PTY_OPEN_METHOD = 'ptyOpen';

/**
 * The session frames, which carry a session name and no request id.
 *
 * A terminal is the one thing on this socket that is not a correlated call:
 * bytes arrive from a program nobody asked, at a time nobody chose. So input,
 * a new window and a close go out as frames, and output and the exit status
 * come back as frames. Every one names a session the hub already opened, so
 * none of them can start work on the machine.
 *
 * `PTY_IN` and `PTY_OUT` carry base64 because this socket carries JSON and a
 * keystroke is bytes rather than text: an arrow key is three bytes that are
 * not a character.
 */
export const DEVICE_PTY_INPUT = 'PTY_IN';
export const DEVICE_PTY_RESIZE = 'PTY_RESIZE';
export const DEVICE_PTY_CLOSE = 'PTY_CLOSE';
export const DEVICE_PTY_OUTPUT = 'PTY_OUT';
export const DEVICE_PTY_EXIT = 'PTY_EXIT';

/** The frames a device sends about a live terminal. The hub reads these before
 *  the RPC correlator sees them: they have no id to correlate, and a
 *  correlator handed one would drop it without a word. */
export const DEVICE_PTY_FRAMES: readonly string[] = [DEVICE_PTY_OUTPUT, DEVICE_PTY_EXIT];

/** A window a terminal can actually have. The kernel carries each axis as an
 *  `unsigned short`, and a thousand cells on a side is past any real display,
 *  so the hub and the daemon both refuse anything larger. */
export const DEVICE_PTY_MAX_AXIS = 1000;

/**
 * The cancellation protocol this build speaks, sent as the second parameter of
 * every {@link DEVICE_CANCEL_METHOD} call.
 *
 * A mixed-version pair refuses in both directions rather than guessing: a
 * daemon too old to know the method answers {@link DEVICE_UNKNOWN_METHOD}, and
 * a daemon that knows the method but not this version answers
 * {@link DEVICE_CANCEL_VERSION_REFUSAL}. Silence is the one unacceptable
 * answer — the caller would report a command stopped that is still running.
 */
export const DEVICE_CANCEL_PROTOCOL = 1;

/** What a daemon says when the cancellation frame is one it cannot read.
 *  Pinned against the daemon's own wording for the reason above. */
export const DEVICE_CANCEL_VERSION_REFUSAL = 'unsupported cancellation protocol';

/**
 * What the daemon answers a cancellation with.
 *
 * `terminated` means the kernel confirmed the daemon-owned command process
 * group died. `unknown` means the daemon has no active control entry — the
 * shell may have finished, been cancelled, or never existed. Neither outcome
 * claims a backgrounded or deliberately re-sessioned process is gone. A kill
 * the kernel REFUSED is an error frame, never one of these.
 */
export const DeviceCancelResultSchema = v.object({
  requestId: v.string(),
  cancelled: v.picklist(['terminated', 'unknown']),
});
export type DeviceCancelResult = v.InferOutput<typeof DeviceCancelResultSchema>;

/** A cancellation answer that names a different command than the one asked
 *  about. The daemon echoes the id it acted on, so an answer naming anything
 *  else is a mispaired or dishonest far end. */
export const DEVICE_CANCEL_MISPAIRED = 'device answered a cancellation for another command';

/**
 * One cancellation answer, read as authority over ONE request.
 *
 * The echoed id is the whole reason the answer carries one: `terminated` is a
 * claim about a specific process group, and a frame naming another request
 * makes no claim about this one. Reading it as one would report a stopped
 * command whose processes are still running, which is the single thing this
 * protocol may never do. So every caller reads an answer through here instead
 * of checking the shape and trusting the verb.
 */
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

/** Refused because the id is already in flight. Two live calls on one id is
 *  the mispairing this refusal exists to make impossible. */
export const DEVICE_DUPLICATE_REQUEST = 'device RPC id is already in flight';

/**
 * This isolate's request-identity epoch, and the counter under it.
 *
 * Ids used to be the bare counter, and the counter is instance-local: a hub
 * that woke after eviction rebuilt its tunnel with the counter back at zero
 * while a timed-out command was still running on the machine, so that command's
 * late answer paired with a DIFFERENT pending call and one workspace's result
 * read as another's. The epoch is what a rebuilt counter cannot reproduce.
 */
// Workers reject CSPRNG calls during global module evaluation. The epoch is
// therefore minted by the first actual RPC in this isolate; a reset evaluates
// a fresh null slot and its first request receives a different epoch.
let requestEpoch: string | null = null;
let requestSeq = 0;

/**
 * One request identity: `rpc-<epoch>-<n>`, unique for the life of the machine
 * it is sent to.
 *
 * It is also the cancellation handle. The daemon registers each command's
 * process group under this exact string, so whoever issued a command can stop
 * it later with nothing to keep in step — there is no second identifier.
 */
export function nextDeviceRequestId(): string {
  if (requestEpoch === null) requestEpoch = nanoid(10);
  requestSeq += 1;
  return `rpc-${requestEpoch}-${requestSeq}`;
}

export class DeviceTunnel {
  private pending = new Map<string, Pending>();
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
   *
   * The identity is the CALLER's when it passed one (`opts.requestId`), because
   * a caller that may have to cancel this call needs to know the id before the
   * answer comes back. Either way it comes from `nextDeviceRequestId`, and an
   * id already in flight is refused rather than correlated twice.
   */
  rpc(method: string, params: JsonValue[], opts?: DeviceRpcOptions): Promise<JsonValue | undefined> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) { reject(new Error(TUNNEL_DISCONNECTED)); return; }
      const id = opts?.requestId ?? nextDeviceRequestId();
      if (this.pending.has(id)) { reject(new Error(`${DEVICE_DUPLICATE_REQUEST}: ${id}`)); return; }
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

  /**
   * Send a frame the device will not answer.
   *
   * A terminal's keystrokes, its new window and its close are not questions,
   * so they carry no request id and register nothing to correlate. Waiting for
   * a reply to a keystroke would put a round trip between a key and the letter
   * on the screen, which is the one thing a terminal may not do.
   *
   * Throws when the socket is gone, so a caller learns the frame went nowhere
   * rather than assuming it landed.
   */
  notify(frame: JsonObject): void {
    if (!this.isConnected()) throw new Error(TUNNEL_DISCONNECTED);
    this.socket.send(JSON.stringify(frame));
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
    try {
      p.onTerminal?.();
    } finally {
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
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
