/**
 * The `kinu-<workspace>` sandbox-id policy.
 *
 * The KV exposure projection this prefix guards moved to
 * `@kinu.run/core/preview/preview-exposures`; what stays here is the spelling
 * of the deployment's container ids, which the shared record cannot know —
 * a workspace's name is judged by `user/validate.ts`, the adapter-side grammar
 * the DO id system is admitted against, not the preview-hostname grammar core
 * owns.
 */

import { isWorkspaceName } from '../user/validate';

/** Every container this deployment addresses is `kinu-<workspace>`. One
 *  spelling, in one place, because the edge refuses every id that is not it. */
const SANDBOX_ID_PREFIX = 'kinu-';

/**
 * The container id that serves a workspace's sandbox executor.
 *
 * The SDK lowercases ids it resolves (`normalizeId`), and hostnames are
 * lower-case, so every read of this record normalizes too — a workspace named
 * `Hello` and the label `kinu-hello` are one container.
 */
export function sandboxIdForWorkspace(workspaceName: string): string {
  return `${SANDBOX_ID_PREFIX}${workspaceName}`;
}

/**
 * Whether a hostname's sandbox id is the shape this deployment mints.
 *
 * The SDK admits any id of up to 63 characters, so without this the guess space
 * is every such string; with it, the space is the workspace namespace, and the
 * shared exposure record is what narrows that to exposures that exist.
 */
export function isKinuSandboxId(sandboxId: string): boolean {
  if (!sandboxId.startsWith(SANDBOX_ID_PREFIX)) return false;

  return isWorkspaceName(sandboxId.slice(SANDBOX_ID_PREFIX.length));
}
