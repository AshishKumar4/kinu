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

/** Minimal socket surface — platform WebSocket or any send()/readyState impl. */
export interface TunnelSocket {
  send(data: string): void;
  readyState: number;
}

/** WebSocket.OPEN is 1 across every implementation. */
const WS_OPEN = 1;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcResponse { id?: string; result?: unknown; error?: string }

export const TUNNEL_DISCONNECTED = 'device tunnel not connected';

/** Thrown by the user-level device hub (UserDO) when no device socket is
 *  live. Matchers in other packages key on this exact string — never reword
 *  the throw sites without it. */
export const NO_DEVICE_CONNECTED = 'no device connected';

/** Both the hub's "no socket" rejection and the tunnel's "socket dropped"
 *  rejection mean the same thing to callers: the device is not connected. */
export function isDeviceNotConnectedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(NO_DEVICE_CONNECTED) || message.includes(TUNNEL_DISCONNECTED);
}

export class DeviceTunnel {
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly socket: TunnelSocket,
    private readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ) {}

  isConnected(): boolean {
    return this.socket.readyState === WS_OPEN;
  }

  /** Issue a JSON-RPC call and await its correlated response. */
  rpc(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) { reject(new Error(TUNNEL_DISCONNECTED)); return; }
      const id = `rpc-${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`device RPC timeout after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Feed an incoming socket message; resolves/rejects the matching pending call.
   *  Ignores non-response frames (e.g. the daemon's HELLO). */
  handleMessage(raw: string): void {
    let msg: RpcResponse;
    try { msg = JSON.parse(raw) as RpcResponse; } catch { return; }
    if (typeof msg.id !== 'string') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  /** Reject all in-flight calls — called when the socket closes. */
  dispose(reason = TUNNEL_DISCONNECTED): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
