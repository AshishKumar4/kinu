/**
 * The workspace's name as a person reads it. A slug stored as `display_name` is an echo, not a title;
 * surfaces render through {@link workspaceDisplayTitle} and read `name` directly where a slug is meant.
 */
import { isPlaceholderWorkspaceTitle, WORKSPACE_TITLE_MAX } from '../identity/naming';
import { nameProblem } from './account';

export { WORKSPACE_TITLE_MAX };

/** Why `input` cannot be a workspace's title, or null: run by the owner's object and by every editor, so they agree. */
export function workspaceTitleProblem(input: string): string | null {
  return nameProblem(input, WORKSPACE_TITLE_MAX);
}

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
