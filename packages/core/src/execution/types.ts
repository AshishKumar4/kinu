/**
 * Execution layer types: executors are codemode ToolProviders. docs/EXECUTION-LAYER-SPEC.md
 * Lean formalization: lean/Kinu/Execution/Capabilities.lean
 */

import type { VFS } from '../types/primitives';
import type { JsonValue } from '../utils/json';
import type { DeviceSandboxStatus } from './device-status';

/**
 * "No work deadline" for a mechanism that insists on a timer: the largest `setTimeout` delay; larger values
 * fire immediately. Not a policy bound (PLATFORM_CATALOG `worker.wall.http_unlimited`); RPC lanes use `timeoutMs: 0`.
 */
export const NO_TIMER_DEADLINE_MS = 2_147_483_647;

export type ExecutorToolResult = JsonValue | undefined;

export interface ExecutorTool {
  description: string;
  /** Explicit producer contract: this operation is safe for Plan inspection/research. */
  planAllowed?: boolean;
  execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
}

export interface ExecutorProviderSurface {
  name: string;
  tools: Record<string, ExecutorTool>;
  types?: string;
  positionalArgs?: boolean;
}

/** Render order for a capability set; load-bearing, since iteration order would re-fingerprint the dynamic-context block. */
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

export type ExecutorKind = 'workspace' | 'nimbus' | 'sandbox' | 'device' | 'parent';

export type ExecutorLifecycleStatus =
  | 'not_configured'
  | 'idle'
  | 'active'
  | 'disconnected'
  | 'error';

/** Measured (cgroup) limits only: `nproc` inside a cgroup reports host cores. Absent when unknown. */
export interface ResourceLimits {
  /** Quota/period rounded up to a whole worker. Absent when the cgroup sets no cap. */
  readonly cpus?: number;
  readonly memBytes?: number;
}

export interface ExecutorStatus {
  configured: boolean;
  available: boolean;
  /** A real remote session/container/device was touched this activation. */
  active: boolean;
  status: ExecutorLifecycleStatus;
  reason?: string;
  /** User-chosen environment name (e.g. a linked device); absent for workspace/sandbox. */
  label?: string;
  /** Whether this agent holds the access grant; only consent-gated environments answer. */
  granted?: boolean;
  /** Device sandbox mode; absent for non-device environments. */
  sandbox?: DeviceSandboxStatus;
}

/** An executor registered as a named codemode provider; matches @cloudflare/codemode's ToolProvider shape. */
export interface ExecutorProvider {
  readonly name: string;

  readonly kind: ExecutorKind;

  /**
   * This environment's files in its own native paths, over the raw handle (not its lossy LLM tools).
   * Mounted into the workspace via vfs/mounts.ts, so consent and path scoping hold on mounted paths.
   */
  readonly files?: VFS;

  /**
   * Absolute directory relative paths resolve against; asked, never guessed. A multi-machine plane
   * (`/pc/<name>`) opens on its roster with no segment, else on that machine's home.
   */
  homeDir(segment?: string): Promise<string>;

  readonly capabilities: ReadonlySet<ExecutorCapability>;

  /** Capabilities that can be neither claimed nor ruled out (e.g. GPU on a tunnelled machine). Disjoint from `capabilities`. */
  readonly unmeasuredCapabilities?: ReadonlySet<ExecutorCapability>;

  /** Measured limits of the process environment; omitted when unknown. */
  readonly resourceLimits?: ResourceLimits;

  isAvailable(): boolean;

  /** Must be cheap: no remote RPCs; dashboard loads must not provision sandboxes. */
  getStatus?: () => ExecutorStatus;

  connect: () => Promise<void>;

  disconnect: () => Promise<void>;

  /**
   * Tools exposed in the codemode sandbox (codemode SimpleToolRecord shape). `exec` accepts a trailing
   * `{ signal }`; cancellation strength per transport is documented only in execution/signal.ts.
   */
  readonly tools: Record<string, ExecutorTool>;

  /** TypeScript declarations for the LLM; auto-generated if omitted. */
  readonly types?: string;

  readonly positionalArgs?: boolean;

  /** The public preview URL and what the preview route's own gates answered for it, or `{supported: false}`. */
  exposePort?: (port: number, opts?: { name?: string }) => Promise<PortExposureResult>;

  /** No-op if the port wasn't exposed. */
  unexposePort?: (port: number) => Promise<void>;

  listExposedPorts?: () => Promise<ExposedPortInfo[]>;
}

/** An executor that implements all three port methods (possibly answering `supported: false`). */
export type PortAnsweringExecutor =
  ExecutorProvider
  & Required<Pick<ExecutorProvider, 'exposePort' | 'unexposePort' | 'listExposedPorts'>>;

/** The preview route's own gates for a URL, run without calling the server. */
export type PreviewRouteCheck =
  | { readonly reached: true }
  | { readonly reached: false; readonly gate: string; readonly detail: string };

export type PortExposureResult =
  | {
      supported: true;
      url: string;
      port: number;
      name?: string;
      route: PreviewRouteCheck;
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
  /** Capabilities this environment cannot answer for either way. */
  unmeasuredCapabilities?: string[];
  available: boolean;
  configured: boolean;
  active: boolean;
  status: ExecutorLifecycleStatus;
  reason?: string;
  resourceLimits?: ResourceLimits;
  /** User-chosen machine name; user-facing surfaces render this, never the namespace. */
  label?: string;
  granted?: boolean;
  /** Device sandbox mode; absent for non-device environments. */
  sandbox?: DeviceSandboxStatus;
}

/** Manages the provider set passed to createExecuteTool; codemode does the namespace routing. */
export interface ExecutionRouter {
  register(provider: ExecutorProvider): void;

  unregister(name: string): void;

  getProvider(name: string): ExecutorProvider | undefined;

  /** Available providers only, formatted for createExecuteTool's `providers`. */
  getProviders(): ExecutorProviderSurface[];

  listExecutors(): ExecutorInfo[];
}
