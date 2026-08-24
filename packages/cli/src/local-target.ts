/**
 * What a command was asked to act on. One place owns "which backend, which
 * database, in which project", so every command reports a missing workspace the
 * same way and none of them decides placement for itself.
 */

import { existsSync } from 'node:fs';
import {
  MissingLocalWorkspaceError,
  agentDbPath,
  resolveAgentRef,
  resolveLocalAgent,
  type ResolvedLocalAgent,
  type ResolveLocalAgentOptions,
} from './config';
import { resolveAgentTarget, type AgentTarget, type ResolveAgentTargetOptions } from './agent-target';
import { printError } from './display';

/**
 * The local workspace `name` addresses: its database, and the project its file
 * and shell planes bind to. Adopts an unplaced legacy workspace into the
 * calling project unless `adopt: false` says this is a read.
 */
export function requireLocalAgent(name: string, opts: ResolveLocalAgentOptions = {}): ResolvedLocalAgent {
  try {
    return resolveLocalAgent(name, opts);
  } catch (error) {
    if (!(error instanceof MissingLocalWorkspaceError)) throw error;
    printError(error.message, error.hint);
    process.exit(1);
  }
}

/**
 * Whether a target addresses anything at all. A local one needs its database; a
 * cloud one needs a configured ref, because the account's list lives on the
 * server and this machine cannot see it without asking.
 */
export function agentTargetExists(target: AgentTarget): boolean {
  return target.mode === 'local'
    ? existsSync(agentDbPath(target.localName))
    : resolveAgentRef(target.requestedName) !== null;
}

/** The backend `name` addresses, refusing a name that addresses nothing. */
export function requireAgentTarget(name: string, opts: ResolveAgentTargetOptions = {}): AgentTarget {
  const target = resolveAgentTarget(name, opts);
  if (!agentTargetExists(target)) {
    printError(`Workspace "${name}" not found.`, `Create it with: kinu create ${name}`);
    process.exit(1);
  }
  return target;
}
