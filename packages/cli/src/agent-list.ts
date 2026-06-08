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
  return [
    ...[...localAgents].map((name) => ({ name, label: name, mode: 'local' as const, localName: name })),
    ...listConfiguredAgentRefs()
      .filter((agent) => agent.mode === 'cloud' || !localAgents.has(agent.localName ?? agent.name))
      .map((agent) => ({
        name: agent.name,
        label: agent.mode === 'cloud' ? `${agent.name} (cloud)` : agent.name,
        mode: agent.mode,
        localName: agent.localName,
        cloudName: agent.cloudName,
      })),
  ];
}
