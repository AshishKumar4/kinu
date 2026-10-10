/** Types for the built bundle exports used by the measurement wrapper. */
declare module 'kinu:product' {
  export const OrchestratorAgent: typeof import('../../packages/cf-backend/src/orchestrator').OrchestratorAgent;
  export const AgentWorkspaceRPC: typeof import('../../packages/cf-backend/src/agent-facets').AgentWorkspaceRPC;
  export const UserDO: typeof import('../../packages/cf-backend/src/user/user-do').UserDO;
  const handler: ExportedHandler;
  export default handler;
}
