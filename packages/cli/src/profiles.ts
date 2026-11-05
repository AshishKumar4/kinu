/**
 * Profile authority and cache. Signed out, the local envelope in config.json is canonical; signed in, the server
 * is, mirrored by a per-account read-only cache file. Nothing merges or falls back between the stores.
 */

import { Cause, Effect, Result } from 'effect';
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
import { diagnostics, KinuError, toKinuError, settleSync, settle } from '@kinu.run/core/obs';

type ProfileAuthoritySource = { kind: 'local' } | { kind: 'account'; accountId: string };

/** Account store only for a live session with a known user id; a bare `KINU_TOKEN` reads local. */
export function resolveProfileAuthority(): ProfileAuthoritySource {
  const config = loadConfigFile();

  if (!config.accessToken || sessionExpired(config)) return { kind: 'local' };
  const accountId = config.user?.id;

  return accountId ? { kind: 'account', accountId } : { kind: 'local' };
}

/** Null if never imported; account-kind content here throws. */
export function loadLocalProfileAuthority(): ProfileCatalogEnvelope | null {
  return settleSync(localProfileAuthority());
}

function localProfileAuthority(): Effect.Effect<ProfileCatalogEnvelope | null, KinuError> {
  const local = loadConfigFile().localProfile;

  if (!local) return Effect.succeed(null);

  if (local.authority.kind !== 'local') {
    return Effect.fail(new KinuError(
      'bad_input',
      `config.json localProfile carries authority kind "${local.authority.kind}"; the local slot holds only locally authored catalogs`,
    ));
  }

  return Effect.as(Effect.fromResult(digestMatches(local)), local);
}

/** Replaces whole; the version counts replacements. */
export async function writeLocalProfile(catalog: ProfileCatalog, mode: 'replace' | 'seed' = 'replace'): Promise<ProfileCatalogEnvelope> {
  const validated = validateProfileCatalog({ value: catalog });
  let envelope!: ProfileCatalogEnvelope;
  await updateConfigFile((config) => {
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

/** The cache file, empty when absent; one that does not read as the cache is refused with how to fix it. */
function readCacheFile(path: string): Result.Result<AccountProfileCache, KinuError> {
  if (!existsSync(path)) return Result.succeed({ accounts: {} });

  const text = readFileSync(path, 'utf-8');

  const parsed = Result.try({
    try: () => v.parse(AccountProfileCacheSchema, JSON.parse(text)),
    catch: (cause) => cause,
  });

  if (Result.isSuccess(parsed)) return Result.succeed(parsed.success);

  // Which way it failed is what says how to fix it.
  const json = Result.isSuccess(Result.try(() => { JSON.parse(text); }));

  return Result.fail(new KinuError('bad_input', json
    ? `${path} is not a valid Kinu profile cache; fix or remove it.`
    : `${path} is not valid JSON; fix or remove the profile cache.`, { cause: parsed.failure }));
}

/** Null if never fetched here; a corrupt entry fails. */
function loadCachedAccountProfile(accountId: string): Effect.Effect<ProfileCatalogEnvelope | null, KinuError> {
  return Effect.fromResult(Result.flatMap(readCacheFile(profileCachePath()), (cache) => {
    const entry = cache.accounts[accountId];

    return entry ? Result.map(cachedEntry(accountId, entry), () => entry) : Result.succeed(null);
  }));
}

/** The cache with `envelope` in it; null when a newer version is already cached. Two catalogs at one version are refused. */
function withEnvelope(cache: AccountProfileCache, accountId: string, envelope: ProfileCatalogEnvelope): Result.Result<AccountProfileCache | null, KinuError> {
  const existing = cache.accounts[accountId];

  if (!existing) return Result.succeed({ accounts: { ...cache.accounts, [accountId]: envelope } });

  return Result.flatMap(cachedEntry(accountId, existing), () => {
    if (existing.version > envelope.version) return Result.succeed(null);

    if (existing.version === envelope.version && existing.digest !== envelope.digest) {
      return Result.fail(new KinuError('bad_input', `profile cache received two catalogs for account ${accountId} at version ${envelope.version}`));
    }

    return Result.succeed({ accounts: { ...cache.accounts, [accountId]: envelope } });
  });
}

/** Read, decided and written under the config lock, so two processes never interleave their writes. */
function cacheAccountProfile(accountId: string, envelope: ProfileCatalogEnvelope): Effect.Effect<void, KinuError> {
  const path = profileCachePath();

  return Effect.flatMap(Effect.fromResult(cachedEntry(accountId, envelope)), () => Effect.flatMap(Effect.promise(() => withConfigLock(path, () => {
    const next = Result.flatMap(readCacheFile(path), (cache) => withEnvelope(cache, accountId, envelope));

    if (Result.isSuccess(next) && next.success !== null) {
      ensureSecretDir(AGENT_HOME);
      writeSecretFile(path, `${JSON.stringify(next.success, null, 2)}\n`);
    }

    return next;
  })), (written) => Effect.asVoid(Effect.fromResult(written))));
}

function cachedEntry(accountId: string, envelope: ProfileCatalogEnvelope): Result.Result<void, KinuError> {
  const authority = envelope.authority;

  if (authority.kind !== 'account' || authority.accountId !== accountId) {
    const carried = authority.kind === 'account' ? authority.accountId : authority.kind;

    return Result.fail(new KinuError('bad_input', `profile cache entry for ${accountId} carries mismatching authority "${carried}"`));
  }

  return digestMatches(envelope);
}

type AccountReadSource = 'server' | 'cache';

type ProfileReadSource = AccountReadSource | 'local';

interface AccountRead {
  envelope: ProfileCatalogEnvelope;
  source: AccountReadSource;
}

/** Server answer (refreshing the cache), else this account's cache; no entry rethrows. */
export function readAccountProfile(accountId: string): Promise<AccountRead> {
  return settle(Effect.gen(function* () {
    const auth = requireStoredAuthConfig();

    return yield* Effect.catchCause(Effect.gen(function* () {
      const envelope = yield* Effect.promise(async () => getCloudProfile(auth.origin, auth.token));
      yield* cacheAccountProfile(accountId, envelope);

      return { envelope, source: 'server' } satisfies AccountRead;
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);
      const cached = yield* loadCachedAccountProfile(accountId);

      if (!cached) return yield* Effect.failCause(failed);
      diagnostics.failure(
        'profile.account_cache_served',
        toKinuError({ doing: 'reading the account profile catalog', cause: error, otherwise: 'unavailable' }),
        { account: accountId, cachedVersion: cached.version, cachedDigest: cached.digest },
      );

      return { envelope: cached, source: 'cache' } satisfies AccountRead;
    }));
  }));
}

function readKnownProfile(): Effect.Effect<ProfileCatalogEnvelope | null, KinuError> {
  const authority = resolveProfileAuthority();

  return authority.kind === 'local' ? localProfileAuthority() : loadCachedAccountProfile(authority.accountId);
}

/** Never seeds or fetches. */
export function readDefaultTier(): TierAssignment | null {
  return settleSync(Effect.map(readKnownProfile(), (known) => known?.catalog.tiers.default ?? null));
}

export function readDefaultAccounts(): Readonly<Record<string, string>> {
  return settleSync(Effect.map(readKnownProfile(), (known) => known?.catalog.accounts ?? {}));
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

export function writeAccountProfile(
  accountId: string,
  expectedVersion: number,
  catalog: ProfileCatalog,
): Promise<ProfileCatalogEnvelope> {
  return settle(Effect.gen(function* () {
    const auth = requireStoredAuthConfig();
    const result = yield* Effect.promise(async () => updateCloudProfile(auth.origin, auth.token, { catalog, expectedVersion }));

    if (Result.isFailure(result)) {
      return yield* new KinuError(
        'unavailable',
        `the account profile changed while this edit was open `
        + `(current version ${result.failure.currentVersion}, digest ${result.failure.currentDigest}); run the same command again`,
      );
    }

    const envelope = result.success;
    yield* cacheAccountProfile(accountId, envelope);

    return envelope;
  }));
}

function digestMatches(envelope: ProfileCatalogEnvelope): Result.Result<void, KinuError> {
  const actual = profileCatalogDigest(envelope.catalog);

  return actual === envelope.digest
    ? Result.void
    : Result.fail(new KinuError('bad_input', `profile catalog digest mismatch: envelope says "${envelope.digest}", catalog hashes to "${actual}"`));
}
