/** Which backend, database, and project a command acts on. */

import { existsSync } from 'node:fs';
import {
  MissingLocalWorkspaceError,
  agentDbPath,
  resolveAgentRef,
  resolveLocalAgent,
  type LocalAgentRef,
} from './config';
import { resolveAgentTarget, type AgentTarget, type ResolveAgentTargetOptions } from './agent-target';
import { printError } from './display';

/** A missing workspace is a usage error with its hint; every other refusal propagates. */
export function requireLocalAgent(name: string): LocalAgentRef {
  try {
    return resolveLocalAgent(name);
  } catch (error) {
    if (!(error instanceof MissingLocalWorkspaceError)) throw error;
    printError(error.message, error.hint);
    process.exit(1);
  }
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
