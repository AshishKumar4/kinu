import { isWorkspaceName } from '../identity/naming';

const SANDBOX_ID_PREFIX = 'kinu-';

export function sandboxIdForWorkspace(workspaceName: string): string {
  return `${SANDBOX_ID_PREFIX}${workspaceName}`;
}


/** Only registered workspace names address Kinu containers. */
export function isKinuSandboxId(sandboxId: string): boolean {
  if (!sandboxId.startsWith(SANDBOX_ID_PREFIX)) return false;

  return isWorkspaceName(sandboxId.slice(SANDBOX_ID_PREFIX.length));
}
