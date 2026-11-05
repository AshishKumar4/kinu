/** Which backend, database, and project a command acts on. */

import { existsSync } from 'node:fs';
import {
  agentDbPath,
  missingLocalWorkspace,
  resolveAgentRef,
  resolveLocalAgent,
  type LocalAgentRef,
} from './config';
import { resolveAgentTarget, type AgentTarget, type ResolveAgentTargetOptions } from './agent-target';
import { printError } from './display';

/** A missing workspace is a usage error with its hint; every other refusal propagates. */
export function requireLocalAgent(name: string): LocalAgentRef {
  const missing = missingLocalWorkspace(name);

  if (missing !== null) {
    printError(`Workspace "${missing}" not found.`, `Create it with: kinu create ${missing}`);
    process.exit(1);
  }

  return resolveLocalAgent(name);
}

/** Cloud targets need a configured ref: the account list is server-side. */
export function agentTargetExists(target: AgentTarget): boolean {
  return target.mode === 'local'
    ? existsSync(agentDbPath(target.localName))
    : resolveAgentRef(target.requestedName) !== null;
}

export function requireAgentTarget(name: string, opts: ResolveAgentTargetOptions = {}): AgentTarget {
  const target = resolveAgentTarget(name, opts);

  if (!agentTargetExists(target)) {
    printError(`Workspace "${name}" not found.`, `Create it with: kinu create ${name}`);
    process.exit(1);
  }

  return target;
}
