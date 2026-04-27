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

// Legacy — shelved pending redesign, kept as type exports only.
export { createNimbusExecutor, type NimbusStub } from './nimbus.js';
export { createContainerExecutor, type ContainerStub } from './container.js';
