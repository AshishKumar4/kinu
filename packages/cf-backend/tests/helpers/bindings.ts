/**
 * Stand-ins for the platform bindings a route's env declares but the route
 * under test never reaches.
 *
 * A route family's env names every binding the family can read, including the
 * ones a particular path returns before touching. Building those as refusals
 * rather than as quiet stand-ins is what keeps "this path reads no binding" a
 * checked claim: the first reach names the binding and fails the test, instead
 * of resolving a fake nobody asserted on.
 */
import type { KvStore } from '@kinu.run/agent-utils';
import type { UserProfile } from '../../src/user/user-do';
import type { AssetFetcher } from '@kinu.run/core';
import type { ObjectNamespace } from '../../src/bindings';

export function unreachableNamespace<Stub>(binding: string): ObjectNamespace<string, Stub> {
  return {
    idFromName: (name) => { throw new Error(`${binding}.idFromName(${name}): not reachable in this test`); },
    get: (id) => { throw new Error(`${binding}.get(${id}): not reachable in this test`); },
  };
}

export function unreachableKv(binding: string): KvStore {
  const refuse = (verb: string) => (key: string): never => {
    throw new Error(`${binding}.${verb}(${key}): not reachable in this test`);
  };

  return { get: refuse('get'), put: refuse('put'), delete: refuse('delete') };
}

export function unreachableAssets(): AssetFetcher {
  return {
    fetch: (input) => { throw new Error(`ASSETS.fetch(${input.url}): not reachable in this test`); },
  };
}

/** The row `ensureProfile` answers with, as a bootstrap that stores nothing
 *  returns it: the account exists, has no onboarding stamp and owns nothing. */
export function bootstrappedProfile(email: string, displayName: string | null = null): UserProfile {
  return { email, displayName, createdAt: 1, lastSeenAt: 1, onboardedAt: null, workspaceCount: 0 };
}
