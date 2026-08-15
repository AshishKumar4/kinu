/**
 * The workspace filesystem: Nimbus, and nothing layered over it.
 */

export {
  createWorkspace, nextWorkspaceGeneration,
  type WorkspaceBundle, type WorkspaceOptions, type WorkspaceVFS,
} from './nimbus-workspace.js';
export { workspacePath, WORKSPACE_ROOT } from './workspace-path.js';
export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './errno.js';
export { observeWrites, type WriteEvent, type WriteObserver } from './observe.js';
