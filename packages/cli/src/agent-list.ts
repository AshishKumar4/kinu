import {
  listAgentDirs,
  listConfiguredAgentRefs,
  requireAuthConfig,
  updateConfigFile,
  type AgentMode,
  type KinuAgentConfig,
} from './config';
import { listCloudAgents, type CloudAgent } from './cloud-api';

export interface ListedAgent {
  name: string;
  label: string;
  mode: AgentMode;
  localName?: string;
  cloudName?: string;
}

export function reconcileAgentRefs(
  localAgentNames: readonly string[],
  configuredAgents: readonly KinuAgentConfig[],
  cloudAgents: readonly CloudAgent[],
): ListedAgent[] {
  const localConfig = new Map(
    configuredAgents
      .filter((agent) => agent.mode === 'local')
      .map((agent) => [agent.localName ?? agent.name, agent]),
  );
  const local = [...new Set(localAgentNames)].map((name) => {
    const configured = localConfig.get(name);
    return {
      name,
      label: configured?.displayName ?? name,
      mode: 'local' as const,
      localName: name,
      cloudName: configured?.cloudName,
    };
  });

  const seenCloudNames = new Set<string>();
  const cloud = cloudAgents.flatMap((agent) => {
    if (seenCloudNames.has(agent.name)) return [];
    seenCloudNames.add(agent.name);
    return [{
      name: agent.name,
      label: agent.displayName,
      mode: 'cloud' as const,
      cloudName: agent.name,
    }];
  });

  return [...local, ...cloud];
}

export function listKnownAgents(): ListedAgent[] {
  const localAgents = new Set(listAgentDirs());
  const configured = new Map(listConfiguredAgentRefs().map((agent) => [agent.name, agent]));
  return [
    ...[...localAgents].map((name) => {
      const agent = configured.get(name);
      return { name, label: agent?.displayName ?? name, mode: 'local' as const, localName: name, cloudName: agent?.cloudName };
    }),
    ...listConfiguredAgentRefs()
      .filter((agent) => agent.mode === 'cloud' || !localAgents.has(agent.localName ?? agent.name))
      .map((agent) => ({
        name: agent.name,
        label: agent.mode === 'cloud'
          ? `${agent.displayName ?? agent.name} (cloud)`
          : agent.displayName ?? agent.name,
        mode: agent.mode,
        localName: agent.localName,
        cloudName: agent.cloudName,
      })),
  ];
}

export async function syncCloudAgentRefs(): Promise<ListedAgent[]> {
  const { origin, token } = requireAuthConfig();
  const cloudAgents = await listCloudAgents(origin, token);
  const now = new Date().toISOString();
  updateConfigFile((config) => {
    const current = config.agents ?? {};
    const cloudNames = new Set(cloudAgents.map((agent) => agent.name));
    const next: Record<string, KinuAgentConfig> = {};
    for (const [name, agent] of Object.entries(current)) {
      if (agent.mode === 'cloud' && !cloudNames.has(agent.cloudName ?? agent.name)) continue;
      next[name] = agent;
    }
    for (const agent of cloudAgents) {
      const existing = next[agent.name];
      next[agent.name] = {
        ...existing,
        name: agent.name,
        mode: 'cloud',
        displayName: agent.displayName,
        cloudName: agent.name,
        createdAt: existing?.createdAt ?? new Date(agent.createdAt || Date.now()).toISOString(),
        updatedAt: now,
      };
    }
    config.agents = next;
    if (config.aliases) {
      for (const [alias, target] of Object.entries(config.aliases)) {
        const agent = next[target];
        if (!agent || (agent.mode === 'cloud' && !cloudNames.has(agent.cloudName ?? agent.name))) {
          delete config.aliases[alias];
        }
      }
    }
  });
  return listKnownAgents();
}
