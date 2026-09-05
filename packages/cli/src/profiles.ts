/**
 * Profile authority and cache for the CLI.
 *
 * Two stores, one rule each:
 * - Signed out, the LOCAL authority is canonical: one envelope in
 *   config.json (`localProfile`), replaced whole by every edit and never
 *   merged into.
 * - Signed in, the ACCOUNT is canonical on the server. This machine holds a
 *   per-account read-only cache in its own file, never inside KinuConfig,
 *   and refreshes it only from server responses.
 *
 * Nothing promotes, merges or falls back between the stores. Logging out or
 * switching accounts flips which store resolution reads; it never copies.
 *
 * The account cache is a read-only mirror, so it answers one question the
 * server cannot answer while the network is down: what this account's catalog
 * was the last time this machine saw it. A turn reads through it. It is never
 * a substitute for another account's catalog, and never invented when absent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_PROFILE_CATALOG,
  ProfileCatalogEnvelopeSchema,
  profileCatalogDigest,
  validateProfileCatalog,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
} from '@kinu.run/core';
import * as v from 'valibot';
import {
  ensureSecretDir, withConfigLock, writeSecretFile, type ProfileEnvelopeSource,
} from '@kinu.run/cli-backend';
import {
  AGENT_HOME, loadConfigFile, requireStoredAuthConfig, resolveLLMConfig,
  updateConfigFile, sessionExpired,
} from './config';
import { getCloudProfile, updateCloudProfile } from './cloud-api';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

/** Where authority for this machine's profile reads lives right now. */
export type ProfileAuthoritySource = { kind: 'local' } | { kind: 'account'; accountId: string };

/**
 * Resolution follows the authenticated account identity: a live interactive
 * session with a known user id reads the account store; everything else —
 * signed out, expired, or a bare `KINU_TOKEN` with no stored identity —
 * reads the local authority.
 */
export function resolveProfileAuthority(): ProfileAuthoritySource {
  const config = loadConfigFile();
  if (!config.accessToken || sessionExpired(config)) return { kind: 'local' };
  const accountId = config.user?.id;
  return accountId ? { kind: 'account', accountId } : { kind: 'local' };
}

// ── Local authority (signed-out canonical, inside config.json) ──────────────

/**
 * The signed-out local authority envelope, or null when none was ever
 * imported. A misplaced envelope (account-kind content in the local slot)
 * is malformed data and fails loudly.
 */
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

/**
 * Write the local authority. A signed-out machine holds exactly one catalog
 * and nothing merges into it: every write replaces it whole, and the version
 * counts the replacements so a reader can tell one from the next.
 */
function writeLocalProfile(catalog: ProfileCatalog): ProfileCatalogEnvelope {
  const validated = validateProfileCatalog(catalog);
  let envelope!: ProfileCatalogEnvelope;
  updateConfigFile((config) => {
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

// ── Account cache (signed-in mirror of server truth, its own file) ──────────

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

/**
 * The cached mirror of `accountId`'s server-side catalog, or null when that
 * account was never fetched here. Entries whose stored authority or digest
 * do not hold up are corrupt data and fail loudly.
 */
export function loadCachedAccountProfile(accountId: string): ProfileCatalogEnvelope | null {
  const entry = readAccountCache().accounts[accountId];
  if (!entry) return null;
  assertCachedEntry(accountId, entry);
  return entry;
}

/**
 * Store a server response as `accountId`'s read-only cache entry. Content
 * always comes from the server; this never authors catalog data.
 */
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

/** Which store answered an account read: the server, or its cache. */
type AccountReadSource = 'server' | 'cache';

/** Where one resolution's envelope came from. The local authority is a file
 *  read with no second store behind it, so it has no cache state. */
type ProfileReadSource = AccountReadSource | 'local';

interface AccountRead {
  envelope: ProfileCatalogEnvelope;
  source: AccountReadSource;
}

/**
 * This account's catalog: the server's answer, which also refreshes the
 * cache, or the cache when the server cannot be reached. Keyed on the account
 * whose fetch failed and validated on read, so another account's catalog can
 * never answer for this one. No entry rethrows — a catalog this machine never
 * saw is not one to guess at.
 */
async function readAccountProfile(accountId: string): Promise<AccountRead> {
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

/**
 * The authority envelope from its own store, asking the server when the
 * account is canonical. This is the read a WRITE goes through: a CAS needs
 * the version the server currently holds, so it never settles for the cache
 * except when the fetch failed outright, where the write is going to fail on
 * the network anyway.
 */
export async function loadActiveProfile(): Promise<ProfileCatalogEnvelope> {
  const authority = resolveProfileAuthority();
  if (authority.kind === 'local') {
    const existing = loadLocalProfileAuthority();
    if (existing) return existing;
    const model = resolveLLMConfig()?.model;
    if (!model) throw new Error('Set a default model first with /model <spec>.');
    return writeLocalProfile({
      roles: BUILTIN_PROFILE_CATALOG.roles,
      tiers: { default: { model } },
    });
  }
  return (await readAccountProfile(authority.accountId)).envelope;
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

/**
 * What the authority half of turn setup cost, and what answered it: whether
 * the envelope came off the network, off the cache file, or out of
 * config.json. That is the difference between a turn that paid an HTTP round
 * trip before its first token and one that read a file.
 */
function reportResolution(source: ProfileReadSource, startedAt: number): void {
  diagnostics.event('profile.authority_read', { source, durationMs: Date.now() - startedAt });
}

/**
 * Update the default tier of whichever store is canonical: the account's
 * catalog through a CAS, or the local authority in place. Missing tiers
 * continue to alias it. A first `model` with no local authority yet creates
 * one, which is how a signed-out machine gets its catalog.
 */
export async function updateDefaultTier(
  patch: { model?: string; reasoningEffort?: ReasoningEffort },
): Promise<ProfileCatalogEnvelope> {
  const authority = resolveProfileAuthority();
  if (authority.kind === 'local' && loadLocalProfileAuthority() === null && patch.model) {
    const defaultTier = patch.reasoningEffort === undefined
      ? { model: patch.model }
      : { model: patch.model, reasoningEffort: patch.reasoningEffort };
    return writeLocalProfile({
      roles: BUILTIN_PROFILE_CATALOG.roles,
      tiers: { default: defaultTier },
    });
  }
  const current = await loadActiveProfile();
  const defaultTier = {
    ...current.catalog.tiers.default,
    ...patch,
  };
  const catalog: ProfileCatalog = {
    roles: current.catalog.roles,
    tiers: { ...current.catalog.tiers, default: defaultTier },
  };
  if (current.authority.kind === 'local') return writeLocalProfile(catalog);
  const auth = requireStoredAuthConfig();
  const result = await updateCloudProfile(auth.origin, auth.token, {
    catalog,
    expectedVersion: current.version,
  });
  if ('conflict' in result) {
    throw new Error(
      `the account profile changed while this edit was open `
      + `(current version ${result.currentVersion}, digest ${result.currentDigest}); run the same command again`,
    );
  }
  cacheAccountProfile(current.authority.accountId, result.envelope);
  return result.envelope;
}

// ── Shared integrity checks ──────────────────────────────────────────────────

function assertDigestMatches(envelope: ProfileCatalogEnvelope): void {
  const actual = profileCatalogDigest(envelope.catalog);
  if (actual !== envelope.digest) {
    throw new Error(`profile catalog digest mismatch: envelope says "${envelope.digest}", catalog hashes to "${actual}"`);
  }
}
