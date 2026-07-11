import type { WorkspaceAgent } from './protocol.js';
import type { WorkspaceEntry } from '../user/user-do.js';

/** The owner's other workspaces as team peers — self excluded, registry
 *  order kept. Shared by the roster below and the team tool's peer list. */
export function teamPeers(
  selfName: string,
  ownerWorkspaces: readonly Pick<WorkspaceEntry, 'name' | 'displayName'>[],
): Array<{ name: string; displayName: string }> {
  return ownerWorkspaces
    .filter((w) => w.name !== selfName)
    .map((w) => ({ name: w.name, displayName: w.displayName }));
}

/**
 * The workspace agent roster contract behind getWorkspaceAgents: the default
 * orchestrator agent first (always present), then the owner's other
 * workspaces' agents as team peers.
 */
export function buildWorkspaceAgents(
  self: { name: string; displayName: string },
  ownerWorkspaces: readonly Pick<WorkspaceEntry, 'name' | 'displayName'>[],
): WorkspaceAgent[] {
  return [
    { name: self.name, displayName: self.displayName, role: 'orchestrator' },
    ...teamPeers(self.name, ownerWorkspaces).map((p): WorkspaceAgent => ({ ...p, role: 'peer' })),
  ];
}
