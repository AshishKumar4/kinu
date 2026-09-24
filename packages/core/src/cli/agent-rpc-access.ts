/**
 * Remote-RPC policy shared by client and server: each workspace method and the credential it needs. A CLI call
 * off the table does not compile. An unlisted method is unreachable over HTTP (`/api/cli/workspaces/:name/rpc`)
 * and session-only over WebSocket, where a scoped `pta_…` socket reaches only its scope's rows.
 */
import * as v from 'valibot';
import { ACCESS_TOKEN_SCOPES, type AccessTokenScope } from './access-tokens';

export type AgentRpcAccess = AccessTokenScope | 'interactive' | 'never';

/** What a read-only token must not reach is 'interactive' on every transport, never approximated as a read. */
export const AGENT_RPC_ACCESS = {
  getAgentStatus: 'workspace.read',
  getAlignmentConvergence: 'workspace.read',
  getChatHistoryPage: 'workspace.read',
  getExecutors: 'workspace.read',
  getGepaRun: 'workspace.read',
  getGepaRuns: 'workspace.read',
  getForkRun: 'workspace.read',
  getExplorationCanvas: 'workspace.read',
  getHeadRun: 'workspace.read',
  getHeadRuns: 'workspace.read',
  getMctsNodeDetail: 'workspace.read',
  getNodeTranscript: 'workspace.read',
  getMctsSearchRuns: 'workspace.read',
  getMctsTree: 'workspace.read',
  getMemoryContent: 'workspace.read',
  getOutcomeCalibration: 'workspace.read',
  getOutcomeEnsemble: 'workspace.read',
  getReleaseBoard: 'workspace.read',
  getRunTimeline: 'workspace.read',
  getSearchTree: 'workspace.read',
  getActivePlanReview: 'workspace.read',
  getStoredModelSpec: 'workspace.read',
  getReasoningEffort: 'workspace.read',
  getToolDescriptions: 'workspace.read',
  getWorkspaceSnapshot: 'workspace.read',
  getWorkspaceTabPresence: 'workspace.read',
  listAgentTasks: 'workspace.read',
  listWorkspaceWork: 'workspace.read',
  listSlates: 'workspace.read',
  listBackgroundJobs: 'workspace.read',
  listForkRuns: 'workspace.read',
  listPendingConsents: 'workspace.read',
  listRecentEvents: 'workspace.read',
  listRecordCells: 'workspace.read',
  listRecordObjectives: 'workspace.read',
  readRecordCell: 'workspace.read',
  listTriggers: 'workspace.read',
  sampleOutcomeLabeling: 'workspace.read',
  searchMemoryHybrid: 'workspace.read',

  cancelCurrentWork: 'workspace.exec',
  recoverStrandedTurn: 'workspace.exec',
  executeInExecutor: 'workspace.exec',

  applyScaffoldDecision: 'interactive',
  branchTurn: 'interactive',
  cancelBackgroundJob: 'interactive',
  cancelTrigger: 'interactive',
  checkpointStatus: 'interactive',
  getEvolutionChangelog: 'interactive',
  listSubordinates: 'interactive',
  inspectSubordinate: 'interactive',
  latestAlternateTakes: 'interactive',
  listFileCheckpoints: 'interactive',
  listMounts: 'interactive',
  planFileRestore: 'interactive',
  clearBackgroundJobs: 'interactive',
  createReleaseChange: 'interactive',
  createTimerTrigger: 'interactive',
  decideReleaseApproval: 'interactive',
  // The call is the approval: a scoped token would bypass the gate.
  decideDeferredApprovals: 'interactive',
  // Authored code acts through the agent's bindings, behind the ordinary side-effect gates.
  slate: 'interactive',
  previewSlate: 'interactive',
  // KINU-N028: approval grants bytes system placement, so a scoped token must not let agent-written bytes
  // authorise themselves.
  approveInstruction: 'interactive',
  revokeInstruction: 'interactive',
  listInstructionApprovals: 'interactive',
  readInstructionApproval: 'interactive',
  // Spends child-agent inference and writes user preferences into memory: the owner's call.
  requestRefinement: 'interactive',
  listRefinements: 'interactive',
  // Grants staged bytes system placement, like `approveInstruction`.
  decideRefinement: 'interactive',
  showRefinement: 'interactive',
  createSubordinateAgent: 'interactive',
  renameSubordinateAgent: 'interactive',
  decidePlanReview: 'interactive',
  listDeferredApprovals: 'interactive',
  savePlanReviewAnnotations: 'interactive',
  dismissBackgroundJob: 'interactive',
  dismissSubordinate: 'interactive',
  // A CI token that runs tasks must not take the whole database.
  exportWorkspaceArchive: 'interactive',
  experienceAction: 'interactive',
  forkAgent: 'interactive',
  revertConversation: 'interactive',
  getActivitySnapshot: 'interactive',
  getAlwaysActiveSkills: 'interactive',
  getExecutorDiff: 'interactive',
  getExecutorFiles: 'interactive',
  getExposedPorts: 'interactive',
  getFacts: 'interactive',
  getEvolutionConfig: 'interactive',
  getMctsConfig: 'interactive',
  getReplayEvals: 'interactive',
  // Raw unredacted event payloads; a workspace.read token gets only the read models.
  getRunEvents: 'interactive',
  getRunSummaries: 'interactive',
  listRuns: 'interactive',
  getScaffoldDiff: 'interactive',
  getShadowVerdict: 'interactive',
  getShellApprovalMode: 'interactive',
  getShellApprovalGrants: 'interactive',
  listAlternateTakes: 'interactive',
  listCurriculumTasks: 'interactive',
  // An aggregate is as open as its strictest input (changelog, scaffold archive, curriculum).
  listPendingActions: 'interactive',
  // `decisionsWaiting` counts interactive reads, so the aggregate is interactive too.
  getWorkspaceOverview: 'interactive',
  listScaffoldVersions: 'interactive',
  listTurnFeedback: 'interactive',
  markChangelogSeen: 'interactive',
  pickAlternateTake: 'interactive',
  previewScaffoldLive: 'interactive',
  proposeCurriculumTasks: 'interactive',
  readExecutorFile: 'interactive',
  renameExecutorFile: 'interactive',
  deleteExecutorFile: 'interactive',
  recordOutcomeLabeling: 'interactive',
  resetWorkspaceBaseline: 'interactive',
  restoreWorkspaceBaseline: 'interactive',
  resolveDeviceConsent: 'interactive',
  restoreFileCheckpoint: 'interactive',
  retryBackgroundJob: 'interactive',
  revertChangelogEntry: 'interactive',
  revokeShellApprovalGrants: 'interactive',
  runOutcomeEnsemble: 'interactive',
  runScaffoldGepaOptimization: 'interactive',
  setAlwaysActiveSkills: 'interactive',
  setCurriculumTaskStatus: 'interactive',
  setDisplayName: 'interactive',
  setEvolutionConfig: 'interactive',
  setMctsConfig: 'interactive',
  setModel: 'interactive',
  setActorModel: 'interactive',
  setRole: 'interactive',
  setReasoningEffort: 'interactive',
  setShellApprovalMode: 'interactive',
  setSoul: 'interactive',
  setTurnFeedback: 'interactive',
  send: 'interactive',

  destroyAgent: 'never',
} as const satisfies Record<string, AgentRpcAccess>;

export type AgentRpcMethod = keyof typeof AGENT_RPC_ACCESS;

export function isAgentRpcMethod(method: string): method is AgentRpcMethod {
  return Object.hasOwn(AGENT_RPC_ACCESS, method);
}

/** Null when the method is off-table (never dispatch it). */
export function requiredRpcAccess(method: string): AgentRpcAccess | null {
  return isAgentRpcMethod(method)
    ? AGENT_RPC_ACCESS[method]
    : null;
}

export function rpcAccessScope(access: AgentRpcAccess | null): AccessTokenScope | null {
  return v.is(v.picklist(ACCESS_TOKEN_SCOPES), access) ? access : null;
}
