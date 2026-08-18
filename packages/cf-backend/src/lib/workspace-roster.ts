import type { WorkspaceAgent } from './protocol';
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

/**
 * The workspace agent roster contract behind getWorkspaceAgents: the default
 * orchestrator first, followed by this workspace's durable subordinates.
 */
export function buildWorkspaceAgents(
  self: { name: string; displayName: string },
  subordinates: readonly { name: string; displayName: string }[],
): WorkspaceAgent[] {
  return [
    { name: self.name, displayName: self.displayName, role: 'orchestrator' },
    ...subordinates.map((subordinate): WorkspaceAgent => ({ ...subordinate, role: 'subordinate' })),
  ];
}
