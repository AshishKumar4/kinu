import { existsSync } from 'node:fs';
import { agentDbPath, resolveAgentRef, type AgentMode } from './config';

export interface AgentTarget {
  requestedName: string;
  name: string;
  mode: AgentMode;
  cloudName: string;
  localName: string;
}

export function resolveAgentTarget(input: string): AgentTarget {
  const ref = resolveAgentRef(input);
  if (ref) {
    return {
      requestedName: input,
      name: ref.name,
      mode: ref.mode,
      cloudName: ref.cloudName ?? ref.name,
      localName: ref.localName ?? ref.name,
    };
  }
  const mode: AgentMode = existsSync(agentDbPath(input)) ? 'local' : 'cloud';
  return {
    requestedName: input,
    name: input,
    mode,
    cloudName: input,
    localName: input,
  };
}
