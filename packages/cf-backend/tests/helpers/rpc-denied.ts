/**
 * Inherited members that make an unsealed Durable Object a liability: the SDK's sql runner, storage teardown, state
 * writer and method bridges, and the scheduler, fiber runner and keep-alive that would run a caller's work inside
 * it. `unit-rpc-surface.test.ts` holds every sealed surface to them, and `workerd/orchestrator-seal.test.ts` calls
 * each on a real stub.
 */
export const MUST_STAY_DENIED = [
  'sql', 'destroy', 'setState', 'stash',
  '_cf_invokeSubAgent', '_cf_invokeSubAgentPath', '_cf_invokeAgentPath', '_cf_invokeStubMethod',
  'schedule', 'runFiber', 'keepAlive',
] as const;
