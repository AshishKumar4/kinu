/**
 * Execution Layer types — capability-based routing for multi-executor agents.
 *
 * Executors are codemode ToolProviders. The LLM writes JS code that calls
 * namespaced APIs: workspace.readFile(), nimbus.exec(), sandbox.startProcess().
 *
 * Architecture: docs/EXECUTION-LAYER-SPEC.md
 * Lean formalization: lean/Proteus/Execution.lean
 */

export type ExecutorCapability =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'native_binary'
  | 'shell'
  | 'npm'
  | 'git'
  | 'docker'
  | 'fs_shared'
  | 'fs_owned'
  | 'net_outbound'
  | 'net_inbound'
  | 'process_spawn'
  | 'process_long'
  | 'process_signal'
  | 'gpu';

export type ExecutorKind = 'workspace' | 'nimbus' | 'sandbox' | 'laptop';

/**
 * An executor that participates in the codemode sandbox as a named provider.
 *
 * Each executor registers its tools under a namespace. Inside the sandbox,
 * the LLM calls executor.toolName(args). The ToolProvider shape matches
 * @cloudflare/codemode's interface exactly.
 */
export interface ExecutorProvider {
  /** Namespace in the codemode sandbox (e.g. "workspace", "nimbus", "sandbox", "laptop") */
  readonly name: string;

  /** Which kind of executor this is */
  readonly kind: ExecutorKind;

  /** Declared capabilities — immutable after construction */
  readonly capabilities: ReadonlySet<ExecutorCapability>;

  /** Check if this executor is currently reachable */
  isAvailable(): boolean;

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
   */
  readonly tools: Record<string, {
    description: string;
    execute: (...args: unknown[]) => Promise<unknown>;
  }>;

  /**
   * TypeScript declarations for the LLM. Auto-generated if omitted,
   * but providing explicit types is more reliable for stubs.
   */
  readonly types?: string;

  /** Whether tool functions take positional args vs single object */
  readonly positionalArgs?: boolean;
}

export interface ExecutorInfo {
  name: string;
  kind: ExecutorKind;
  capabilities: string[];
  available: boolean;
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
  getProviders(): Array<{
    name: string;
    tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    types?: string;
    positionalArgs?: boolean;
  }>;

  /** List all executors with status — for UI display */
  listExecutors(): ExecutorInfo[];
}
