import type { WorkspaceAgent } from './protocol.js';
import type { WorkspaceEntry } from '../user/user-do.js';

/**
 * The workspace agent roster contract behind getWorkspaceAgents: the default
 * orchestrator agent first (always present), then the owner's other
 * workspaces' agents as team peers — self excluded, registry order kept.
 */
export function buildWorkspaceAgents(
  self: { name: string; displayName: string },
  ownerWorkspaces: readonly Pick<WorkspaceEntry, 'name' | 'displayName'>[],
): WorkspaceAgent[] {
  return [
    { name: self.name, displayName: self.displayName, role: 'orchestrator' },
    ...ownerWorkspaces
      .filter((w) => w.name !== self.name)
      .map((w): WorkspaceAgent => ({ name: w.name, displayName: w.displayName, role: 'peer' })),
  ];
}
