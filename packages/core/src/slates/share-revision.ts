/**
 * What an `owner` share's approved revision says when someone the owner added to edit changed the slate since
 * (docs/SLATE-SHARING-NIMBUS.md §2). Client-safe: the share sheet reads it.
 */

/** What an `owner` share's approved revision becomes once an editor changes the slate: one no build ever has. */
const EDITED = 'edited-by:';

/**
 * The approved revision an `owner` share holds once someone the owner added to edit changed the slate: no build is ever
 * at it, so the share lends nothing (`serverAuthority`) until its owner approves the reach again, and no later build
 * carries it forward on its own (`SlateController.reapproveOnBuild`).
 */
export function editedRevision(editor: string): string {
  return `${EDITED}${editor}`;
}

/** Who changed the slate since its owner approved this share's reach; null when no editor did. */
export function editedBy(grantRevision: string | null): string | null {
  return grantRevision?.startsWith(EDITED) === true ? grantRevision.slice(EDITED.length) : null;
}
