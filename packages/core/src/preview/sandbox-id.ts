import { isWorkspaceName } from '../identity/naming';

const SANDBOX_ID_PREFIX = 'kinu-';

/** The SDK lowercases ids (`normalizeId`), so `Hello` and `kinu-hello` are one container. */
export function sandboxIdForWorkspace(workspaceName: string): string {
  return `${SANDBOX_ID_PREFIX}${workspaceName}`;
}

/**
 * The transport every sandbox client is opened over (cf `openSandbox`), and the one telemetry reports. Owner
 * decision; the release-config gate holds `SANDBOX_TRANSPORT` in wrangler.jsonc to it.
 */
export const SANDBOX_TRANSPORT = 'rpc' as const;

/** Narrows the SDK's permissive id space to the workspace namespace. */
export function isKinuSandboxId(sandboxId: string): boolean {
  if (!sandboxId.startsWith(SANDBOX_ID_PREFIX)) return false;

  return isWorkspaceName(sandboxId.slice(SANDBOX_ID_PREFIX.length));
}
