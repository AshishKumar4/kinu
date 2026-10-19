/**
 * Whom the work in progress runs for, as the owner's secrets see it: the owner, or anyone else (a share's viewer, a
 * shared slate's server), who holds none of them. Carried with the work, as its work mode is (`work-mode.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import type { CodemodeProvider } from '../types/codemode';

/** Whom a command runs for: the workspace's owner, or anyone else, who holds none of the owner's secrets. */
export type SecretsCaller = 'owner' | 'viewer';

const calling = new AsyncLocalStorage<SecretsCaller>();

export const COMPUTER_OWNER_ONLY = "The owner's computer is unavailable to a share's viewer: its files and processes can hold the owner's credentials, "
  + "and its network cannot distinguish viewer requests from the owner's";

/** The caller of the work in progress; the owner where no viewer's call began it. */
export function secretsCaller(): SecretsCaller {
  return calling.getStore() ?? 'owner';
}

/** `operation` as `caller`, narrowing only: work a viewer's call began never becomes the owner's. */
export function asSecretsCaller<Result>(caller: SecretsCaller, operation: () => Result): Result {
  return calling.run(secretsCaller() === 'viewer' ? 'viewer' : caller, operation);
}

/** `operation` and everything it starts, run for no owner. */
export function withholdingOwnerSecrets<Result>(operation: () => Result): Result {
  return calling.run('viewer', operation);
}

/** The computer's native calls, including its mounted file plane, never act for a viewer. */
export function ownerComputerCall<Result>(operation: () => Promise<Result>): Promise<Result> {
  if (secretsCaller() === 'viewer') return settle(Effect.fail(new KinuError('denied', COMPUTER_OWNER_ONLY)));

  return operation();
}

/** Namespaces whose members run for no owner, wherever they are called from: a program's call back into them included. */
export function providersWithoutOwnerSecrets(providers: readonly CodemodeProvider[]): CodemodeProvider[] {
  return providers.map((provider) => ({
    ...provider,
    ...(provider.name === 'computer' && { summary: COMPUTER_OWNER_ONLY }),
    tools: Object.fromEntries(Object.entries(provider.tools).map(([name, entry]) => [name, {
      ...entry,
      execute: (...args: unknown[]) => withholdingOwnerSecrets(() => entry.execute(...args)),
    }])),
  }));
}
