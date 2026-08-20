import { statSync } from 'node:fs';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu/core/obs';
import { listCloudAgents } from '../cloud-api';
import { reconcileAgentRefs } from '../agent-list';
import { agentDbPath, listAgentDirs, loadConfigFile, resolveCloudSession } from '../config';
import { printAgentList } from '../display';
import { getLocalAgentInfo } from '../local-inspection';

export async function listCommand(): Promise<void> {
  const localAgents = listAgentDirs();
  const configuredAgents = Object.values(loadConfigFile().agents ?? {});
  const cloudSession = resolveCloudSession();
  const cloudAgents = cloudSession
    ? await listCloudAgents(cloudSession.origin, cloudSession.token)
    : [];
  const agents = reconcileAgentRefs(localAgents, configuredAgents, cloudAgents);

  const agentInfos = agents.map((agent) => {
    if (agent.mode === 'cloud') {
      return {
        name: agent.name,
        mode: agent.mode,
        purpose: agent.label,
        scaffoldVersion: 0,
        toolCount: 0,
        dbSize: undefined,
      };
    }

    const name = agent.localName ?? agent.name;
    try {
      // getLocalAgentInfo degrades field by field (a workspace predating a
      // table still reports everything else), so only an unopenable database
      // reaches the catch.
      const info = getLocalAgentInfo(name);
      return {
        name,
        mode: agent.mode,
        purpose: info.purpose,
        scaffoldVersion: info.scaffoldVersion,
        toolCount: info.craftedToolCount,
        dbSize: statSync(agentDbPath(name)).size,
      };
    } catch (caught) {
      // Handled, and said so: one unopenable workspace must not hide the other
      // nine, but a bare `catch {}` here is how three of the owner's real
      // workspaces read `(error reading)` for months while the actual cause was
      // `no such column: mission`. The reason travels with the row.
      const reason = renderThrownChain({ cause: caught });
      diagnostics.failure(
        'workspace.read_failed',
        toKinuError({ doing: 'reading a local workspace', cause: caught, otherwise: 'io' }),
        { workspace: name },
      );
      return { name, mode: agent.mode, purpose: `(unreadable: ${reason})`, scaffoldVersion: 0, toolCount: 0 };
    }
  });

  printAgentList(agentInfos);
}
