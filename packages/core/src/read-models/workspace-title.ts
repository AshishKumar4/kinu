/**
 * The workspace's name as a person reads it.
 *
 * A workspace row carries two strings that are easy to conflate: `name`, the
 * slug that is the workspace's address (URLs, RPC routes, `kinu chat <name>`),
 * and `displayName`, the title the owner or the first-prompt titler chose.
 * They conflate because a workspace born without a purpose stores ITS SLUG as
 * `display_name` — that echo is how `handwrought-walnut-4166c321` ended up
 * titled across the owner's header, sidebar and tabs.
 *
 * Every surface that renders a workspace's name answers through
 * {@link workspaceDisplayTitle}: the title when a real one exists,
 * {@link UNTITLED_WORKSPACE_TITLE} when the stored value is absent or is the
 * slug echoed back. The slug itself is never the answer here — where a slug
 * is the answer (an address, an id, a field being edited) the surface reads
 * `name` directly and says so.
 */
import { isPlaceholderWorkspaceTitle } from '../identity/naming';

/** What a workspace nobody has named is called everywhere it is shown. Not
 *  "New" — a workspace nobody named is still untitled a month on — and never
 *  the slug, which is an address a person should not have to read as a name.
 *  Not exported: surfaces ask {@link workspaceDisplayTitle}, which is the
 *  whole answer, and a second import of the bare label is how a surface
 *  starts naming the rule itself. */
const UNTITLED_WORKSPACE_TITLE = 'Untitled workspace';

/** The row's display title. `displayName` when it is a real title; the
 *  untitled label when it is absent, blank, or the slug stored in its place
 *  (the shape `isPlaceholderWorkspaceTitle` rules on for auto-titling, kept
 *  to the same definition so a title the titler would replace is the same
 *  title a person never sees). */
export function workspaceDisplayTitle(
  workspace: { readonly name: string; readonly displayName?: string | null },
): string {
  const title = workspace.displayName?.trim() ?? '';

  return isPlaceholderWorkspaceTitle(title, workspace.name) ? UNTITLED_WORKSPACE_TITLE : title;
}

/** The value a rename field opens with — the STORED title, or "" on an
 *  untitled workspace so a save without edits cannot persist the "Untitled
 *  workspace" label as a name. This is the one place `displayName` outlives
 *  the shown title: the field edits the stored row, not the label. */
export function workspaceTitleDraft(
  workspace: { readonly name: string; readonly displayName?: string | null },
): string {
  return isPlaceholderWorkspaceTitle(workspace.displayName, workspace.name)
    ? ''
    : workspace.displayName ?? '';
}
