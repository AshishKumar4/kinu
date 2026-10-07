/**
 * Inherited members that make an unsealed Durable Object a liability: the SDK's sql runner, storage teardown, state
 * writer and method bridges, and the scheduler, fiber runner and keep-alive that would run a caller's work inside
 * it. `workerd/orchestrator-seal.test.ts` calls each on a real stub, the orchestrator's and the account's.
 */
export const MUST_STAY_DENIED = [
  'sql', 'destroy', 'setState', 'stash',
  '_cf_invokeSubAgent', '_cf_invokeSubAgentPath', '_cf_invokeAgentPath', '_cf_invokeStubMethod',
  'schedule', 'runFiber', 'keepAlive',
] as const;
