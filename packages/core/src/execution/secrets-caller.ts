/**
 * Whom the work in progress runs for, as the owner's secrets see it: the owner, or anyone else (a share's viewer, a
 * shared slate's server), who holds none of them. Carried with the work, as its work mode is (`work-mode.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodemodeProvider } from '../types/codemode';

/** Whom a command runs for: the workspace's owner, or anyone else, who holds none of the owner's secrets. */
export type SecretsCaller = 'owner' | 'viewer';

const calling = new AsyncLocalStorage<SecretsCaller>();

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

/** Namespaces whose members run for no owner, wherever they are called from: a program's call back into them included. */
export function providersWithoutOwnerSecrets(providers: readonly CodemodeProvider[]): CodemodeProvider[] {
  return providers.map((provider) => ({
    ...provider,
    tools: Object.fromEntries(Object.entries(provider.tools).map(([name, entry]) => [name, {
      ...entry,
      execute: (...args: unknown[]) => withholdingOwnerSecrets(() => entry.execute(...args)),
    }])),
  }));
}
