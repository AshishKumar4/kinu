/**
 * The workspace filesystem: Nimbus, and nothing layered over it.
 */

export {
  createWorkspace, nextWorkspaceGeneration,
  type WorkspaceBundle, type WorkspaceOptions, type WorkspaceVFS,
} from './nimbus-workspace';
export { workspacePath, WORKSPACE_ROOT } from './workspace-path';
export {
  agentHome, agentTmpRoot, agentCred, agentIdentity,
  provisionAgentHome, confineAgentTmp,
  MAIN_AGENT, AGENT_HOME_MODE, AGENT_TMP_MODE, SESSION_UID, AGENT_UID_FLOOR,
  type AgentIdentity, type HomeRootVfs, type TmpConfiner,
} from './agent-home';
export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './errno';
export { observeWrites, type WriteEvent, type WriteObserver } from './observe';
