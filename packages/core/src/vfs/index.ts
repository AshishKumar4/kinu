/**
 * The workspace filesystem: Nimbus, and nothing layered over it.
 */

export {
  createWorkspace, nextWorkspaceGeneration,
  type WorkspaceBundle, type WorkspaceOptions, type WorkspaceVFS,
} from './nimbus-workspace';
export { workspacePath, WORKSPACE_ROOT } from './workspace-path';
export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './errno';
export { observeWrites, type WriteEvent, type WriteObserver } from './observe';
