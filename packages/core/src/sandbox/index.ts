/**
 * Sandbox abstraction layer — the unified pluggable execution contract.
 *
 * Public surface:
 *   • SandboxApi, SandboxFactory, SandboxRegistry, types
 *   • DefaultSandboxRegistry — the in-memory registry
 *   • sandboxToExecutorProvider — adapter to legacy codemode ExecutorProvider
 *   • Implementations under impls/
 */

export type {
  SandboxApi,
  SandboxFactory,
  SandboxRegistry,
  SandboxBuildContext,
  SandboxKind,
  SandboxCapability,
  ShellResult,
  ExecOptions,
  DirEntry,
  Stat,
  PortInfo,
  SpawnOptions,
  ProcessHandle,
  PtyHandle,
} from './types.js';

export { SandboxError, isSandboxError } from './types.js';

export { DefaultSandboxRegistry } from './registry.js';

export { sandboxToExecutorProvider } from './adapter.js';

// Implementations — re-exported by name for ergonomic imports.
export { createVirtualSandbox, type VirtualSandboxDeps } from './impls/virtual.js';
export { createCloudflareSandbox, type CloudflareSandboxDeps } from './impls/cloudflare.js';
export { createNimbusSandbox, type NimbusSandboxOpts } from './impls/nimbus.js';
export { createSSHSandbox, type SSHSandboxApi } from './impls/ssh.js';
