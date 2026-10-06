import { Effect } from 'effect';
import {
  autoTitleMayReplace, nameOriginOf, type NameOrigin, WORKSPACE_KEYED_ROWS, armCapabilityReconcile, clearCapabilityReconcile, commitWorkspaceCapability, freshWorkspaceCapability, pendingCapabilityReconcile, revokeWorkspaceCapability, workspaceCapabilityHash, type UserCaller, validateWorkspaceName, sanitizeWorkspaceLogoSvg, resolveWorkspaceTitle, WorkspaceOverviewSchema, type WorkspaceOverview,
} from '@kinu.run/core';
import { diagnostics, KinuError, settle, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { openAnalyticsWindow } from '@kinu.run/core/analytics';
import { rosterCounts, rosterPage, rosterRow, rosterSockets, sendRosterFrame, type RosterPage, type RosterQuery } from './roster';
import { deletePictures, picturePrefix } from '../slates/pictures';
import { notInRegistry } from './workspace-ownership';

import type { UserMcpServers } from './mcp-servers';
import type { UserObjectHost } from './user-host';

/** Renewed as each fork frame lands, so this bounds the gap between frames, not the transfer. */
const FORK_RESERVATION_LEASE_MS = 5 * 60 * 1000;

export interface WorkspaceEntry {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
}

export interface WorkspaceRegistrationSource {
  purpose?: string;
  nameOrigin?: NameOrigin;
}

/** `reserved` names an uncommitted fork transfer and deliberately carries no entry, so
 *  acting on a half-written fork target is unrepresentable. */
export type WorkspaceRegistration =
  | { readonly status: 'created' | 'active'; readonly entry: WorkspaceEntry }
  | { readonly status: 'reserved' };

/** Publish of something that is not an open reservation. A fork transfer treats it as a rollback
 * trigger, not a transport fault; crosses the DO RPC boundary as its message. */
class WorkspaceReservationNotPendingError extends Error {
  constructor(name: string, why: string) {
    super(`Workspace "${name}" cannot be published: ${why}.`);
    this.name = 'WorkspaceReservationNotPendingError';
  }
}

export interface UserWorkspacesHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  readonly mcpServers: Pick<UserMcpServers, 'stopWorkspaceMcpCalls'>;
  nudgeUnreported(): void;
}

/** The account's workspaces. */
export class UserWorkspaces {
  constructor(private readonly host: UserWorkspacesHost) {}

  /** Provisioning in flight, per workspace. A DO does not serialize across an RPC await, so
   *  coalescing here keeps concurrent first-touches from installing tokens from different mints. */
  private readonly _provisioning = new Map<string, Promise<void>>();

  /**
   * Reconcile a workspace's identity; any mismatch with `presentedHash` is repaired by minting anew.
   * The only ungated method (it bootstraps identity), so it opens the analytics window itself.
   */
  async ensureWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    openAnalyticsWindow(this.host.env);
    validateWorkspaceName(workspaceName);

    if (!this.workspaceRegistered(workspaceName)) {
      throw notInRegistry(`Workspace ${workspaceName} is not in your registry.`);
    }

    return this.reconcileWorkspaceCapability(workspaceName, presentedHash);
  }

  /**
   * Shared body for {@link ensureWorkspaceCapability} and {@link publishWorkspaceReservation}.
   * Admission is re-checked in the same synchronous turn as the write, so a delete during minting wins.
   */
  private async reconcileWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    if (presentedHash && presentedHash === workspaceCapabilityHash(this.host.ctx.storage.sql, workspaceName)) {
      // Matching hash is done only if no rotation is pending on a replica; the root holds the
      // only plaintext, so it is asked to re-push.
      const pending = pendingCapabilityReconcile(this.host.ctx.storage.sql, workspaceName);

      if (pending === null || pending !== presentedHash) return;
      const workspace = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(workspaceName));
      const result = await workspace.repushWorkspaceCapability();

      if (result.missed === 0) {
        clearCapabilityReconcile(this.host.ctx.storage.sql, workspaceName);

        return;
      }

      armCapabilityReconcile(this.host.ctx.storage.sql, workspaceName, presentedHash);

      return;
    }

    const inFlight = this._provisioning.get(workspaceName);

    if (inFlight) return inFlight;

    const task = (async () => {
      const { token, tokenHash } = await freshWorkspaceCapability();

      if (!this.workspaceMintable(workspaceName)) {
        throw new KinuError('unavailable', `Workspace ${workspaceName} is being deleted; it cannot be issued an identity.`);
      }

      commitWorkspaceCapability(this.host.ctx.storage.sql, workspaceName, tokenHash);
      clearCapabilityReconcile(this.host.ctx.storage.sql, workspaceName);
      const workspace = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(workspaceName));
      const result = await workspace.installWorkspaceCapability(token);

      if (result.missed > 0) {
        armCapabilityReconcile(this.host.ctx.storage.sql, workspaceName, tokenHash);
      }
    })();

    this._provisioning.set(workspaceName, task);

    try { await task; } finally { this._provisioning.delete(workspaceName); }
  }

  /** Like {@link workspaceRegistered} but also admits fork reservations (`create_pending = 1`);
   *  refuses rows mid-teardown and names absent from the registry. */
  private workspaceMintable(name: string): boolean {
    return this.host.sqlx(
      `SELECT 1 AS x FROM user_workspaces WHERE name = ? AND delete_pending = 0`, name,
    ).length > 0;
  }

  /** Same predicate as `listWorkspaces`' `total`: pending reservations and teardowns don't count. */
  rosterCount(): number {
    return this.host.sqlx<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_workspaces
       WHERE delete_pending = 0 AND create_pending = 0`,
    )[0].n;
  }

  async listWorkspaces(caller: UserCaller, query?: RosterQuery): Promise<RosterPage> {
    const resolved = await this.host.requireTier(caller, 'workspaces.read');
    // This read is the retry for unfinished teardowns and for stale fork reservations nothing else frees.
    await this.resumePendingDeletions();
    await this.reclaimStaleForkReservations();
    this.host.nudgeUnreported();
    const page = rosterPage(this.host.ctx.storage.sql, query);

    // Never whom siblings share with.
    return resolved.kind === 'owner_session' ? page : {
      ...page, entries: page.entries.map((entry) => ({ ...entry, overview: entry.overview === null ? null : { ...entry.overview, shares: [] } })),
    };
  }

  /** With no page open, nothing is read. */
  private rosterChanged(name: string): void {
    const sockets = rosterSockets(this.host.ctx);

    if (sockets.length === 0) return;
    const sql = this.host.ctx.storage.sql;
    sendRosterFrame(sockets, { type: 'workspace', name, entry: rosterRow(sql, name), counts: rosterCounts(sql) });
  }

  /** A repeat writes and sends nothing. */
  async putWorkspaceOverview(caller: UserCaller, name: string, overview: WorkspaceOverview): Promise<void> {
    const resolved = await this.host.requireTier(caller, 'workspaces.overview_self');
    validateWorkspaceName(name);

    if (resolved.kind === 'workspace' && resolved.workspace !== name) {
      throw new KinuError('denied', `Workspace "${resolved.workspace}" may only push its own overview.`);
    }

    const parsed = v.parse(WorkspaceOverviewSchema, overview);

    const changed = this.host.sqlx(
      `INSERT INTO workspace_overviews (name, overview, activity, decisions) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET overview = excluded.overview, activity = excluded.activity,
         decisions = excluded.decisions
       WHERE workspace_overviews.overview <> excluded.overview
       RETURNING name`,
      name, JSON.stringify(parsed), parsed.activity, parsed.decisionsWaiting,
    );

    if (changed.length > 0) this.rosterChanged(name);
  }

  /** Uncapped enumeration of the active roster for server-side fans, where a page would drop targets. */
  async listActiveWorkspaces(caller: UserCaller): Promise<Array<Pick<WorkspaceEntry, 'name' | 'displayName' | 'createdAt'>>> {
    await this.host.requireTier(caller, 'workspaces.read');

    return this.host.sqlx<{ name: string; display_name: string; created_at: number }>(
      `SELECT name, display_name, created_at FROM user_workspaces
       WHERE delete_pending = 0 AND create_pending = 0
       ORDER BY last_visited DESC`,
    ).map((r) => ({ name: r.name, displayName: r.display_name, createdAt: r.created_at }));
  }

  /**
   * Claim a roster name. `created` is exclusive (read+insert in one turn), and only it may initialize
   * or roll back; `active` must not be re-seeded; `reserved` is an uncommitted fork's hold.
   */
  async registerWorkspace(
    caller: UserCaller, name: string, displayName?: string, from?: WorkspaceRegistrationSource,
  ): Promise<WorkspaceRegistration> {
    const { purpose, nameOrigin } = from ?? {};
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    await this.requireNotDeleting(name);
    const now = Date.now();

    const existing = this.host.sqlx<{
      display_name: string;
      created_at: number;
      create_pending: number;
    }>(
      `SELECT display_name, created_at, create_pending
       FROM user_workspaces WHERE name = ?`,
      name,
    )[0];

    if (existing && existing.create_pending !== 0) return { status: 'reserved' };

    if (existing) {
      // Return the row's own timestamp: keeps the answer stable across retries and lets a
      // rollback match the row it actually inserted.
      this.host.sqlx(
        `UPDATE user_workspaces SET last_visited = ? WHERE name = ?`,
        now, name,
      );
      this.rosterChanged(name);

      return {
        status: 'active',
        entry: {
          name,
          displayName: existing.display_name,
          createdAt: existing.created_at,
          lastVisited: now,
        },
      };
    }

    const explicit = displayName?.trim() ?? '';
    const title = resolveWorkspaceTitle({ explicit, purpose, slug: name });
    // Use the origin the caller decided; a derived title is non-empty and must not read as
    // the owner's choice. A caller that states nothing falls back to the displayName test.
    const origin: NameOrigin = nameOrigin ?? (explicit !== '' ? 'user' : 'auto');
    // No ON CONFLICT: the read above and this write are one turn, so a conflict is unreachable;
    // if an await ever separated them, a silent upsert would be wrong.
    this.host.sqlx(
      `INSERT INTO user_workspaces (name, display_name, name_origin, created_at, last_visited, create_pending)
       VALUES (?, ?, ?, ?, ?, 0)`,
      name, title, origin, now, now,
    );
    this.rosterChanged(name);

    return {
      status: 'created',
      entry: { name, displayName: title, createdAt: now, lastVisited: now },
    };
  }

  /**
   * Hold a name for a pending fork transfer: row is inserted with `create_pending = 1`, invisible
   * until {@link publishWorkspaceReservation} (KINU-027) but still blocking the name.
   * Carries a lease; a lapsed reservation is torn down and adopted by the new caller.
   */
  async reserveWorkspace(caller: UserCaller, name: string, displayName?: string): Promise<{ entry: WorkspaceEntry; reserved: boolean }> {
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    await this.requireNotDeleting(name);

    const existing = this.host.sqlx<{
      name: string;
      display_name: string;
      created_at: number;
      last_visited: number;
      create_pending: number;
      fork_lease_expires_at: number | null;
    }>(
      `SELECT name, display_name, created_at, last_visited,
              create_pending, fork_lease_expires_at
       FROM user_workspaces WHERE name = ?`,
      name,
    )[0];

    const abandoned = existing !== undefined
      && existing.create_pending === 1
      && (existing.fork_lease_expires_at ?? 0) <= Date.now();

    if (abandoned) await this.reclaimForkReservation(name);

    if (existing && !abandoned) {
      return {
        entry: {
          name: existing.name,
          displayName: existing.display_name,
          createdAt: existing.created_at,
          lastVisited: existing.last_visited,
        },
        reserved: false,
      };
    }

    const now = Date.now();
    const explicit = displayName?.trim() ?? '';
    const title = resolveWorkspaceTitle({ explicit, slug: name });
    this.host.sqlx(
      `INSERT INTO user_workspaces
         (name, display_name, name_origin, created_at, last_visited, create_pending, fork_lease_expires_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      name, title, explicit !== '' ? 'user' : 'auto', now, now, now + FORK_RESERVATION_LEASE_MS,
    );

    return {
      entry: { name, displayName: title, createdAt: now, lastVisited: now },
      reserved: true,
    };
  }

  /**
   * Extend the reservation lease; called by the sender per frame. Returns false when the
   * reservation is no longer the caller's (published, released, or adopted), so it stops.
   */
  async renewWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    if (!Number.isFinite(createdAt)) return false;

    return this.host.sqlx(
      `UPDATE user_workspaces SET fork_lease_expires_at = ?
       WHERE name = ? AND created_at = ? AND create_pending = 1 AND delete_pending = 0
       RETURNING name`,
      Date.now() + FORK_RESERVATION_LEASE_MS, name, createdAt,
    ).length > 0;
  }

  /** Tear down the target DO of a lapsed reservation, then drop the row; teardown is idempotent. */
  private async reclaimForkReservation(name: string): Promise<void> {
    const ownerUserId = this.host.ctx.id.name ?? '';

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) {
      // Without the owner id the destroy cannot be authorized; the row keeps its lapsed lease
      // and the next attempt retries.
      diagnostics.failure('workspace.fork_reservation_unowned', toKinuError({
        doing: 'reclaiming a fork reservation whose transfer stopped',
        cause: new Error('this user object has no user id to authorize the destroy with'),
        otherwise: 'denied',
      }), { workspace: name });
      throw new KinuError('unavailable', `Workspace "${name}" holds an abandoned fork reservation that cannot be reclaimed.`);
    }

    await this.tearDownWorkspace(name, ownerUserId);
  }

  /**
   * Reclaim lapsed reservations. Driven by the owner's reads like {@link resumePendingDeletions}:
   * this object has no timer, and the roster hides `create_pending` rows.
   */
  private async reclaimStaleForkReservations(): Promise<void> {
    const stale = this.host.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE create_pending = 1 AND delete_pending = 0
         AND COALESCE(fork_lease_expires_at, 0) <= ?`,
      Date.now(),
    );

    for (const row of stale) {
      try {
        await this.reclaimForkReservation(row.name);
      } catch (err) {
        diagnostics.failure('workspace.fork_reservation_reclaim_failed', toKinuError({
          doing: 'reclaiming a fork reservation whose transfer stopped renewing it',
          cause: err,
          otherwise: 'io',
        }), { workspace: row.name });
      }
    }
  }

  /** Commit a reservation; the only place `create_pending` is cleared. */
  async publishWorkspaceReservation(
    caller: UserCaller,
    name: string,
    createdAt: number,
    capabilityHash: string | null,
  ): Promise<void> {
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    // Match on timestamp too: by name alone a late reply could publish a later reservation.
    // Rows with teardown started (`delete_pending`) may not be committed.
    const reserved = v.safeParse(v.object({ create_pending: v.picklist([0, 1]) }), this.host.sqlx(
      `SELECT create_pending FROM user_workspaces
       WHERE name = ? AND created_at = ? AND delete_pending = 0`,
      name, createdAt,
    )[0]);

    if (!reserved.success) {
      throw new WorkspaceReservationNotPendingError(name, 'no reservation of that name is open under that timestamp');
    }

    if (reserved.output.create_pending === 0) {
      throw new WorkspaceReservationNotPendingError(name, 'it is already published');
    }

    // Install (cross-DO await) must precede the transaction: `transactionSync` commits when its
    // synchronous body returns. A failed install leaves the row unpublished and releasable.
    await this.reconcileWorkspaceCapability(name, capabilityHash);
    this.host.ctx.storage.transactionSync(() => {
      this.host.ctx.storage.sql.exec(
        `UPDATE user_workspaces SET create_pending = 0, fork_lease_expires_at = NULL
         WHERE name = ? AND created_at = ? AND create_pending = 1`,
        name, createdAt,
      );
    });
    this.rosterChanged(name);
  }

  /** Drop only the exact row a failed fork reservation inserted; never contacts the target DO
   * (used only when the target belongs to another user). */
  async releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    if (!Number.isFinite(createdAt)) return false;

    // A `delete_pending` row belongs to an unfinished teardown and must not be dropped.
    const row = this.host.sqlx<{ created_at: number }>(
      `SELECT created_at FROM user_workspaces WHERE name = ? AND delete_pending = 0`,
      name,
    )[0];

    if (!row || row.created_at !== createdAt) return false;
    this.host.sqlx(`DELETE FROM user_workspaces WHERE name = ? AND created_at = ?`, name, createdAt);
    revokeWorkspaceCapability(this.host.ctx.storage.sql, name);

    return true;
  }

  /** Marks `name` visited now, and says whether the roster took the mark: a name it does not hold, or holds only while
   *  it is created or torn down, takes none, so a caller keeping a workspace alive by its visits learns it is gone. */
  async touchWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    // Rows being torn down or not yet published are not visitable, matching ordinary reads.
    const touched = this.host.sqlx<{ name: string }>(
      `UPDATE user_workspaces SET last_visited = ?
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0
       RETURNING name`,
      Date.now(), name,
    ).length > 0;

    if (touched) this.rosterChanged(name);

    return touched;
  }

  /**
   * Row is marked before teardown and removed after, so a failed teardown is resumed by the next
   * read (`resumePendingDeletions`); `destroyAgent` is idempotent.
   */
  async removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void> {
    await this.host.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new KinuError('bad_input', 'invalid owner user id');
    await this.tearDownWorkspace(name, ownerUserId);
  }

  /**
   * Mark, stop its MCP calls and revoke in one synchronous turn before the destroy await, so a dying
   * workspace keeps no authority. Destroy the DO before dropping the row; on failure the marked row
   * stays and the revoke is not undone.
   */
  async tearDownWorkspace(name: string, ownerUserId: string): Promise<void> {
    this.host.sqlx(`UPDATE user_workspaces SET delete_pending = 1 WHERE name = ?`, name);
    this.host.mcpServers.stopWorkspaceMcpCalls(name);
    revokeWorkspaceCapability(this.host.ctx.storage.sql, name);
    this.rosterChanged(name);
    // Grants are read by name, so a surviving row would grant full_filesystem to a same-name recreate.
    this.deleteWorkspaceRows(name, 'before-destroy');

    try {
      const stub = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(name));
      await stub.destroyAgent(ownerUserId);
    } catch (err) {
      // agents-SDK destroy aborts its own isolate after the wipe; the 'destroyed' error means success.
      if (!(err instanceof Error) || err.message !== 'destroyed') throw err;
    }

    if (this.host.env.SLATE_PICTURES !== undefined) await deletePictures(this.host.env.SLATE_PICTURES, picturePrefix(name));
    this.deleteWorkspaceRows(name, 'after-destroy');
    // Re-run for a resumed row whose identity a pre-fence delete could have left registered.
    revokeWorkspaceCapability(this.host.ctx.storage.sql, name);
  }

  private deleteWorkspaceRows(name: string, when: 'before-destroy' | 'after-destroy'): void {
    for (const { table, column, removal } of WORKSPACE_KEYED_ROWS) {
      if (removal === when) this.host.sqlx(`DELETE FROM ${table} WHERE ${column} = ?`, name);
    }
  }

  /**
   * Finish teardowns left marked; driven by the owner's reads since this object has no timer.
   * Failures keep the marker (the row is the retry) and do not throw, so listings still succeed.
   */
  private async resumePendingDeletions(): Promise<void> {
    const pending = this.host.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces WHERE delete_pending = 1`,
    );

    if (pending.length === 0) return;
    const ownerUserId = this.host.ctx.id.name ?? '';

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) {
      diagnostics.failure('workspace.cleanup_unowned', toKinuError({
        doing: 'resuming a pending workspace teardown',
        cause: new Error('this user object has no user id to authorize the destroy with'),
        otherwise: 'denied',
      }), { pending: pending.length });

      return;
    }

    for (const row of pending) {
      try {
        await this.tearDownWorkspace(row.name, ownerUserId);
      } catch (err) {
        diagnostics.failure('workspace.cleanup_retry_failed', toKinuError({
          doing: 'finishing a workspace teardown a previous attempt left unfinished',
          cause: err,
          otherwise: 'io',
        }), { workspace: row.name });
      }
    }
  }

  /**
   * Refuse a name whose teardown is pending; the row still owns a DO a recreate would wire into.
   * Retries the teardown first so a transient failure does not dead-end the name.
   */
  private async requireNotDeleting(name: string): Promise<void> {
    const marked = `SELECT 1 AS x FROM user_workspaces WHERE name = ? AND delete_pending = 1`;

    if (this.host.sqlx(marked, name).length === 0) return;
    await this.resumePendingDeletions();

    if (this.host.sqlx(marked, name).length === 0) return;
    throw new KinuError('unavailable', `Workspace "${name}" is still being deleted; its teardown has not finished.`);
  }

  /**
   * Root title authority: an 'auto' write is refused when the owner has named the workspace.
   * Returns whether the write applied; the workspace actor mirrors only after this succeeds.
   */
  async setWorkspaceDisplayName(
    caller: UserCaller, name: string, displayName: string, origin: NameOrigin,
  ): Promise<{ applied: boolean }> {
    const resolved = await this.host.requireTier(caller, 'workspaces.rename_self');
    validateWorkspaceName(name);

    // An agent renames only itself; this is what makes rename safe at the `shared` tier.
    if (resolved.kind === 'workspace' && resolved.workspace !== name) {
      throw new KinuError('denied', `Workspace "${resolved.workspace}" may only rename itself.`);
    }

    const current = this.host.sqlx<{ name_origin: string }>(
      `SELECT name_origin FROM user_workspaces
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`, name,
    )[0];

    if (!current) return { applied: false };

    if (origin !== 'user' && !autoTitleMayReplace(nameOriginOf(current.name_origin))) return { applied: false };
    this.host.sqlx(
      `UPDATE user_workspaces SET display_name = ?, name_origin = ? WHERE name = ?`,
      displayName, origin, name,
    );
    this.rosterChanged(name);

    return { applied: true };
  }

  // Sanitized again at this boundary.
  async setWorkspaceLogo(caller: UserCaller, name: string, svg: string): Promise<{ drawn: boolean }> {
    const resolved = await this.host.requireTier(caller, 'workspaces.rename_self');
    validateWorkspaceName(name);

    return settle(Effect.gen({ self: this }, function* () {
      if (resolved.kind === 'workspace' && resolved.workspace !== name) {
        return yield* Effect.fail(new KinuError('denied', `Workspace "${resolved.workspace}" may only draw its own logo.`));
      }

      const kept = sanitizeWorkspaceLogoSvg(svg);

      if (kept === null) this.host.sqlx(`DELETE FROM workspace_logos WHERE name = ?`, name);
      else this.host.sqlx(`INSERT OR REPLACE INTO workspace_logos (name, svg, drawn_at) VALUES (?, ?, ?)`, name, kept, Date.now());
      this.rosterChanged(name);

      return { drawn: kept !== null };
    }));
  }

  /** Null when no row exists; actors hydrate their activation cache from this. */
  async getWorkspaceTitle(caller: UserCaller, name: string): Promise<{ displayName: string; nameOrigin: NameOrigin } | null> {
    await this.host.requireTier(caller, 'workspaces.read');
    validateWorkspaceName(name);

    const row = this.host.sqlx<{ display_name: string; name_origin: string }>(
      `SELECT display_name, name_origin FROM user_workspaces
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`, name,
    )[0];

    if (!row) return null;

    return { displayName: row.display_name, nameOrigin: nameOriginOf(row.name_origin) };
  }

  async hasWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    await this.host.requireTier(caller, 'workspaces.read');

    return this.workspaceRegistered(name);
  }

  /** Ungated; callers (`hasWorkspace`, ticket flows) are gated at their own entry points. */
  workspaceRegistered(name: string): boolean {
    validateWorkspaceName(name);

    // Pending rows are not openable; every open, including `ensureWorkspaceCapability`, goes through here.
    const row = this.host.sqlx(
      `SELECT 1 AS x FROM user_workspaces
       WHERE name = ? AND delete_pending = 0
         AND create_pending = 0`,
      name,
    )[0];

    return row !== undefined;
  }

  /** Whether a foreign sender may deliver into this user's agents; same-owner peers need no grant. */
  async hasPeerGrant(caller: UserCaller, senderAgentName: string, senderUserId: string): Promise<boolean> {
    await this.host.requireTier(caller, 'peers.grants');

    const row = this.host.sqlx(
      `SELECT 1 AS x FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`,
      senderUserId, senderAgentName,
    )[0];

    return row !== undefined;
  }
}
