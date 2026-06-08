import { listAgentDirs, listConfiguredAgentRefs, type AgentMode } from './config.js';

export interface ListedAgent {
  name: string;
  label: string;
  mode: AgentMode;
  localName?: string;
  cloudName?: string;
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
