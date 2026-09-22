import { existsSync } from 'node:fs';
import {
  agentDbPath,
  listConfiguredAgentRefs,
  resolveAgentRef,
  type AgentMode,
  type KinuAgentConfig,
} from './config';

export interface AgentTarget {
  requestedName: string;
  name: string;
  mode: AgentMode;
  cloudName: string;
  localName: string;
  /** Only a configured local ref has one; an unplaced workspace gets one when `resolveLocalAgent` adopts it. */
  cwd?: string;
  workspaceId?: string;
}

export interface ResolveAgentTargetOptions {
  backend?: AgentMode;
}

/** A configured ref decides the backend outright. An unconfigured name falls back to evidence and refuses
 * when both a local database and a cloud workspace match. */
export function resolveAgentTarget(input: string, opts: ResolveAgentTargetOptions = {}): AgentTarget {
  const ref = resolveAgentRef(input);

  if (ref) {
    if (opts.backend && opts.backend !== ref.mode) {
      throw new Error(`"${input}" is a configured ${ref.mode} workspace; it cannot be opened as ${opts.backend}.`);
    }

    return {
      requestedName: input,
      name: ref.name,
      mode: ref.mode,
      cloudName: ref.cloudName ?? ref.name,
      localName: ref.localName ?? ref.name,
      cwd: ref.cwd,
      workspaceId: ref.workspaceId,
    };
  }

  if (opts.backend) return bareTarget(input, opts.backend);

  const dbPath = agentDbPath(input);
  const localDb = existsSync(dbPath);
  const cloudRef = localDb ? sameCloudWorkspace(input) : null;

  if (cloudRef) {
    throw new Error(
      `"${input}" names both a local workspace (${dbPath}) and the cloud workspace configured `
      + `as "${cloudRef.name}". Address the cloud one by its configured name, or rename one of them.`,
    );
  }

  return bareTarget(input, localDb ? 'local' : 'cloud');
}

/** A configured cloud workspace this name addresses under a different config
 *  key — the one way an unconfigured name can have two real candidates. */
function sameCloudWorkspace(input: string): KinuAgentConfig | null {
  return listConfiguredAgentRefs()
    .find((agent) => agent.mode === 'cloud' && (agent.cloudName ?? agent.name) === input) ?? null;
}

function bareTarget(input: string, mode: AgentMode): AgentTarget {
  return { requestedName: input, name: input, mode, cloudName: input, localName: input };
}
