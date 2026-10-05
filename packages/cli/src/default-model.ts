/** Every default-tier write, each spelling its model as the bootstrap envelope does: resolution matches it exactly. */

import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { BUILTIN_PROFILE_CATALOG, type ProfileCatalogEnvelope, type ReasoningEffort, type TierAssignment } from '@kinu.run/core';
import { defaultSpecForEndpoint } from '@kinu.run/cli-backend';
import { firstOpenAiCompatModel, resolveLLMConfig } from './config';
import { createConfiguredLocalModelResolver } from './local-model-resolver';
import {
  loadLocalProfileAuthority, readAccountProfile, readDefaultTier, resolveProfileAuthority, writeAccountProfile,
  writeLocalProfile,
} from './profiles';

function spell(model: string): string {
  return createConfiguredLocalModelResolver().resolver.normalizeSpecSync(model);
}

async function startLocalProfile(tier: TierAssignment, mode: 'replace' | 'seed'): Promise<ProfileCatalogEnvelope> {
  return await writeLocalProfile({ roles: BUILTIN_PROFILE_CATALOG.roles, tiers: { default: tier } }, mode);
}

/** Read for writes: CAS needs the server's version, so the cache answers only if the fetch failed. */
export function loadActiveProfile(): Promise<ProfileCatalogEnvelope> {
  return settle(Effect.gen(function* () {
    const authority = resolveProfileAuthority();

    if (authority.kind === 'account') return (yield* Effect.promise(async () => readAccountProfile(authority.accountId))).envelope;

    const existing = loadLocalProfileAuthority();

    if (existing) return existing;
    const model = defaultSpecForEndpoint(resolveLLMConfig()) ?? (yield* Effect.promise(async () => firstOpenAiCompatModel()));

    if (!model) return yield* Effect.die(new Error('No model is set up: run kinu setup, or kinu provider connect <provider>.'));

    return yield* Effect.promise(async () => startLocalProfile({ model: spell(model) }, 'seed'));
  }));
}

/** Seeds a machine with none; an account's is from its cache. */
export async function ensureDefaultTier(): Promise<TierAssignment | null> {
  return resolveProfileAuthority().kind === 'local' ? (await loadActiveProfile()).catalog.tiers.default : readDefaultTier();
}

/** Sets it only where none is set. */
export async function adoptDefaultModel(model: string): Promise<TierAssignment | null> {
  if (resolveProfileAuthority().kind === 'local' && loadLocalProfileAuthority() === null) {
    await startLocalProfile({ model: spell(model) }, 'seed');
  }

  return readDefaultTier();
}

/** A first model on a machine with none starts its profile. */
export async function updateDefaultTier(
  patch: { model?: string; reasoningEffort?: ReasoningEffort },
): Promise<ProfileCatalogEnvelope> {
  const edit = patch.model === undefined ? patch : { ...patch, model: spell(patch.model) };

  if (edit.model !== undefined && resolveProfileAuthority().kind === 'local' && loadLocalProfileAuthority() === null) {
    return await startLocalProfile({ ...edit, model: edit.model }, 'replace');
  }

  const current = await loadActiveProfile();

  const catalog = {
    ...current.catalog,
    tiers: { ...current.catalog.tiers, default: { ...current.catalog.tiers.default, ...edit } },
  };

  return current.authority.kind === 'local'
    ? writeLocalProfile(catalog)
    : writeAccountProfile(current.authority.accountId, current.version, catalog);
}

export async function updateDefaultAccount(provider: string, account: string | null): Promise<ProfileCatalogEnvelope> {
  const current = await loadActiveProfile();
  const { [provider]: _previous, ...others } = current.catalog.accounts ?? {};
  const accounts = account === null ? others : { ...others, [provider]: account };
  const catalog = { ...current.catalog, accounts };

  return current.authority.kind === 'local'
    ? writeLocalProfile(catalog)
    : writeAccountProfile(current.authority.accountId, current.version, catalog);
}
