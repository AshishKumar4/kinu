/**
 * NimbusExecutor — WebSocket client for github.com/AshishKumar4/Nimbus.
 *
 * Nimbus is a Cloudflare-hosted Linux-like environment per Durable Object:
 *   • Full bash + 60+ POSIX commands
 *   • Native Node/Bun (via workerd), Python (Pyodide), Ruby (ruby.wasm)
 *   • 10 GB SQLite-backed VFS per session
 *   • Sub-500ms cold starts, $0 idle (DO hibernation)
 *
 * Public WebSocket protocol (per docs/RESEARCH_NOTES.md §C):
 *   • POST /new → 302 → /s/{sessionId}/
 *   • ws://{endpoint}/s/{sessionId}/ws
 *     ─ terminal:   {type:"input"|"resize", ...} → {type:"output", data}
 *     ─ filesystem: {type:"fs-read"|"fs-write"|"fs-list", reqId, ...}
 *                   → {type:"fs-*-result", reqId, ok, ...}
 *   • Auth: HS256 JWT via ?nimbus_token=<jwt>
 *
 * Shell exec strategy: terminal protocol doesn't return structured exit
 * codes, so we wrap each command with a sentinel marker:
 *   <user_cmd>; printf '\n__NIMBUS_DONE_<rid>_%s\n' $?
 * and consume `output` chunks until the sentinel matches.
 *
 * Namespace inside codemode sandbox: `nimbus.*`
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

export interface NimbusExecutorOpts {
  /** Nimbus endpoint, e.g. "https://nimbus.example.workers.dev". No trailing slash. */
  endpoint: string;
  /** HS256 JWT issued via Nimbus's issueNimbusToken(). Required when Nimbus runs in 'enforce' mode. */
  token?: string;
  /**
   * Existing session id to attach to. Omit to call POST /new on first
   * connect() and remember the returned sessionId for subsequent calls.
   */
  sessionId?: string;
  /** Override the WebSocket constructor (used for tests + Node compatibility). */
  webSocketImpl?: typeof WebSocket;
  /** Maximum wall-clock for any single exec, in milliseconds. Default 60s. */
  execTimeoutMs?: number;
}

const NOT_CONFIGURED =
  'Nimbus executor not configured. Call createNimbusExecutor({ endpoint, token?, sessionId? }) ' +
  'with a reachable Nimbus deployment URL.';

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const FS_RPC_TIMEOUT_MS = 30_000;

interface PendingFsOp {
  resolve: (value: NimbusFsResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingExec {
  sentinel: string;
  buffer: string;
  resolve: (result: { stdout: string; stderr: string; exitCode: number }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface NimbusFsResult {
  type: 'fs-read-result' | 'fs-write-result' | 'fs-list-result';
  reqId: string | number;
  ok: boolean;
  error?: string;
  content?: string;
  files?: Array<{ name: string; isDir: boolean; size?: number }>;
}

/**
 * Create a NimbusExecutor backed by a Nimbus WebSocket session.
 *
 * Pass an `endpoint` (and optional `token`/`sessionId`) to enable real
 * operations. Without opts, returns stub-mode error messages.
 */
export function createNimbusExecutor(opts?: NimbusExecutorOpts): ExecutorProvider {
  const configured = opts != null;
  let ws: WebSocket | null = null;
  let connecting: Promise<void> | null = null;
  let sessionId = opts?.sessionId ?? '';
  let reqSeq = 0;
  const pendingFs = new Map<string | number, PendingFsOp>();
  const pendingExecs: PendingExec[] = [];

  const execTimeoutMs = opts?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  function nextReqId(): string {
    return `r${++reqSeq}_${Date.now().toString(36)}`;
  }

  function buildWsUrl(sessId: string): string {
    const u = new URL(`/s/${encodeURIComponent(sessId)}/ws`, opts!.endpoint);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (opts?.token) u.searchParams.set('nimbus_token', opts.token);
    return u.toString();
  }

  async function createSession(): Promise<string> {
    const url = new URL('/new', opts!.endpoint).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: opts?.token ? { Authorization: `Bearer ${opts.token}` } : {},
      redirect: 'manual',
    });
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
    throw new Error(`Failed to create Nimbus session (status ${res.status})`);
  }

  function onMessage(raw: string): void {
    let msg: { type?: string; reqId?: string | number; data?: string; ok?: boolean; error?: string; content?: string; files?: NimbusFsResult['files'] };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.type) return;

    if (msg.type === 'fs-read-result' || msg.type === 'fs-write-result' || msg.type === 'fs-list-result') {
      const reqId = msg.reqId;
      if (reqId == null) return;
      const pending = pendingFs.get(reqId);
      if (!pending) return;
      pendingFs.delete(reqId);
      clearTimeout(pending.timeout);
      // Narrow to NimbusFsResult — at this point we've already type-checked
      // `msg.type` is one of the three fs-* result types and the shape of
      // those messages matches the NimbusFsResult union by construction.
      pending.resolve(msg as NimbusFsResult);
      return;
    }

    if (msg.type === 'output' && typeof msg.data === 'string') {
      for (const ex of pendingExecs) {
        ex.buffer += msg.data;
        const idx = ex.buffer.indexOf(ex.sentinel);
        if (idx === -1) continue;
        const rest = ex.buffer.slice(idx + ex.sentinel.length);
        const m = rest.match(/^(\d+)/);
        const exitCode = m ? Number(m[1]) : 0;
        const stdout = ex.buffer.slice(0, idx).replace(/\r/g, '');
        clearTimeout(ex.timeout);
        const i = pendingExecs.indexOf(ex);
        if (i >= 0) pendingExecs.splice(i, 1);
        ex.resolve({ stdout, stderr: '', exitCode });
      }
    }
  }

  async function ensureConnected(): Promise<void> {
    if (!configured) throw new Error(NOT_CONFIGURED);
    if (ws && ws.readyState === 1) return;
    if (connecting) return connecting;
    connecting = (async () => {
      if (!sessionId) sessionId = await createSession();
      const url = buildWsUrl(sessionId);
      const Ctor = opts?.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;

      if (Ctor) {
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
        socket.addEventListener('message', (e) =>
          onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)),
        );
        socket.addEventListener('close', () => { ws = null; });
        ws = socket;
        return;
      }

      // Cloudflare Workers style: fetch + Upgrade.
      const res = await fetch(url, { headers: { Upgrade: 'websocket' } });
      if (res.status !== 101) throw new Error(`Nimbus WS upgrade failed: ${res.status}`);
      const wsObj = (res as Response & { webSocket?: WebSocket }).webSocket;
      if (!wsObj) throw new Error('Nimbus WS upgrade: missing webSocket on response');
      (wsObj as WebSocket & { accept(): void }).accept();
      wsObj.addEventListener('message', (e: MessageEvent) =>
        onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)),
      );
      wsObj.addEventListener('close', () => { ws = null; });
      ws = wsObj;
    })();
    try { await connecting; } finally { connecting = null; }
  }

  function sendOrThrow(payload: object): void {
    if (!ws || ws.readyState !== 1) throw new Error('Nimbus WS not open');
    ws.send(JSON.stringify(payload));
  }

  function fsRpc(payload: object, timeoutMs = FS_RPC_TIMEOUT_MS): Promise<NimbusFsResult> {
    const reqId = nextReqId();
    return new Promise<NimbusFsResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFs.delete(reqId);
        reject(new Error(`Nimbus FS RPC timeout: ${JSON.stringify(payload)}`));
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

  async function runExec(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await ensureConnected();
    const sentinelId = nextReqId();
    const sentinel = `__NIMBUS_DONE_${sentinelId}_`;
    const wrapped = opts?.cwd
      ? `cd ${shellQuote(opts.cwd)} && (${command}); printf '\\n${sentinel}%s\\n' $?\n`
      : `(${command}); printf '\\n${sentinel}%s\\n' $?\n`;

    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? execTimeoutMs;
      const ex: PendingExec = {
        sentinel,
        buffer: '',
        resolve,
        reject,
        timeout: setTimeout(() => {
          const i = pendingExecs.indexOf(ex);
          if (i >= 0) pendingExecs.splice(i, 1);
          try { sendOrThrow({ type: 'input', data: '\x03' }); } catch { /* nop */ }
          resolve({ stdout: ex.buffer, stderr: `Nimbus exec timeout after ${timeoutMs}ms`, exitCode: 124 });
        }, timeoutMs),
      };
      pendingExecs.push(ex);
      try {
        sendOrThrow({ type: 'input', data: wrapped });
      } catch (err) {
        clearTimeout(ex.timeout);
        const i = pendingExecs.indexOf(ex);
        if (i >= 0) pendingExecs.splice(i, 1);
        reject(err);
      }
    });
  }

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description:
        'Run a shell command in the Nimbus development environment. ' +
        'Supports 60+ POSIX commands, npm, node, git, esbuild, vite.',
      execute: async (command: unknown): Promise<string> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          const r = await runExec(String(command));
          if (r.exitCode !== 0) return `Exit ${r.exitCode}${r.stderr ? ': ' + r.stderr : ''}`;
          return r.stdout || '(no output)';
        } catch (err) {
          return `exec error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readFile: {
      description: 'Read a file from the Nimbus development filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          await ensureConnected();
          const r = await fsRpc({ type: 'fs-read', path: String(path) });
          if (!r.ok) return r.error ?? `File not found: ${path}`;
          return r.content ?? '';
        } catch (err) {
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    writeFile: {
      description: 'Write a file to the Nimbus development filesystem.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          await ensureConnected();
          const body = String(content);
          const r = await fsRpc({ type: 'fs-write', path: String(path), content: body });
          if (!r.ok) return `writeFile failed: ${r.error ?? 'unknown error'}`;
          return `Written ${body.length} bytes to ${path}`;
        } catch (err) {
          return `writeFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readdir: {
      description: 'List directory contents in the Nimbus filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          await ensureConnected();
          const r = await fsRpc({ type: 'fs-list', dir: String(path || '/') });
          if (!r.ok) return `readdir failed: ${r.error ?? path}`;
          return (r.files ?? []).map((f) => `${f.isDir ? 'd' : '-'} ${f.name}${f.size != null ? ` (${f.size}b)` : ''}`).join('\n');
        } catch (err) {
          return `readdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    exists: {
      description: 'Check if a path exists in the Nimbus filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!configured) return false;
        try {
          const r = await runExec(`test -e ${shellQuote(String(path))} && echo yes || echo no`);
          return r.stdout.trim().endsWith('yes');
        } catch { return false; }
      },
    },

    stat: {
      description: 'Get file/directory metadata from the Nimbus filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          // BSD/GNU stat differ; this matches Linux. Nimbus runs Linux containers.
          const r = await runExec(`stat -c "%s %Y %F" ${shellQuote(String(path))}`);
          if (r.exitCode !== 0) return `Not found: ${path}`;
          const [size, mtime, ...kindParts] = r.stdout.trim().split(' ');
          return `${kindParts.join(' ')} size=${size} mtime=${mtime}`;
        } catch (err) {
          return `stat error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    mkdir: {
      description: 'Create a directory in the Nimbus filesystem (recursive).',
      execute: async (path: unknown): Promise<string> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          const r = await runExec(`mkdir -p ${shellQuote(String(path))}`);
          if (r.exitCode !== 0) return `mkdir failed: ${r.stderr}`;
          return `Created ${path}`;
        } catch (err) {
          return `mkdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    rm: {
      description: 'Delete a file from the Nimbus filesystem.',
      execute: async (path: unknown): Promise<string> => {
        if (!configured) return NOT_CONFIGURED;
        try {
          const r = await runExec(`rm -rf ${shellQuote(String(path))}`);
          if (r.exitCode !== 0) return `rm failed: ${r.stderr}`;
          return `Deleted ${path}`;
        } catch (err) {
          return `rm error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  };

  return {
    name: 'nimbus',
    kind: 'nimbus',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'shell', 'npm', 'git',
      'fs_owned', 'net_outbound', 'net_inbound', 'process_spawn', 'process_long',
    ]),
    isAvailable: () => configured && (ws == null || ws.readyState <= 1),
    connect: async () => {
      if (!configured) throw new Error(NOT_CONFIGURED);
      await ensureConnected();
    },
    disconnect: async () => {
      try { ws?.close(); } catch { /* nop */ }
      ws = null;
      for (const ex of pendingExecs) {
        clearTimeout(ex.timeout);
        ex.reject(new Error('Nimbus disconnected'));
      }
      pendingExecs.length = 0;
      for (const [, op] of pendingFs) {
        clearTimeout(op.timeout);
        op.reject(new Error('Nimbus disconnected'));
      }
      pendingFs.clear();
    },
    tools,
    types: `declare namespace nimbus {
  /** Run a shell command (60+ POSIX commands, npm, node, git, esbuild, vite) */
  function exec(command: string): Promise<string>;
  /** Read a file from the Nimbus development filesystem */
  function readFile(path: string): Promise<string>;
  /** Write a file to the Nimbus development filesystem */
  function writeFile(path: string, content: string): Promise<string>;
  /** List directory contents */
  function readdir(path: string): Promise<string>;
  /** Check if a path exists */
  function exists(path: string): Promise<boolean>;
  /** Get file/directory metadata */
  function stat(path: string): Promise<string>;
  /** Create a directory (recursive) */
  function mkdir(path: string): Promise<string>;
  /** Delete a file */
  function rm(path: string): Promise<string>;
}`,
    positionalArgs: true,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
