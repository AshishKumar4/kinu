/**
 * SandboxApi — unified contract for execution environments.
 *
 * Any place the agent can run a shell command and touch a filesystem implements
 * this. One adapter (`sandboxToExecutorProvider`) maps it down to the existing
 * codemode `ExecutorProvider` surface, so adding a new sandbox is one file.
 *
 * The shape mirrors Flue's runtime SandboxApi (proven in production on
 * Cloudflare Workers + Daytona + E2B + Modal + Vercel), extended with:
 *   • id + kind + capabilities for routing and telemetry
 *   • lifecycle (connect/disconnect/isAvailable)
 *   • optional ports surface (Cloudflare Sandbox container preview)
 *   • optional pty surface (terminal streaming to UI)
 *   • optional spawn for long-running processes
 *
 * Implementations live under `packages/core/src/sandbox/impls/`. Legacy
 * `execution/*` files become thin adapters via `sandboxToExecutorProvider`.
 */

/** Stable identifiers for sandbox-kind dispatch and UI labels. */
export type SandboxKind =
  | 'virtual'      // SqliteFS-backed VFS + virtual bash (always available)
  | 'cloudflare'   // @cloudflare/sandbox Container DO (Linux VM on Workers)
  | 'nimbus'       // Nimbus session via WebSocket (github.com/AshishKumar4/Nimbus)
  | 'ssh'          // User's machine via reverse-WebSocket tunnel
  | 'local';       // Node child_process + fs (CLI mode only)

/** Coarse capability flags — used by routers / docs / system prompts. */
export type SandboxCapability =
  | 'shell'           // exec a posix-ish shell command
  | 'native_binary'   // can run compiled binaries (not just JS)
  | 'process_spawn'   // can spawn long-running children
  | 'process_signal'  // can send signals to children
  | 'fs_persistent'   // files survive across exec calls
  | 'fs_shared'       // multiple agents can see the same files
  | 'net_outbound'    // can reach the internet
  | 'net_inbound'     // can accept inbound connections (ports)
  | 'gpu'             // GPU available
  | 'docker';         // can run docker containers

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs?: number;
  /** True if exec was terminated by a timeout/signal rather than exiting cleanly. */
  readonly aborted?: boolean;
}

export interface ExecOptions {
  /** Working directory inside the sandbox. Implementations resolve relative paths against their own root. */
  cwd?: string;
  /** Extra env vars merged on top of the sandbox's defaults. */
  env?: Record<string, string>;
  /** Hard timeout in milliseconds — implementations should kill the process on overrun. */
  timeout?: number;
  /** Cancellation signal — implementations forward to underlying SDK when supported. */
  signal?: AbortSignal;
}

export interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  /** Bytes for files; undefined for directories or unknown. */
  readonly size?: number;
}

export interface Stat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  /** Modification time as epoch ms. */
  readonly mtimeMs: number;
}

export interface PortInfo {
  readonly port: number;
  readonly name?: string;
  /** Public URL where this port is reachable (preview URL, tunnel URL, etc). */
  readonly url?: string;
  readonly status?: 'live' | 'starting' | 'unreachable' | 'unknown';
}

export interface SpawnOptions extends ExecOptions {
  /** If true, the returned handle's stdout/stderr are streamed as async iterables. */
  stream?: boolean;
}

export interface ProcessHandle {
  /** Implementation-defined identifier (pid on local; sandbox-specific elsewhere). */
  readonly id: string;
  /** Send stdin data (newline included if you want it). */
  write(input: string): Promise<void>;
  /** Send a signal — SIGTERM=15, SIGKILL=9. */
  signal(sig: number): Promise<void>;
  /** Wait for exit; resolves to final ShellResult. */
  wait(): Promise<ShellResult>;
  /** Stream stdout chunks as they arrive (only available when spawned with `stream: true`). */
  stdout?: AsyncIterable<string>;
  /** Stream stderr chunks. */
  stderr?: AsyncIterable<string>;
}

export interface PtyHandle {
  /** Send user input (raw bytes). */
  write(data: string): Promise<void>;
  /** Resize the underlying terminal. */
  resize(cols: number, rows: number): Promise<void>;
  /** Stream of output chunks (terminal output, including ANSI escapes). */
  readonly output: AsyncIterable<string>;
  /** Close the pty session. */
  close(): Promise<void>;
}

/**
 * The unified sandbox contract.
 *
 * Implementations MUST provide: id, kind, capabilities, connect/disconnect,
 * isAvailable, exec, and the core filesystem methods (readFile, writeFile,
 * readdir, stat, exists, mkdir, rm).
 *
 * Optional surfaces (spawn, ports, pty) declare a richer capability when
 * the underlying environment supports them — callers feature-detect.
 */
export interface SandboxApi {
  /** Stable, opaque identifier. Used for preview-URL routing and telemetry. */
  readonly id: string;
  /** Discriminator for type-narrowing and UI badges. */
  readonly kind: SandboxKind;
  /** Declared capabilities. Used by the orchestrator to gate tool descriptions. */
  readonly capabilities: ReadonlySet<SandboxCapability>;

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Open the connection (start container, attach WebSocket, etc). Idempotent. */
  connect(): Promise<void>;
  /** Close the connection. Idempotent. */
  disconnect(): Promise<void>;
  /** True iff exec/readFile/writeFile are likely to succeed right now. */
  isAvailable(): boolean;

  // ── Shell ───────────────────────────────────────────────────────

  exec(command: string, options?: ExecOptions): Promise<ShellResult>;

  // ── Filesystem ──────────────────────────────────────────────────

  readFile(path: string): Promise<string>;
  readFileBuffer?(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<Stat | null>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  // ── Optional: long-running processes ────────────────────────────

  spawn?(command: string, options?: SpawnOptions): Promise<ProcessHandle>;

  // ── Optional: port exposure (preview URLs, tunnels) ─────────────

  listPorts?(): Promise<PortInfo[]>;
  exposePort?(port: number, options?: { name?: string }): Promise<PortInfo>;
  unexposePort?(port: number): Promise<void>;

  // ── Optional: pty session for terminal UI ───────────────────────

  attachPty?(options?: { cols?: number; rows?: number }): Promise<PtyHandle>;
}

/**
 * Build context passed to factory.build(). Implementations destructure
 * what they need (env bindings, agent name, hostname, etc).
 *
 * Kept open via index signature so platform-specific factories can accept
 * platform-specific bindings (e.g. `loader`, `aiBinding`) without forcing
 * core to know about them.
 */
export interface SandboxBuildContext {
  /** Stable identifier for this agent / instance. Becomes the sandbox id. */
  readonly agentId: string;
  /** Optional public hostname for preview-URL construction. */
  readonly previewHostname?: string;
  /** Platform-specific bindings/env. */
  readonly env?: Record<string, unknown>;
  /** Arbitrary extra options (e.g. Nimbus endpoint, JWT, SSH socket factory). */
  readonly options?: Record<string, unknown>;
}

/**
 * A factory builds SandboxApi instances on demand.
 *
 * Registered with the SandboxRegistry under a namespace (e.g. "sandbox",
 * "nimbus", "laptop"). On first use the orchestrator calls `factory.build(ctx)`
 * to materialize the API.
 */
export interface SandboxFactory {
  readonly kind: SandboxKind;
  /** Default namespace this factory registers under (e.g. "workspace", "sandbox"). */
  readonly defaultNamespace: string;
  /**
   * Build a connected SandboxApi from the given context.
   *
   * Throws on configuration error (missing binding, bad opts).
   * Returns a SandboxApi that is connected (or will lazily connect on first use).
   */
  build(ctx: SandboxBuildContext): Promise<SandboxApi>;
}

/**
 * The registry holds all sandboxes available to the agent.
 *
 * Each is registered under a namespace, which is also the codemode tool
 * prefix (workspace.*, sandbox.*, nimbus.*, laptop.*, local.*).
 */
export interface SandboxRegistry {
  /** Register a built SandboxApi under a namespace. Replaces any prior entry. */
  register(namespace: string, api: SandboxApi): void;
  /** Unregister and (if held) disconnect a sandbox. */
  unregister(namespace: string): Promise<void>;
  /** Look up a sandbox by namespace. */
  get(namespace: string): SandboxApi | undefined;
  /** All registered sandboxes (in registration order). */
  list(): Array<{ namespace: string; api: SandboxApi }>;
  /** Subset of `list()` that report isAvailable(). */
  available(): Array<{ namespace: string; api: SandboxApi }>;
}

/**
 * Common error shape for sandbox operations.
 *
 * SandboxApi methods throw this on hard failures (connection lost, auth
 * rejected, path traversal). For exec-level failures (non-zero exit codes,
 * timeouts) callers should inspect ShellResult.exitCode/aborted instead.
 */
export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_available' | 'auth' | 'protocol' | 'not_found' | 'permission' | 'timeout' | 'internal',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** Type-guard for SandboxError. */
export function isSandboxError(err: unknown): err is SandboxError {
  return err instanceof SandboxError;
}
