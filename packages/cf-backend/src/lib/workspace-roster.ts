import type { WorkspaceEntry } from '../user/user-do';

/** The owner's other workspaces as cross-workspace peers — self excluded. */
export function teamPeers(
  selfName: string,
  ownerWorkspaces: readonly Pick<WorkspaceEntry, 'name' | 'displayName'>[],
): Array<{ name: string; displayName: string }> {
  return ownerWorkspaces
    .filter((w) => w.name !== selfName)
    .map((w) => ({ name: w.name, displayName: w.displayName }));
}
