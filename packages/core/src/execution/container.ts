/**
 * ContainerExecutor — Cloudflare Container VM via DO container API.
 *
 * Uses ctx.container to start a Linux container and communicates via
 * HTTP on a TCP port. The container runs an exec-server image that
 * exposes REST endpoints for command execution and filesystem ops.
 *
 * When the CONTAINER DO binding is not available, returns clear errors
 * telling the user how to configure it.
 *
 * Namespace: sandbox.*
 *   sandbox.exec("npm test")
 *   sandbox.readFile("/workspace/app.ts")
 *   sandbox.writeFile("/workspace/util.ts", code)
 *   sandbox.readdir("/workspace")
 *   sandbox.exists("/workspace/package.json")
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';

const NOT_CONFIGURED =
  'Container executor not configured. Add a container binding to wrangler.jsonc:\n' +
  '  "containers": [{ "class_name": "SandboxContainer", "image": "./Dockerfile", "max_instances": 5 }]\n' +
  '  Then add a DO binding: { "name": "CONTAINER", "class_name": "SandboxContainer" }';

const CONTAINER_PORT = 8080;

/**
 * The subset of the Cloudflare Container DO API we interact with.
 * The orchestrator obtains a stub via env.CONTAINER.get(id) and passes it here.
 */
export interface ContainerStub {
  /** Start the container. Resolves when the start command is issued (not when ready). */
  start(options?: { entrypoint?: string[]; env?: Record<string, string>; enableInternet?: boolean }): void;
  /** Whether the container is currently running */
  readonly running: boolean;
  /** Get a TCP port handle for HTTP communication */
  getTcpPort(port: number): { fetch(url: string, init?: RequestInit): Promise<Response> };
  /** Monitor container lifecycle — resolves on exit, rejects on error */
  monitor(): Promise<void>;
  /** Destroy the container */
  destroy(reason?: string): Promise<void>;
  /** Send a signal (e.g. SIGTERM=15) */
  signal(sig: number): void;
}

/**
 * Create a ContainerExecutor backed by a Cloudflare Container DO stub.
 *
 * If no stub is provided, all operations return configuration instructions.
 * If a stub is provided, the executor starts the container on first use
 * and communicates via HTTP to the exec-server running on CONTAINER_PORT.
 */
export function createContainerExecutor(stub?: ContainerStub): ExecutorProvider {
  const hasBinding = stub != null;
  let started = false;

  async function ensureRunning(): Promise<void> {
    if (!stub) throw new Error(NOT_CONFIGURED);
    if (started && stub.running) return;
    stub.start({ enableInternet: true });
    // Poll until the HTTP server inside the container is ready
    const port = stub.getTcpPort(CONTAINER_PORT);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch('http://container/health');
        if (res.ok) { started = true; return; }
      } catch { /* container not ready yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Container failed to become ready within 30s');
  }

  async function containerFetch(path: string, init?: RequestInit): Promise<Response> {
    await ensureRunning();
    return stub!.getTcpPort(CONTAINER_PORT).fetch(`http://container${path}`, init);
  }

  const tools: ExecutorProvider['tools'] = {
    exec: {
      description: 'Execute a shell command in the Linux container. Full bash, any language runtime available.',
      execute: async (command: unknown): Promise<string> => {
        if (!hasBinding) return NOT_CONFIGURED;
        try {
          const res = await containerFetch('/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: String(command) }),
          });
          const data = await res.json() as { stdout?: string; stderr?: string; exitCode?: number };
          if (data.exitCode !== 0) {
            return `Exit ${data.exitCode}${data.stderr ? ': ' + data.stderr : ''}`;
          }
          return data.stdout || '(no output)';
        } catch (err) {
          return `exec error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readFile: {
      description: 'Read a file from the container filesystem.',
      execute: async (path: unknown): Promise<string> => {
        if (!hasBinding) return NOT_CONFIGURED;
        try {
          const res = await containerFetch(`/fs/read?path=${encodeURIComponent(String(path))}`);
          if (!res.ok) return `File not found: ${path}`;
          return await res.text();
        } catch (err) {
          return `readFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    writeFile: {
      description: 'Write content to a file in the container filesystem.',
      execute: async (path: unknown, content: unknown): Promise<string> => {
        if (!hasBinding) return NOT_CONFIGURED;
        try {
          const res = await containerFetch('/fs/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: String(path), content: String(content) }),
          });
          if (!res.ok) return `writeFile failed: ${await res.text()}`;
          return `Written ${String(content).length} bytes to ${path}`;
        } catch (err) {
          return `writeFile error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    readdir: {
      description: 'List directory contents in the container filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!hasBinding) return NOT_CONFIGURED;
        try {
          const res = await containerFetch(`/fs/readdir?path=${encodeURIComponent(String(path || '/'))}`);
          if (!res.ok) return `readdir failed: ${await res.text()}`;
          return await res.json();
        } catch (err) {
          return `readdir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    exists: {
      description: 'Check if a path exists in the container filesystem.',
      execute: async (path: unknown): Promise<unknown> => {
        if (!hasBinding) return NOT_CONFIGURED;
        try {
          const res = await containerFetch(`/fs/exists?path=${encodeURIComponent(String(path))}`);
          const data = await res.json() as { exists: boolean };
          return data.exists;
        } catch { return false; }
      },
    },
  };

  return {
    name: 'sandbox',
    kind: 'sandbox',
    capabilities: new Set<ExecutorCapability>([
      'javascript', 'typescript', 'python', 'native_binary',
      'shell', 'npm', 'git',
      'fs_owned', 'net_outbound', 'net_inbound',
      'process_spawn', 'process_long', 'process_signal',
    ]),
    isAvailable: () => hasBinding,
    connect: async () => { await ensureRunning(); },
    disconnect: async () => {
      if (stub && started) {
        try { await stub.destroy('disconnect'); } catch { /* already stopped */ }
        started = false;
      }
    },
    tools,
    types: `declare namespace sandbox {
  /** Execute a command in the Linux container (full bash, any language) */
  function exec(command: string): Promise<string>;
  /** Read a file from the container filesystem */
  function readFile(path: string): Promise<string>;
  /** Write a file to the container filesystem */
  function writeFile(path: string, content: string): Promise<string>;
  /** List directory contents */
  function readdir(path: string): Promise<string[]>;
  /** Check if a path exists */
  function exists(path: string): Promise<boolean>;
}`,
    positionalArgs: true,
  };
}
