/**
 * Execution Layer types — capability-based routing for multi-executor agents.
 *
 * Executors are codemode ToolProviders. The LLM writes JS code that calls
 * namespaced APIs: workspace.readFile(), workspace.startProcess(), sandbox.exec().
 *
 * Architecture: docs/EXECUTION-LAYER-SPEC.md
 * Lean formalization: lean/Proteus/Execution/{Capabilities,ToolSystem}.lean
 */

import type { VFS } from '../types/primitives.js';
import type { JsonValue } from '../utils/json.js';

export type ExecutorToolResult = JsonValue | undefined;

export interface ExecutorTool {
  description: string;
  execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
}

export interface ExecutorProviderSurface {
  name: string;
  tools: Record<string, ExecutorTool>;
  types?: string;
  positionalArgs?: boolean;
}

/**
 * Every capability an environment can declare, in the order anything that
 * renders a set must render it: what code runs, then what tooling exists, then
 * what the filesystem and network reach, then what processes may do.
 *
 * A value, not just a union, because the order is load-bearing. The declared
 * set is a `Set` built from a live session's enumeration, so rendering it in
 * iteration order re-fingerprints the dynamic-context block on an ordering
 * change that means nothing, and appends a block per step.
 */
export const EXECUTOR_CAPABILITIES = [
  'javascript',
  'typescript',
  'python',
  'native_binary',
  'shell',
  'npm',
  'git',
  'docker',
  'fs_shared',
  'fs_owned',
  'net_outbound',
  'net_inbound',
  'process_spawn',
  'process_long',
  'process_signal',
  'gpu',
] as const;

export type ExecutorCapability = (typeof EXECUTOR_CAPABILITIES)[number];

export type ExecutorKind = 'workspace' | 'nimbus' | 'sandbox' | 'laptop' | 'parent';

export type ExecutorLifecycleStatus =
  | 'not_configured'
  | 'idle'
  | 'active'
  | 'disconnected'
  | 'error';

/**
 * What an executor's environment actually grants a process, when the
 * environment says so. Reported only where it is MEASURED — a container's
 * cgroup — because the failure this exists to prevent is a confident guess:
 * `nproc` inside a 1-CPU cgroup reports the host's cores, so `make -j$(nproc)`
 * forks 32 compilers into 2GB and the OOM killer ends the task. An executor
 * with no declared limits carries none, and the prompt says nothing.
 */
export interface ResourceLimits {
  /** CPUs the cgroup allows, quota/period rounded UP to a whole worker (a
   *  0.5-CPU quota still runs one job). Absent when the cgroup sets no cap. */
  readonly cpus?: number;
  /** Memory cap in bytes. Absent when the cgroup sets no cap. */
  readonly memBytes?: number;
}

export interface ExecutorStatus {
  /** Binding/config exists, so the executor can be selected/provisioned. */
  configured: boolean;
  /** Callable right now from the agent's perspective. */
  available: boolean;
  /** A real remote session/container/device has been touched this activation. */
  active: boolean;
  status: ExecutorLifecycleStatus;
  reason?: string;
}

/**
 * An executor that participates in the codemode sandbox as a named provider.
 *
 * Each executor registers its tools under a namespace. Inside the sandbox,
 * the LLM calls executor.toolName(args). The ToolProvider shape matches
 * @cloudflare/codemode's interface exactly.
 */
export interface ExecutorProvider {
  /** Namespace in the codemode sandbox (e.g. "workspace", "sandbox", "laptop") */
  readonly name: string;

  /** Which kind of executor this is */
  readonly kind: ExecutorKind;

  /**
   * This environment's files, in ITS OWN native paths, over the executor's RAW
   * handle — never its LLM tools, whose listings are lossy by design (a mode
   * letter and a name) and whose failures are a refusal payload rather than a
   * throw a `VFS` caller can switch on. Present only where the environment has a
   * filesystem a host can browse; the file manager is the one consumer.
   *
   * Deliberately NOT the agent's own `Storage.vfs`, and never merged into it:
   * one environment, one file view. The agent's own filesystem is Nimbus and
   * has no mount table.
   */
  readonly files?: VFS;

  /**
   * The absolute directory this environment's relative paths resolve against —
   * where its shell starts, and where the file browser opens.
   *
   * Asked, never guessed: a remote machine is the only thing that knows its own
   * home, so this is a call rather than a field and implementations cache it.
   * The alternative the file browser shipped with was a literal `'.'` reported
   * for every environment, which turned "go up one level" into path arithmetic
   * on a token no host could resolve.
   */
  homeDir(): Promise<string>;

  /** Declared capabilities — immutable after construction */
  readonly capabilities: ReadonlySet<ExecutorCapability>;

  /** The measured limits of the environment this executor's processes run in.
   *  Set by whoever supplies that environment (the CLI backend reads its own
   *  cgroup); omitted everywhere the limits are unknown. */
  readonly resourceLimits?: ResourceLimits;

  /** Check if this executor is currently reachable */
  isAvailable(): boolean;

  /**
   * Rich lifecycle state for UI/status surfaces. This must be cheap and must
   * not perform remote RPCs; dashboard loads must not provision sandboxes.
   */
  getStatus?(): ExecutorStatus;

  /** Lifecycle: set up the connection */
  connect(): Promise<void>;

  /** Lifecycle: tear down */
  disconnect(): Promise<void>;

  /**
   * The tools this executor exposes inside the codemode sandbox.
   * Keys are function names, values have description + execute function.
   *
   * This matches codemode's SimpleToolRecord shape so it can be passed
   * directly as a ToolProvider to createExecuteTool({ providers: [...] }).
   *
   * Cancellation contract: in-process callers (the `run` tool) pass a
   * trailing `{ signal }` options argument to `exec`. Implementations honor
   * it at the strongest level their transport supports — the workspace shell
   * stops between commands; remote executors stop waiting and throw an
   * AbortError that says the remote command may still finish (their
   * protocols expose no kill for an in-flight exec). See execution/signal.ts.
   */
  readonly tools: Record<string, ExecutorTool>;

  /**
   * TypeScript declarations for the LLM. Auto-generated if omitted,
   * but providing explicit types is more reliable for stubs.
   */
  readonly types?: string;

  /** Whether tool functions take positional args vs single object */
  readonly positionalArgs?: boolean;

  /**
   * Generic port-exposure surface. Returns the public preview URL when
   * supported, or a `{supported: false}` rejection with a clear reason
   * for executors that can't open inbound ports (for example, laptop).
   *
   * Real implementation: sandbox (via @cloudflare/sandbox SDK).
   *
   * Pre-flight: the sandbox impl verifies a server is responsive on the
   * port BEFORE returning the URL — exposing a port with no listener
   * yields a clear error pointing to `start a server first`, not a
   * broken-iframe failure mode.
   */
  exposePort?(port: number, opts?: { name?: string }): Promise<PortExposureResult>;

  /** Stop exposing a port. No-op if the port wasn't exposed. */
  unexposePort?(port: number): Promise<void>;

  /** List currently-exposed ports for this executor. */
  listExposedPorts?(): Promise<ExposedPortInfo[]>;
}

/** Result of attempting to expose a port. Discriminated by `supported`. */
export type PortExposureResult =
  | {
      supported: true;
      url: string;
      port: number;
      name?: string;
      /** True if a server is verified listening on the port before exposure. */
      verified_listening: boolean;
    }
  | {
      supported: false;
      reason: string;
    };

export interface ExposedPortInfo {
  port: number;
  url: string;
  name?: string;
  status: 'listening' | 'unknown' | 'unreachable';
}

export interface ExecutorInfo {
  name: string;
  kind: ExecutorKind;
  capabilities: string[];
  available: boolean;
  configured: boolean;
  active: boolean;
  status: ExecutorLifecycleStatus;
  reason?: string;
  resourceLimits?: ResourceLimits;
}

/**
 * Manages executor providers for the codemode sandbox.
 *
 * The router doesn't route individual commands — it manages the set of
 * available providers that get passed to createExecuteTool's `providers`
 * param. The codemode sandbox handles the actual namespace routing.
 */
export interface ExecutionRouter {
  /** Register an executor provider */
  register(provider: ExecutorProvider): void;

  /** Unregister by name */
  unregister(name: string): void;

  /** Get a specific executor */
  getProvider(name: string): ExecutorProvider | undefined;

  /**
   * Get all available providers formatted for createExecuteTool's
   * `providers` param. Filters out unavailable executors.
   */
  getProviders(): ExecutorProviderSurface[];

  /** List all executors with status — for UI display */
  listExecutors(): ExecutorInfo[];
}
