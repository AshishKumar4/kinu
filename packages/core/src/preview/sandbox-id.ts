import { isWorkspaceName } from '../identity/naming';

const SANDBOX_ID_PREFIX = 'kinu-';

export function sandboxIdForWorkspace(workspaceName: string): string {
  return `${SANDBOX_ID_PREFIX}${workspaceName}`;
}


/** The workspace whose computer `sandboxId` is, or null for an id no workspace's computer has: only registered
 *  workspace names address Kinu containers. */
export function workspaceOfSandbox(sandboxId: string): string | null {
  const workspace = sandboxId.slice(SANDBOX_ID_PREFIX.length);

  return sandboxId.startsWith(SANDBOX_ID_PREFIX) && isWorkspaceName(workspace) ? workspace : null;
}
