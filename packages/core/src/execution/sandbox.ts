/**
 * SandboxExecutor — @cloudflare/sandbox-backed executor.
 *
 * Each agent gets its own Linux container via a Sandbox DO. The orchestrator
 * passes a SandboxHandle (duck-typed here so core stays dep-free) obtained
 * from `getSandbox(env.SANDBOX, agentId)`.
 *
 * Namespace inside codemode sandbox: `sandbox.*`
 *   sandbox.exec("npm test")
 *   sandbox.readFile("/workspace/app.ts")
 *   sandbox.writeFile("/workspace/util.ts", code)
 *   sandbox.listFiles("/workspace")
 *   sandbox.deleteFile("/workspace/tmp.txt")
 *   sandbox.exposePort(3000, { name: "dev" })
 *   sandbox.unexposePort(3000)
 *   sandbox.listPorts()
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

/**
 * Duck-typed handle — matches the subset of @cloudflare/sandbox's getSandbox()
 * return value we consume. Core accepts `unknown`-typed handles and narrows
 * here, so cf-backend can supply the real thing without core having a
 * package dependency.
 *
 * The SDK's `exposePort` enables in-container port forwarding and stores a
 * token in DO storage. It also builds a preview URL like
 * `https://<port>-<sandbox>-<token>.<hostname>` — but that scheme needs a
 * wildcard DNS record we can't create. Proteus overrides the returned URL
 * with a path-style one (`/_preview/<port>/<sandbox>/<token>/`) served by
 * preview-proxy.ts on the main domain. To keep the token in sync we pass
 * an explicit `token` to the SDK so both sides agree.
 */
export interface SandboxHandle {
  exec(command: string, opts?: { cwd?: string; timeout?: number }):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  readFile(path: string): Promise<{ content?: string; exitCode?: number }>;
  writeFile(path: string, content: string): Promise<unknown>;
  listFiles(path: string, opts?: { recursive?: boolean }):
    Promise<{ files: Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }> }>;
  deleteFile(path: string): Promise<unknown>;
  /**
   * Expose a port. We always pass an explicit `token` so the executor
   * can build path-style URLs without parsing the SDK return value.
   * The `hostname` is required by the SDK but only used internally to
   * construct the URL we throw away.
   */
  exposePort(port: number, opts: { hostname: string; name?: string; token?: string }):
    Promise<{ url: string; port: number; name?: string }>;
  unexposePort(port: number): Promise<unknown>;
  /**
   * SDK method is `getExposedPorts(hostname)` — hostname is used to
   * build the `url` field on each returned row. We parse tokens back
   * out of those URLs to rebuild path-style URLs on the way out.
   */
  getExposedPorts(hostname: string):
    Promise<Array<{ url: string; port: number; status?: string }>>;
}

/**
 * Stable token generator — RFC-3986-safe chars matching the SDK's
 * validateCustomToken (lower-case alphanumerics + underscore, 4-63 chars).
 * Using a deterministic-but-unique scheme keeps E2E assertions easier;
 * collisions across agents are impossible because each agent owns its
 * own sandbox DO.
 */
function generatePortToken(port: number): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `p${port}_${rand}`;
}

/**
 * Extract the token from an SDK-shaped preview URL. Returns null if the
 * URL doesn't match the `PORT-SANDBOXID-TOKEN.hostname` pattern.
 * Kept in this file so the logic stays alongside the URL contract.
 */
function extractTokenFromSdkUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const dot = u.hostname.indexOf('.');
    if (dot === -1) return null;
    const subdomain = u.hostname.slice(0, dot);
    const lastHyphen = subdomain.lastIndexOf('-');
    if (lastHyphen === -1) return null;
    const token = subdomain.slice(lastHyphen + 1);
    return /^[a-z0-9_]+$/i.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Build the Proteus path-style preview URL. Mirrors
 * `packages/cf-backend/src/preview-proxy.ts#buildPreviewUrl`; kept here
 * because core can't depend on cf-backend.
 */
function buildPathPreviewUrl(
  hostname: string,
  port: number,
  sandboxId: string,
  token: string,
): string {
  return `https://${hostname}/_preview/${port}/${sandboxId}/${token}/`;
}

const NOT_CONFIGURED =
  'Sandbox executor not configured. Add the @cloudflare/sandbox binding ' +
  'and Container to wrangler.jsonc (see docs/EXECUTOR-V2.md).';

/**
 * Substring markers (lower-cased) for transient sandbox/RPC errors that the
 * SDK either auto-retries via 503 or does NOT retry at all (mid-request 500
 * with body 'Container suddenly disconnected, try again' — see
 * @cloudflare/containers/dist/lib/container.js:947-948). Cross-DO RPC drops
 * surface as 'Network connection lost.' before the SDK ever runs. We retry
 * any of these once with exponential-ish backoff. (STABILITY-AUDIT §B2/§B3.)
 */
const TRANSIENT_MARKERS = [
  'network connection lost',
  'container suddenly disconnected',
  'container is starting',
  'no container instance',
  // 0.8.11 SDK started classifying this as transient; cover us either way:
  'http error! status: 500',
];

function isTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_MARKERS.some(m => msg.includes(m));
}

/**
 * Run `fn` with up to `attempts` total tries, retrying only on transient
 * errors. Backoff: 500ms, 1000ms (i.e. 500ms × 2^attempt). Non-transient
 * errors throw immediately. Used to swallow the brief disconnect window
 * during container/DO eviction without forcing the agent to error-handle.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function normalize(res: { output?: string; stdout?: string; stderr?: string; exitCode?: number }): string {
  // @cloudflare/sandbox returns { stdout, stderr, exitCode }; older versions
  // returned { output, exitCode }. Accept both.
  const stdout = res.stdout ?? res.output ?? '';
  const stderr = res.stderr ?? '';
  const exitCode = res.exitCode ?? 0;
  if (exitCode !== 0) {
    return `Exit ${exitCode}${stderr ? `\n${stderr}` : ''}${stdout ? `\n${stdout}` : ''}`.trim();
  }
  return stdout || stderr || '(no output)';
}

/**
 * Build an ExecutorProvider from a live SandboxHandle.
 * Pass `undefined` to get a "not configured" stub that appears in the UI's
 * Not-configured footer without breaking the router.
 *
 * @param handle     SDK `getSandbox()` result.
 * @param hostname   `env.PREVIEW_HOSTNAME` — path-proxy host (main custom
 *                   domain). Required when handle is supplied.
 * @param sandboxId  Stable sandbox identifier (`proteus-<agent-name>`).
 *                   Required when handle is supplied; embedded in every
 *                   preview URL so preview-proxy.ts can route back to the
 *                   right DO.
 */
export function createSandboxExecutor(
  handle?: SandboxHandle,
  hostname?: string,
  sandboxId?: string,
): ExecutorProvider {
  const connected = handle != null
    && typeof hostname === 'string' && hostname.length > 0
    && typeof sandboxId === 'string' && sandboxId.length > 0;

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the sandbox container.',
      execute: async (command: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          const res = await withRetry(() => handle.exec(String(command), { timeout: 60_000 }));
          return normalize(res);
        } catch (err) {
          return `exec error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    readFile: {
      description: 'Read a file from the sandbox.',
      execute: async (path: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          const r = await withRetry(() => handle.readFile(String(path)));
          if (r.exitCode && r.exitCode !== 0) return `read error: exit ${r.exitCode}`;
          return r.content ?? '';
        } catch (err) {
          return `read error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    writeFile: {
      description: 'Write content to a file in the sandbox. Creates parent dirs.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          await withRetry(() => handle.writeFile(String(path), String(content)));
          return `wrote ${String(path)}`;
        } catch (err) {
          return `write error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    listFiles: {
      description: 'List files in a directory. Returns newline-separated entries prefixed "d" or "-".',
      execute: async (path: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          const r = await withRetry(() => handle.listFiles(String(path ?? '/'), { recursive: false }));
          if (!r?.files?.length) return '';
          return r.files
            .map(f => {
              const name = f.name ?? f.path ?? '';
              const isDir = f.isDirectory ?? f.type === 'directory';
              return `${isDir ? 'd' : '-'} ${name}`;
            })
            .join('\n');
        } catch (err) {
          return `list error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    readdir: {
      description: 'Alias for listFiles — list entries in a directory.',
      execute: async (path: unknown): Promise<string> => {
        return (await tools.listFiles.execute(path)) as string;
      },
    },
    deleteFile: {
      description: 'Delete a file or directory.',
      execute: async (path: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          await withRetry(() => Promise.resolve(handle.deleteFile(String(path))));
          return `deleted ${String(path)}`;
        } catch (err) {
          return `delete error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    exists: {
      description: 'Check if a path exists — uses shell test.',
      execute: async (path: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        const res = await withRetry(() => handle.exec(`test -e ${JSON.stringify(String(path))} && echo true || echo false`));
        const out = (res.stdout ?? res.output ?? '').trim();
        return out.includes('true') ? 'true' : 'false';
      },
    },
    exposePort: {
      description: 'Expose a TCP port from the sandbox. Returns the public preview URL. Optional name.',
      execute: async (port: unknown, name?: unknown): Promise<string> => {
        if (!handle || !hostname || !sandboxId) return NOT_CONFIGURED;
        try {
          const p = Number(port);
          // Generate our own token so we can build the path URL without
          // parsing the SDK result (and it survives across listPorts calls).
          const token = generatePortToken(p);
          const opts: { hostname: string; name?: string; token?: string } = { hostname, token };
          if (name != null) opts.name = String(name);
          await withRetry(() => handle.exposePort(p, opts));
          return buildPathPreviewUrl(hostname, p, sandboxId, token);
        } catch (err) {
          return `expose error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    unexposePort: {
      description: 'Stop exposing a port.',
      execute: async (port: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          await withRetry(() => Promise.resolve(handle.unexposePort(Number(port))));
          return `unexposed ${port}`;
        } catch (err) {
          return `unexpose error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    listPorts: {
      description: 'List currently exposed ports. Returns JSON array of {port,url,status}.',
      execute: async (): Promise<string> => {
        if (!handle || !hostname || !sandboxId) return NOT_CONFIGURED;
        try {
          // SDK method is getExposedPorts — the tool we expose is still
          // named listPorts for backward compat with the codemode namespace.
          const ports = await withRetry(() => handle.getExposedPorts(hostname));
          // Rewrite SDK hostname-style URLs into Proteus path-style URLs
          // so the UI iframe (which lives on the main domain) can load
          // them without a wildcard DNS record.
          const remapped = (ports ?? []).map(p => {
            const token = extractTokenFromSdkUrl(p.url);
            return {
              port: p.port,
              status: p.status,
              url: token
                ? buildPathPreviewUrl(hostname, p.port, sandboxId, token)
                : p.url,
            };
          });
          return JSON.stringify(remapped);
        } catch (err) {
          return `listPorts error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  };

  const types = `
/**
 * sandbox — @cloudflare/sandbox Linux container, one per agent.
 */
declare namespace sandbox {
  function exec(command: string): Promise<string>;
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function listFiles(path: string): Promise<string>;
  function readdir(path: string): Promise<string>;
  function deleteFile(path: string): Promise<string>;
  function exists(path: string): Promise<'true'|'false'>;
  function exposePort(port: number, name?: string): Promise<string>;
  function unexposePort(port: number): Promise<string>;
  function listPorts(): Promise<string>;
}
`.trim();

  const capabilities: ExecutorCapability[] = [
    'shell', 'npm', 'git', 'docker', 'process_spawn', 'process_long',
    'net_inbound', 'net_outbound', 'fs_owned',
  ];

  return {
    name: 'sandbox',
    kind: 'sandbox',
    capabilities: new Set(capabilities),
    isAvailable: () => connected,
    connect: async () => { /* sandbox starts on first RPC */ },
    disconnect: async () => { /* sandbox DO persists; no explicit close */ },
    tools,
    types,
    positionalArgs: true,
  };
}
