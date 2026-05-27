/**
 * Execution Layer — capability-based multi-executor routing.
 */

export type {
  ExecutorCapability,
  ExecutorKind,
  ExecutorProvider,
  ExecutorInfo,
  ExecutionRouter,
} from './types.js';

export { DefaultExecutionRouter } from './router.js';
export { createInlineExecutor, type InlineExecutorDeps } from './inline.js';
export { createSandboxExecutor, type SandboxHandle } from './sandbox.js';
export { createSSHTunnelExecutor } from './ssh.js';

// Nimbus — WebSocket client for github.com/AshishKumar4/Nimbus.
// Stays in this directory because Nimbus is just another ExecutorProvider.
export { createNimbusExecutor, type NimbusExecutorOpts } from './nimbus.js';
// Container — older raw-Container executor (predates @cloudflare/sandbox).
// Kept for type imports; modern code uses createSandboxExecutor.
export { createContainerExecutor, type ContainerStub } from './container.js';
