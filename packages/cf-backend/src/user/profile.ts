import {
  createExperienceLibrary, BUILTIN_PROFILE_CATALOG, profileCatalogDigest, validateProfileCatalog, type ExperienceEntry, type ExperienceKind, type ProfileCatalog, type ProfileCatalogEnvelope, type PublishableCandidate, type JsonValue, decodeJsonValue, PROFILE_CATALOG_CONFIG_KEY, CapabilityDeniedError, type UserCaller, type WorkspaceOverview, displayNameProblem,
} from '@kinu.run/core';
import { authoredRefusal, KinuError, renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { libraryTiles } from './roster';
import { singletonValue, type UserObjectHost } from './user-host';
import type { UserWorkspaces } from './workspaces';

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
  /** `null` until the wizard reaches `finish()`. Lives in `user_onboarding` because the
   *  genesis lock refuses a new column on the shipped `user_profile`. */
  onboardedAt: number | null;
  /** Counted like `listWorkspaces`' `total`. An account owning a workspace never sees the
   *  wizard, stamp or not. */
  workspaceCount: number;
}

/** `createdAt` is absent on the write side. */
export interface SharedBlueprintReceipt {
  ownerUserId: string;
  ownerEmail: string;
  workspace: string;
  shareId: string;
  createdAt?: number;
}

/** A typed result, not an exception: error classes do not survive the DO RPC boundary. */
export type ProfileCatalogWriteResult =
  | { readonly ok: true; readonly envelope: ProfileCatalogEnvelope }
  | { readonly ok: false; readonly kind: 'conflict'; readonly currentVersion: number; readonly currentDigest: string }
  | { readonly ok: false; readonly kind: 'malformed'; readonly reason: string };

/** Parsed before profile code trusts its SQL values, so a damaged row cannot become a default. */
interface StoredProfileCatalogRow {
  value: string;
  version: number;
}

interface ProfileCatalogState {
  version: number;
  catalog: ProfileCatalog;
}

const StoredProfileCatalogRowSchema: v.GenericSchema<StoredProfileCatalogRow> = v.strictObject({
  value: v.string(),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export interface UserProfileStoreHost extends Pick<UserObjectHost, 'ctx' | 'requireTier' | 'sqlx'> {
  readonly workspaces: Pick<UserWorkspaces, 'rosterCount'>;
}

/** The account's profile, config, catalog and received shares. */
export class UserProfileStore {
  constructor(private readonly host: UserProfileStoreHost) {}

  private onboardingCompletedAt(): number | null {
    return singletonValue(this.host.sqlx, 'SELECT completed_at AS value FROM user_onboarding WHERE id = 1', v.number()) ?? null;
  }

  async ensureProfile(caller: UserCaller, email: string, displayName?: string): Promise<UserProfile> {
    await this.host.requireTier(caller, 'profile');
    const now = Date.now();
    const onboardedAt = this.onboardingCompletedAt();
    const workspaceCount = this.host.workspaces.rosterCount();

    const existing = this.host.sqlx<{ email: string; display_name: string | null; created_at: number; last_seen_at: number }>(
      `SELECT email, display_name, created_at, last_seen_at FROM user_profile WHERE id = 1`,
    )[0];

    if (existing) {
      this.host.sqlx(
        `UPDATE user_profile SET last_seen_at = ?, display_name = COALESCE(?, display_name) WHERE id = 1`,
        now, displayName ?? null,
      );

      return {
        email: existing.email,
        displayName: displayName ?? existing.display_name,
        createdAt: existing.created_at,
        lastSeenAt: now,
        onboardedAt,
        workspaceCount,
      };
    }

    this.host.sqlx(
      `INSERT INTO user_profile (id, email, display_name, created_at, last_seen_at) VALUES (1, ?, ?, ?, ?)`,
      email, displayName ?? null, now, now,
    );

    return { email, displayName: displayName ?? null, createdAt: now, lastSeenAt: now, onboardedAt, workspaceCount };
  }

  async getProfile(caller: UserCaller): Promise<UserProfile | null> {
    await this.host.requireTier(caller, 'profile');

    const row = this.host.sqlx<{ email: string; display_name: string | null; created_at: number; last_seen_at: number }>(
      `SELECT email, display_name, created_at, last_seen_at FROM user_profile WHERE id = 1`,
    )[0];

    if (!row) return null;

    return {
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      onboardedAt: this.onboardingCompletedAt(),
      workspaceCount: this.host.workspaces.rosterCount(),
    };
  }

  /** Idempotent: the first completion wins; a retry returns the original timestamp. */
  async completeOnboarding(caller: UserCaller): Promise<{ onboardedAt: number }> {
    await this.host.requireTier(caller, 'account');

    this.host.sqlx(
      `INSERT INTO user_onboarding (id, completed_at) VALUES (1, ?) ON CONFLICT (id) DO NOTHING`,
      Date.now(),
    );

    const stamped = this.onboardingCompletedAt();

    if (stamped === null) throw new KinuError('io', 'user_onboarding has no row after the insert');

    return { onboardedAt: stamped };
  }

  async setDisplayName(caller: UserCaller, displayName: string): Promise<UserProfile> {
    await this.host.requireTier(caller, 'account');
    const name = displayName.trim();
    const problem = displayNameProblem(name);

    if (problem !== null) throw new KinuError('bad_input', problem);

    this.host.sqlx(`UPDATE user_profile SET display_name = ? WHERE id = 1`, name);

    const profile = await this.getProfile(caller);

    if (!profile) throw new KinuError('missing', 'No profile row to rename');

    return profile;
  }

  private experienceLibrary() {

    return createExperienceLibrary(this.host.ctx.storage.sql);
  }

  /**
   * Source workspace comes from the proven caller, never the argument; owner sessions cannot publish.
   */
  async publishExperience(caller: UserCaller, candidate: PublishableCandidate): Promise<ExperienceEntry> {
    const resolved = await this.host.requireTier(caller, 'experience.write');

    if (resolved.kind !== 'workspace') {
      throw new KinuError('denied', 'Only a workspace can publish experience; it publishes under its own name.');
    }

    return this.experienceLibrary().publish(candidate, resolved.workspace);
  }

  /** Excludes the calling workspace's own entries. */
  async searchExperience(
    caller: UserCaller,
    options: { query?: string; kind?: ExperienceKind; limit?: number } = {},
  ): Promise<ExperienceEntry[]> {
    const resolved = await this.host.requireTier(caller, 'experience.read');
    const searchOptions: typeof options & { excludeWorkspace?: string } = { ...options };

    if (resolved.kind === 'workspace') searchOptions.excludeWorkspace = resolved.workspace;

    return this.experienceLibrary().search(searchOptions);
  }

  async getExperienceEntry(caller: UserCaller, id: string): Promise<ExperienceEntry | null> {
    await this.host.requireTier(caller, 'experience.read');

    return this.experienceLibrary().get(id);
  }

  async getConfig(caller: UserCaller, key: string): Promise<string | null> {
    await this.host.requireTier(caller, 'config');

    if (key === PROFILE_CATALOG_CONFIG_KEY) {
      throw new KinuError('bad_input', 'profile_catalog has a dedicated typed CAS route.');
    }

    const row = this.host.sqlx<{ value: string }>(`SELECT value FROM user_config WHERE key = ?`, key)[0];

    return row?.value ?? null;
  }

  async setConfig(caller: UserCaller, key: string, value: string): Promise<void> {
    await this.host.requireTier(caller, 'config');

    if (key === PROFILE_CATALOG_CONFIG_KEY) {
      throw new KinuError('bad_input', 'profile_catalog has a dedicated typed CAS route.');
    }

    this.host.sqlx(
      `INSERT INTO user_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value,
    );
  }

  async listConfig(caller: UserCaller): Promise<Record<string, string>> {
    await this.host.requireTier(caller, 'config');

    const rows = this.host.sqlx<{ key: string; value: string }>(
      `SELECT key, value FROM user_config WHERE key <> ?`, PROFILE_CATALOG_CONFIG_KEY,
    );

    const out: Record<string, string> = {};

    for (const r of rows) out[r.key] = r.value;

    return out;
  }

  /**
   * Owner-session only: the role/tier catalog is authority, so even a `full`-tier workspace is
   * refused until the agent runtime adds its narrow read surface.
   */
  private async requireOwnerSession(caller: UserCaller): Promise<void> {
    const resolved = await this.host.requireTier(caller, 'config');

    if (resolved.kind !== 'owner_session') {
      throw new CapabilityDeniedError(
        'The profile catalog is owner-only. Workspaces cannot read or write the account\'s roles and tiers.',
      );
    }
  }

  /** Corruption is an account configuration error, not permission to substitute other authority. */
  private parseStoredProfileCatalog(value: string): ProfileCatalog {
    let json: JsonValue;

    try {
      json = decodeJsonValue({ value: JSON.parse(value) });
    } catch (error) {
      throw new KinuError('io', 
        'The stored account profile catalog cannot be decoded as JSON.',
        { cause: error },
      );
    }

    try {
      return validateProfileCatalog({ value: json });
    } catch (error) {
      throw new KinuError('io', 
        'The stored account profile catalog violates the profile catalog contract.',
        { cause: error },
      );
    }
  }

  private profileCatalogEnvelope(version: number, catalog: ProfileCatalog): ProfileCatalogEnvelope {
    return {
      authority: { kind: 'account', accountId: this.host.ctx.id.name ?? this.host.ctx.id.toString() },
      version,
      digest: profileCatalogDigest(catalog),
      catalog,
    };
  }

  /** A missing row starts at version 0; malformed stored config fails rather than changing roles. */
  private readProfileCatalogState(): ProfileCatalogState {
    const rawRow = this.host.sqlx(
      `SELECT value, version FROM user_config WHERE key = ?`, PROFILE_CATALOG_CONFIG_KEY,
    )[0];

    if (!rawRow) return { version: 0, catalog: BUILTIN_PROFILE_CATALOG };

    let row: StoredProfileCatalogRow;

    try {
      row = v.parse(StoredProfileCatalogRowSchema, rawRow);
    } catch (error) {
      throw new KinuError('io', 'The stored account profile catalog state is malformed.', { cause: error });
    }

    return { version: row.version, catalog: this.parseStoredProfileCatalog(row.value) };
  }

  async getProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    await this.requireOwnerSession(caller);
    const current = this.readProfileCatalogState();

    return this.profileCatalogEnvelope(current.version, current.catalog);
  }

  /** Shared workspaces may read the catalog; only an owner session may mutate it. */
  async getWorkspaceProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    await this.host.requireTier(caller, 'profile.resolve');
    const current = this.readProfileCatalogState();

    return this.profileCatalogEnvelope(current.version, current.catalog);
  }

  /**
   * CAS write: a version mismatch refuses with current state. Validation precedes the write, and
   * the read-check-write has no await, so each accepted write increments the version by one.
   */
  async putProfileCatalog(caller: UserCaller, catalog: JsonValue, expectedVersion: number): Promise<ProfileCatalogWriteResult> {
    await this.requireOwnerSession(caller);

    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return { ok: false, kind: 'malformed', reason: 'expectedVersion must be a non-negative integer.' };
    }

    let parsed: ProfileCatalog;

    try {
      parsed = validateProfileCatalog({ value: catalog });
    } catch (cause) {
      // The refusal names the offending path; it is all the owner is shown.
      return { ok: false, kind: 'malformed', reason: renderThrownChain({ cause: authoredRefusal({ doing: 'reading the profile catalog', cause }) }) };
    }

    // No await from here to the write: DO input gates make the CAS atomic.
    const current = this.readProfileCatalogState();

    if (current.version !== expectedVersion) {
      return {
        ok: false,
        kind: 'conflict',
        currentVersion: current.version,
        currentDigest: profileCatalogDigest(current.catalog),
      };
    }

    const nextVersion = current.version + 1;
    this.host.sqlx(
      `INSERT INTO user_config (key, value, version) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version`,
      PROFILE_CATALOG_CONFIG_KEY, JSON.stringify(parsed), nextVersion,
    );

    return { ok: true, envelope: this.profileCatalogEnvelope(nextVersion, parsed) };
  }

  /**
   * A projection: the owner's workspace object is the authority and every read re-asks it, so a
   * revoked share lists once and refuses. Idempotent per (owner, workspace, share).
   */
  async sharesReceived_add(caller: UserCaller, row: SharedBlueprintReceipt): Promise<void> {
    await this.host.requireTier(caller, 'shares');
    this.host.sqlx(
      `INSERT INTO user_shares_received (owner_user_id, owner_email, workspace, share_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_user_id, workspace, share_id) DO UPDATE SET owner_email = excluded.owner_email`,
      row.ownerUserId, row.ownerEmail, row.workspace, row.shareId,
    );
  }

  async libraryTiles(caller: UserCaller): Promise<Array<{ workspace: string; overview: WorkspaceOverview }>> {
    await this.host.requireTier(caller, 'drive');

    return libraryTiles(this.host.ctx.storage.sql);
  }

  async sharesReceived_list(caller: UserCaller): Promise<SharedBlueprintReceipt[]> {
    await this.host.requireTier(caller, 'shares');

    return this.host.sqlx<{ owner_user_id: string; owner_email: string; workspace: string; share_id: string; created_at: number }>(
      `SELECT owner_user_id, owner_email, workspace, share_id, created_at
       FROM user_shares_received ORDER BY created_at DESC, share_id`,
    ).map((row) => ({
      ownerUserId: row.owner_user_id, ownerEmail: row.owner_email, workspace: row.workspace,
      shareId: row.share_id, createdAt: row.created_at,
    }));
  }

  /**
   * Reverse of `sharesReceived_add`, run on each recipient when the owner deletes their account,
   * so no row lists a blueprint no object can answer for.
   */
  async sharesReceived_forget(caller: UserCaller, ownerUserId: string): Promise<void> {
    await this.host.requireTier(caller, 'shares');
    this.host.sqlx(`DELETE FROM user_shares_received WHERE owner_user_id = ?`, ownerUserId);
  }
}
