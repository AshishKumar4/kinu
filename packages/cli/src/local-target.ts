/** Which backend, database, and project a command acts on. */

import { Effect, Cause } from 'effect';
import { settle } from '@kinu.run/core/obs';
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

/** Adopts an unplaced workspace into the calling project unless `adopt: false`. */
export function requireLocalAgent(name: string, opts: ResolveLocalAgentOptions = {}): Promise<ResolvedLocalAgent> {
  return settle(Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.gen(function* () {
      return yield* Effect.promise(async () => resolveLocalAgent(name, opts));
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);

      if (!(error instanceof MissingLocalWorkspaceError)) return yield* Effect.failCause(failed);
      printError(error.message, error.hint);
      process.exit(1);
    }));
  }));
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
