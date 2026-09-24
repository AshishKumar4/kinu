/**
 * Profile authority and cache. Signed out, the local envelope in config.json is canonical; signed in, the server
 * is, mirrored by a per-account read-only cache file. Nothing merges or falls back between the stores.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProfileCatalogEnvelopeSchema,
  profileCatalogDigest,
  validateProfileCatalog,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type TierAssignment,
} from '@kinu.run/core';
import * as v from 'valibot';
import { ensureSecretDir, withConfigLock, writeSecretFile, type ProfileEnvelopeSource } from '@kinu.run/cli-backend';
import { AGENT_HOME, loadConfigFile, requireStoredAuthConfig, updateConfigFile, sessionExpired } from './config';
import { getCloudProfile, updateCloudProfile } from './cloud-api';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

export type ProfileAuthoritySource = { kind: 'local' } | { kind: 'account'; accountId: string };

/** Account store only for a live session with a known user id; a bare `KINU_TOKEN` reads local. */
export function resolveProfileAuthority(): ProfileAuthoritySource {
  const config = loadConfigFile();

  if (!config.accessToken || sessionExpired(config)) return { kind: 'local' };
  const accountId = config.user?.id;

  return accountId ? { kind: 'account', accountId } : { kind: 'local' };
}

/** Null if never imported; account-kind content here throws. */
export function loadLocalProfileAuthority(): ProfileCatalogEnvelope | null {
  const local = loadConfigFile().localProfile;

  if (!local) return null;

  if (local.authority.kind !== 'local') {
    throw new Error(
      `config.json localProfile carries authority kind "${local.authority.kind}"; the local slot holds only locally authored catalogs`,
    );
  }

  assertDigestMatches(local);

  return local;
}

/** Replaces whole; the version counts replacements. */
export function writeLocalProfile(catalog: ProfileCatalog, mode: 'replace' | 'seed' = 'replace'): ProfileCatalogEnvelope {
  const validated = validateProfileCatalog({ value: catalog });
  let envelope!: ProfileCatalogEnvelope;
  updateConfigFile((config) => {
    if (mode === 'seed' && config.localProfile) {
      envelope = config.localProfile;

      return;
    }

    envelope = {
      authority: { kind: 'local' },
      version: (config.localProfile?.version ?? 0) + 1,
      digest: profileCatalogDigest(validated),
      catalog: validated,
    };
    config.localProfile = envelope;
  });

  return envelope;
}

function profileCachePath(): string {
  return join(AGENT_HOME, 'profile-cache.json');
}

const AccountProfileCacheSchema = v.object({
  accounts: v.record(v.string(), ProfileCatalogEnvelopeSchema),
});

interface AccountProfileCache {
  accounts: Record<string, ProfileCatalogEnvelope>;
}

function readAccountCache(): AccountProfileCache {
  const path = profileCachePath();

  if (!existsSync(path)) return { accounts: {} };
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON; fix or remove the profile cache.`, { cause: error });
  }

  try {
    return v.parse(AccountProfileCacheSchema, raw);
  } catch (error) {
    throw new Error(`${path} is not a valid Kinu profile cache; fix or remove it.`, { cause: error });
  }
}

/** Null if never fetched here; corrupt entries throw. */
function loadCachedAccountProfile(accountId: string): ProfileCatalogEnvelope | null {
  const entry = readAccountCache().accounts[accountId];

  if (!entry) return null;
  assertCachedEntry(accountId, entry);

  return entry;
}

function cacheAccountProfile(accountId: string, envelope: ProfileCatalogEnvelope): void {
  assertCachedEntry(accountId, envelope);
  const path = profileCachePath();
  withConfigLock(path, () => {
    const cache = readAccountCache();
    const existing = cache.accounts[accountId];

    if (existing) {
      assertCachedEntry(accountId, existing);

      if (existing.version > envelope.version) return;

      if (existing.version === envelope.version && existing.digest !== envelope.digest) {
        throw new Error(`profile cache received two catalogs for account ${accountId} at version ${envelope.version}`);
      }
    }

    ensureSecretDir(AGENT_HOME);
    writeSecretFile(path, `${JSON.stringify({ accounts: { ...cache.accounts, [accountId]: envelope } }, null, 2)}\n`);
  });
}

function assertCachedEntry(accountId: string, envelope: ProfileCatalogEnvelope): void {
  const authority = envelope.authority;

  if (authority.kind !== 'account' || authority.accountId !== accountId) {
    const carried = authority.kind === 'account' ? authority.accountId : authority.kind;
    throw new Error(`profile cache entry for ${accountId} carries mismatching authority "${carried}"`);
  }

  assertDigestMatches(envelope);
}

type AccountReadSource = 'server' | 'cache';

type ProfileReadSource = AccountReadSource | 'local';

interface AccountRead {
  envelope: ProfileCatalogEnvelope;
  source: AccountReadSource;
}

/** Server answer (refreshing the cache), else this account's cache; no entry rethrows. */
export async function readAccountProfile(accountId: string): Promise<AccountRead> {
  const auth = requireStoredAuthConfig();

  try {
    const envelope = await getCloudProfile(auth.origin, auth.token);
    cacheAccountProfile(accountId, envelope);

    return { envelope, source: 'server' };
  } catch (error) {
    const cached = loadCachedAccountProfile(accountId);

    if (!cached) throw error;
    diagnostics.failure(
      'profile.account_cache_served',
      toKinuError({ doing: 'reading the account profile catalog', cause: error, otherwise: 'unavailable' }),
      { account: accountId, cachedVersion: cached.version, cachedDigest: cached.digest },
    );

    return { envelope: cached, source: 'cache' };
  }
}

function readKnownProfile(): ProfileCatalogEnvelope | null {
  const authority = resolveProfileAuthority();

  return authority.kind === 'local' ? loadLocalProfileAuthority() : loadCachedAccountProfile(authority.accountId);
}

/** Never seeds or fetches. */
export function readDefaultTier(): TierAssignment | null {
  return readKnownProfile()?.catalog.tiers.default ?? null;
}

export function readDefaultAccounts(): Readonly<Record<string, string>> {
  return readKnownProfile()?.catalog.accounts ?? {};
}

export function createProfileAuthorityReader(): ProfileEnvelopeSource {
  return async () => {
    const startedAt = Date.now();
    const authority = resolveProfileAuthority();

    if (authority.kind === 'local') {
      const local = loadLocalProfileAuthority();

      if (local) reportResolution('local', startedAt);

      return local;
    }

    const read = await readAccountProfile(authority.accountId);
    reportResolution(read.source, startedAt);

    return read.envelope;
  };
}

function reportResolution(source: ProfileReadSource, startedAt: number): void {
  diagnostics.event('profile.authority_read', { source, durationMs: Date.now() - startedAt });
}

export async function writeAccountProfile(
  accountId: string,
  expectedVersion: number,
  catalog: ProfileCatalog,
): Promise<ProfileCatalogEnvelope> {
  const auth = requireStoredAuthConfig();
  const result = await updateCloudProfile(auth.origin, auth.token, { catalog, expectedVersion });

  if ('conflict' in result) {
    throw new Error(
      `the account profile changed while this edit was open `
      + `(current version ${result.currentVersion}, digest ${result.currentDigest}); run the same command again`,
    );
  }

  cacheAccountProfile(accountId, result.envelope);

  return result.envelope;
}

function assertDigestMatches(envelope: ProfileCatalogEnvelope): void {
  const actual = profileCatalogDigest(envelope.catalog);

  if (actual !== envelope.digest) {
    throw new Error(`profile catalog digest mismatch: envelope says "${envelope.digest}", catalog hashes to "${actual}"`);
  }
}
