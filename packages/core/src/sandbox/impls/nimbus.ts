/**
 * NimbusSandbox — WebSocket client for github.com/AshishKumar4/Nimbus.
 *
 * Nimbus is a Cloudflare-hosted Linux-like environment per Durable Object:
 *   • Full bash + 60+ POSIX commands
 *   • Native Node/Bun (via workerd), Python (Pyodide), Ruby (ruby.wasm), C→wasm32-wasi
 *   • 10 GB SQLite-backed VFS per session
 *   • Sub-500ms cold starts, $0 idle (DO hibernation)
 *
 * Public surface (per research/RESEARCH_NOTES.md §C):
 *   • POST /new → 302 → /s/{sessionId}/
 *   • ws://{endpoint}/s/{sessionId}/ws
 *     ─ terminal: {type:"input"|"resize", ...} → {type:"output", data}
 *     ─ filesystem: {type:"fs-read"|"fs-write"|"fs-list", reqId, ...}
 *                   → {type:"fs-*-result", reqId, ok, ...}
 *   • Auth: HS256 JWT via ?nimbus_token=<jwt>
 *
 * Shell exec strategy:
 *   The terminal protocol doesn't return structured exit codes. We wrap each
 *   command with a sentinel:
 *     <user_cmd>; printf '\n__NIMBUS_DONE_<rid>_%s\n' $?
 *   and consume `output` chunks until the sentinel matches.
 */

import type {
  SandboxApi, SandboxCapability, DirEntry, Stat, ShellResult, ExecOptions, PortInfo,
} from '../types.js';
import { SandboxError } from '../types.js';

export interface NimbusSandboxOpts {
  /** Stable id (becomes the sandbox.id; also used as Nimbus sessionId if provided). */
  id: string;
  /** Nimbus endpoint, e.g. "https://nimbus.example.workers.dev". No trailing slash. */
  endpoint: string;
  /** HS256 JWT issued via Nimbus's issueNimbusToken(). Required when Nimbus runs in 'enforce' mode. */
  token?: string;
  /**
   * If provided, attach to an existing session. If omitted, the sandbox calls
   * POST /new on first connect() and remembers the sessionId.
   */
  sessionId?: string;
  /**
   * Override the WebSocket constructor (used for tests + Node compatibility).
   * In Cloudflare Workers, we use fetch() with Upgrade header instead.
   */
  webSocketImpl?: typeof WebSocket;
  /** Maximum wall-clock for any single exec, in milliseconds. */
  execTimeoutMs?: number;
}

/** A pending FS RPC waiting on `reqId` correlation. */
interface PendingFsOp {
  resolve: (value: NimbusFsResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** A pending shell exec waiting on its sentinel. */
interface PendingExec {
  sentinel: string;
  buffer: string;
  resolve: (result: ShellResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
}

interface NimbusFsResult {
  type: 'fs-read-result' | 'fs-write-result' | 'fs-list-result';
  reqId: string | number;
  ok: boolean;
  error?: string;
  content?: string;
  files?: Array<{ name: string; isDir: boolean; size?: number }>;
}

export function createNimbusSandbox(opts: NimbusSandboxOpts): SandboxApi {
  const {
    id,
    endpoint,
    token,
    webSocketImpl,
    execTimeoutMs = 60_000,
  } = opts;
  let sessionId = opts.sessionId ?? id;

  const capabilities = new Set<SandboxCapability>([
    'shell', 'native_binary',
    'process_spawn', 'process_signal',
    'fs_persistent', 'fs_shared',
    'net_outbound',
  ]);

  let ws: WebSocket | null = null;
  let connecting: Promise<void> | null = null;
  let reqSeq = 0;
  const pendingFs = new Map<string | number, PendingFsOp>();
  const pendingExecs: PendingExec[] = [];

  function nextReqId(): string {
    return `r${++reqSeq}_${Date.now().toString(36)}`;
  }

  function buildWsUrl(sessId: string): string {
    const httpUrl = new URL(`/s/${encodeURIComponent(sessId)}/ws`, endpoint);
    const wsScheme = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    httpUrl.protocol = wsScheme;
    if (token) httpUrl.searchParams.set('nimbus_token', token);
    return httpUrl.toString();
  }

  async function createSession(): Promise<string> {
    // POST /new returns a 302 to /s/{id}/. We need to capture that id.
    const url = new URL('/new', endpoint).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'manual',
    });
    // Some Nimbus deployments respond 302; others 200 with a JSON body.
    if (res.status === 302 || res.status === 303 || res.status === 307) {
      const loc = res.headers.get('location');
      const m = loc?.match(/\/s\/([^/?]+)/);
      if (m) return m[1];
    }
    if (res.ok) {
      try {
        const body = await res.json() as { sessionId?: string; id?: string };
        if (body.sessionId) return body.sessionId;
        if (body.id) return body.id;
      } catch { /* fall through */ }
    }
    throw new SandboxError(
      `Failed to create Nimbus session (status ${res.status})`,
      res.status === 401 || res.status === 403 ? 'auth' : 'protocol',
    );
  }

  function onMessage(raw: string): void {
    let msg: { type?: string; reqId?: string | number; data?: string; ok?: boolean; error?: string; content?: string; files?: NimbusFsResult['files'] };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg.type) return;

    // FS RPC responses
    if (msg.type === 'fs-read-result' || msg.type === 'fs-write-result' || msg.type === 'fs-list-result') {
      const reqId = msg.reqId;
      if (reqId == null) return;
      const pending = pendingFs.get(reqId);
      if (!pending) return;
      pendingFs.delete(reqId);
      clearTimeout(pending.timeout);
      pending.resolve(msg as unknown as NimbusFsResult);
      return;
    }

    // Terminal output — pipe through to all in-flight exec listeners.
    if (msg.type === 'output' && typeof msg.data === 'string') {
      for (const ex of pendingExecs) {
        ex.buffer += msg.data;
        const sentinelIdx = ex.buffer.indexOf(ex.sentinel);
        if (sentinelIdx === -1) continue;
        // Sentinel format: "__NIMBUS_DONE_<rid>_<exit>\n"
        const rest = ex.buffer.slice(sentinelIdx + ex.sentinel.length);
        const m = rest.match(/^(\d+)/);
        const exitCode = m ? Number(m[1]) : 0;
        // Capture stdout (everything before sentinel) and a trailing newline-trimmed slice.
        const stdout = ex.buffer.slice(0, sentinelIdx).replace(/\r/g, '');
        clearTimeout(ex.timeout);
        const idx = pendingExecs.indexOf(ex);
        if (idx >= 0) pendingExecs.splice(idx, 1);
        ex.resolve({
          stdout,
          stderr: '', // Nimbus interleaves stdout/stderr in the terminal; we can't separate them cleanly here
          exitCode,
          durationMs: Date.now() - ex.startedAt,
        });
      }
    }
  }

  async function ensureConnected(): Promise<void> {
    if (ws && ws.readyState === 1 /* OPEN */) return;
    if (connecting) return connecting;
    connecting = (async () => {
      if (!sessionId) {
        sessionId = await createSession();
      }
      const url = buildWsUrl(sessionId);
      const Ctor = webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;

      if (Ctor) {
        // Browser/Node style: direct constructor.
        const socket = new Ctor(url);
        await new Promise<void>((resolve, reject) => {
          const onOpen = () => { cleanup(); resolve(); };
          const onErr = (e: Event) => { cleanup(); reject(new Error(`Nimbus WS error: ${(e as ErrorEvent).message ?? 'open failed'}`)); };
          const onClose = () => { cleanup(); reject(new Error('Nimbus WS closed before open')); };
          const cleanup = () => {
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onErr);
            socket.removeEventListener('close', onClose);
          };
          socket.addEventListener('open', onOpen);
          socket.addEventListener('error', onErr);
          socket.addEventListener('close', onClose);
        });
        socket.addEventListener('message', (e) => onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)));
        socket.addEventListener('close', () => { ws = null; });
        ws = socket;
        return;
      }

      // Cloudflare Workers style: fetch with Upgrade.
      const res = await fetch(url, {
        headers: { Upgrade: 'websocket' },
      });
      if (res.status !== 101) {
        throw new SandboxError(`Nimbus WS upgrade failed: ${res.status}`, 'protocol');
      }
      // workerd attaches webSocket to the response when status is 101.
      const wsObj = (res as Response & { webSocket?: WebSocket }).webSocket;
      if (!wsObj) {
        throw new SandboxError('Nimbus WS upgrade: missing webSocket on response', 'protocol');
      }
      (wsObj as WebSocket & { accept(): void }).accept();
      wsObj.addEventListener('message', (e: MessageEvent) => onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)));
      wsObj.addEventListener('close', () => { ws = null; });
      ws = wsObj;
    })();

    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }

  function sendOrThrow(payload: object): void {
    if (!ws || ws.readyState !== 1) {
      throw new SandboxError('Nimbus WS not open', 'not_available');
    }
    ws.send(JSON.stringify(payload));
  }

  function fsRpc(payload: object, timeoutMs = 30_000): Promise<NimbusFsResult> {
    const reqId = nextReqId();
    return new Promise<NimbusFsResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFs.delete(reqId);
        reject(new SandboxError(`Nimbus FS RPC timeout: ${JSON.stringify(payload)}`, 'timeout'));
      }, timeoutMs);
      pendingFs.set(reqId, { resolve, reject, timeout });
      try {
        sendOrThrow({ ...payload, reqId });
      } catch (err) {
        clearTimeout(timeout);
        pendingFs.delete(reqId);
        reject(err);
      }
    });
  }

  return {
    id,
    kind: 'nimbus',
    capabilities,

    async connect(): Promise<void> {
      await ensureConnected();
    },
    async disconnect(): Promise<void> {
      try { ws?.close(); } catch { /* nop */ }
      ws = null;
      for (const ex of pendingExecs) {
        clearTimeout(ex.timeout);
        ex.reject(new SandboxError('Nimbus disconnected', 'not_available'));
      }
      pendingExecs.length = 0;
      for (const [_id, op] of pendingFs) {
        clearTimeout(op.timeout);
        op.reject(new SandboxError('Nimbus disconnected', 'not_available'));
      }
      pendingFs.clear();
    },
    isAvailable: () => ws?.readyState === 1,

    async exec(command: string, options?: ExecOptions): Promise<ShellResult> {
      await ensureConnected();
      const sentinelId = nextReqId();
      const sentinel = `__NIMBUS_DONE_${sentinelId}_`;
      const wrapped = options?.cwd
        ? `cd ${shellQuote(options.cwd)} && (${command}); printf '\\n${sentinel}%s\\n' $?\n`
        : `(${command}); printf '\\n${sentinel}%s\\n' $?\n`;

      return new Promise<ShellResult>((resolve, reject) => {
        const timeoutMs = options?.timeout ?? execTimeoutMs;
        const ex: PendingExec = {
          sentinel,
          buffer: '',
          resolve,
          reject,
          startedAt: Date.now(),
          timeout: setTimeout(() => {
            const idx = pendingExecs.indexOf(ex);
            if (idx >= 0) pendingExecs.splice(idx, 1);
            // Send Ctrl-C to give the terminal a chance to abort.
            try { sendOrThrow({ type: 'input', data: '\x03' }); } catch { /* nop */ }
            resolve({
              stdout: ex.buffer,
              stderr: `Nimbus exec timeout after ${timeoutMs}ms`,
              exitCode: 124,
              aborted: true,
              durationMs: Date.now() - ex.startedAt,
            });
          }, timeoutMs),
        };
        pendingExecs.push(ex);
        try {
          sendOrThrow({ type: 'input', data: wrapped });
        } catch (err) {
          clearTimeout(ex.timeout);
          const idx = pendingExecs.indexOf(ex);
          if (idx >= 0) pendingExecs.splice(idx, 1);
          reject(err);
        }
      });
    },

    async readFile(path: string): Promise<string> {
      await ensureConnected();
      const r = await fsRpc({ type: 'fs-read', path });
      if (!r.ok) throw new SandboxError(r.error ?? `Read failed: ${path}`, 'not_found');
      return r.content ?? '';
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      await ensureConnected();
      const body = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const r = await fsRpc({ type: 'fs-write', path, content: body });
      if (!r.ok) throw new SandboxError(r.error ?? `Write failed: ${path}`, 'internal');
    },

    async readdir(path: string): Promise<DirEntry[]> {
      await ensureConnected();
      const r = await fsRpc({ type: 'fs-list', dir: path });
      if (!r.ok) throw new SandboxError(r.error ?? `readdir failed: ${path}`, 'not_found');
      return (r.files ?? []).map((f) => {
        const full = path.endsWith('/') ? path + f.name : path + '/' + f.name;
        return {
          name: f.name,
          path: full,
          isDirectory: f.isDir,
          size: f.isDir ? undefined : f.size,
        };
      });
    },

    async stat(path: string): Promise<Stat | null> {
      await ensureConnected();
      // No direct stat; use fs-list of parent and find the entry.
      if (path === '/' || path === '') {
        return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtimeMs: 0 };
      }
      const parts = path.split('/').filter(Boolean);
      const name = parts[parts.length - 1];
      const parent = '/' + parts.slice(0, -1).join('/');
      try {
        const r = await fsRpc({ type: 'fs-list', dir: parent });
        if (!r.ok) return null;
        const hit = (r.files ?? []).find((f) => f.name === name);
        if (!hit) return null;
        return {
          isFile: !hit.isDir,
          isDirectory: hit.isDir,
          isSymbolicLink: false,
          size: hit.size ?? 0,
          mtimeMs: 0,
        };
      } catch {
        return null;
      }
    },

    async exists(path: string): Promise<boolean> {
      await ensureConnected();
      // Use shell `test -e` — cheaper than walking fs-list for deep paths.
      try {
        const r = await this.exec(`test -e ${shellQuote(path)} && echo yes || echo no`, { timeout: 5_000 });
        return r.stdout.trim().endsWith('yes');
      } catch {
        return false;
      }
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      const flag = options?.recursive === false ? '' : '-p ';
      const r = await this.exec(`mkdir ${flag}${shellQuote(path)}`, { timeout: 5_000 });
      if (r.exitCode !== 0) throw new SandboxError(`mkdir: ${r.stderr || r.stdout}`, 'internal');
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
      const flagArg = flags ? `-${flags} ` : '';
      const r = await this.exec(`rm ${flagArg}${shellQuote(path)}`, { timeout: 15_000 });
      if (r.exitCode !== 0 && !options?.force) {
        throw new SandboxError(`rm: ${r.stderr || r.stdout}`, 'internal');
      }
    },

    // ── Ports (Nimbus serves via /s/{id}/port/{port}/ on its own domain) ──

    async listPorts(): Promise<PortInfo[]> {
      // Nimbus doesn't expose a programmatic port-list API; convention-based.
      // We return what we've explicitly exposed via exposePort() — tracked
      // by callers if needed. Empty for now.
      return [];
    },

    async exposePort(port: number, options?: { name?: string }): Promise<PortInfo> {
      // Nimbus exposes any listening port through /s/{id}/port/{port}/. No
      // registration required; just construct the URL.
      const url = new URL(`/s/${sessionId}/port/${port}/`, endpoint).toString();
      return { port, name: options?.name, url, status: 'live' };
    },

    async unexposePort(_port: number): Promise<void> {
      // No-op — Nimbus doesn't have a registration model for ports.
    },
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
