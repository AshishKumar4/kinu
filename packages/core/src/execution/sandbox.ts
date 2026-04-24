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
 * Port APIs require a hostname (RFC 3986 case-sensitivity + preview URL
 * construction — the SDK builds `https://<port>-<sandbox>-<token>.<hostname>`).
 * The cf-backend adapter binds a specific hostname into the handle by closing
 * over env.PREVIEW_HOSTNAME at construction time, so core doesn't need to know.
 */
export interface SandboxHandle {
  exec(command: string, opts?: { cwd?: string; timeout?: number }):
    Promise<{ output?: string; stdout?: string; stderr?: string; exitCode?: number }>;
  readFile(path: string): Promise<{ content?: string; exitCode?: number }>;
  writeFile(path: string, content: string): Promise<unknown>;
  listFiles(path: string, opts?: { recursive?: boolean }):
    Promise<{ files: Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }> }>;
  deleteFile(path: string): Promise<unknown>;
  /** Opts include both the user-supplied name and the closed-over hostname. */
  exposePort(port: number, opts: { hostname: string; name?: string }):
    Promise<{ url: string; port: number; name?: string }>;
  unexposePort(port: number): Promise<unknown>;
  /** Hostname required — SDK uses it to build URLs in the result rows. */
  listPorts(hostname: string):
    Promise<Array<{ url: string; port: number; status?: string }>>;
}

const NOT_CONFIGURED =
  'Sandbox executor not configured. Add the @cloudflare/sandbox binding ' +
  'and Container to wrangler.jsonc (see docs/EXECUTOR-V2.md).';

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
 * @param hostname   `env.PREVIEW_HOSTNAME` — used by exposePort/listPorts to
 *                   build preview URLs. Required when handle is supplied.
 */
export function createSandboxExecutor(
  handle?: SandboxHandle,
  hostname?: string,
): ExecutorProvider {
  const connected = handle != null && typeof hostname === 'string' && hostname.length > 0;

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Run a shell command in the sandbox container.',
      execute: async (command: unknown): Promise<string> => {
        if (!handle) return NOT_CONFIGURED;
        try {
          const res = await handle.exec(String(command), { timeout: 60_000 });
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
          const r = await handle.readFile(String(path));
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
          await handle.writeFile(String(path), String(content));
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
          const r = await handle.listFiles(String(path ?? '/'), { recursive: false });
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
          await handle.deleteFile(String(path));
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
        const res = await handle.exec(`test -e ${JSON.stringify(String(path))} && echo true || echo false`);
        const out = (res.stdout ?? res.output ?? '').trim();
        return out.includes('true') ? 'true' : 'false';
      },
    },
    exposePort: {
      description: 'Expose a TCP port from the sandbox. Returns the public preview URL. Optional name.',
      execute: async (port: unknown, name?: unknown): Promise<string> => {
        if (!handle || !hostname) return NOT_CONFIGURED;
        try {
          const p = Number(port);
          const opts: { hostname: string; name?: string } = { hostname };
          if (name != null) opts.name = String(name);
          const r = await handle.exposePort(p, opts);
          return r.url ?? `exposed ${p}`;
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
          await handle.unexposePort(Number(port));
          return `unexposed ${port}`;
        } catch (err) {
          return `unexpose error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    listPorts: {
      description: 'List currently exposed ports. Returns JSON array of {port,url,status}.',
      execute: async (): Promise<string> => {
        if (!handle || !hostname) return NOT_CONFIGURED;
        try {
          const ports = await handle.listPorts(hostname);
          return JSON.stringify(ports ?? []);
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
