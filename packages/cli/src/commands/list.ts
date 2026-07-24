import { statSync } from 'node:fs';
import { listCloudAgents } from '../cloud-api.js';
import { reconcileAgentRefs } from '../agent-list.js';
import { agentDbPath, listAgentDirs, loadConfigFile, resolveCloudSession } from '../config.js';
import { printAgentList } from '../display.js';
import { getLocalAgentInfo } from '../local-inspection.js';

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
    } catch {
      return { name, mode: agent.mode, purpose: '(error reading)', scaffoldVersion: 0, toolCount: 0 };
    }
  });

  printAgentList(agentInfos);
}
