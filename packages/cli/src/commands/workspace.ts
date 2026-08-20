import { resolveAgentTarget } from '../agent-target';
import { deleteCloudAgent } from '../cloud-api';
import { removeCloudAgentConfig, requireStoredAuthConfig } from '../config';
import { ACCENT, DIM, OK } from '../display';
import { canPrompt, confirm } from '../prompt';

export async function workspaceDeleteCommand(name: string, opts: { yes?: boolean }): Promise<void> {
  const target = resolveAgentTarget(name);
  if (target.mode !== 'cloud') {
    throw new Error(`Workspace "${name}" is local. This command deletes cloud workspaces only.`);
  }

  if (!opts.yes) {
    if (!canPrompt()) {
      throw new Error('Workspace deletion requires confirmation. Re-run with --yes in a non-interactive environment.');
    }
    console.log(DIM(`Deletion is permanent. Keep a copy first: kinu export ${target.cloudName}`));
    if (!(await confirm(`Permanently delete cloud workspace "${target.cloudName}"?`, false))) {
      console.log(DIM('Workspace deletion cancelled.'));
      return;
    }
  }

  const auth = requireStoredAuthConfig();
  await deleteCloudAgent(auth.origin, auth.token, target.cloudName);
  const pruned = removeCloudAgentConfig(target.cloudName);
  console.log(`${OK('✓')} Deleted cloud workspace ${ACCENT(target.cloudName)}`);
  if (pruned) console.log(DIM('Removed its local config reference.'));
}
