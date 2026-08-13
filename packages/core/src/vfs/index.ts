/**
 * The workspace filesystem: Nimbus, and nothing layered over it.
 */

export {
  createWorkspace, nextWorkspaceGeneration, workspacePath, WORKSPACE_ROOT,
  type WorkspaceBundle, type WorkspaceOptions, type WorkspaceVFS,
} from './nimbus-workspace.js';
export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './errno.js';
export { observeWrites, type WriteEvent, type WriteObserver } from './observe.js';
