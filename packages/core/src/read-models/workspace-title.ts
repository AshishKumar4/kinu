/**
 * The workspace's name as a person reads it. A slug stored as `display_name` is an echo, not a title;
 * surfaces render through {@link workspaceDisplayTitle} and read `name` directly where a slug is meant.
 */
import { isPlaceholderWorkspaceTitle } from '../identity/naming';

/** Not exported: surfaces ask {@link workspaceDisplayTitle} rather than naming the rule themselves. */
const UNTITLED_WORKSPACE_TITLE = 'Untitled workspace';

/** Same placeholder definition as `isPlaceholderWorkspaceTitle`, so a title the titler would replace is
 * one a person never sees. */
export function workspaceDisplayTitle(
  workspace: { readonly name: string; readonly displayName?: string | null },
): string {
  const title = workspace.displayName?.trim() ?? '';

  return isPlaceholderWorkspaceTitle(title, workspace.name) ? UNTITLED_WORKSPACE_TITLE : title;
}

/** The stored title, or "" when untitled so a no-edit save cannot persist the untitled label. */
export function workspaceTitleDraft(
  workspace: { readonly name: string; readonly displayName?: string | null },
): string {
  return isPlaceholderWorkspaceTitle(workspace.displayName, workspace.name)
    ? ''
    : workspace.displayName ?? '';
}
