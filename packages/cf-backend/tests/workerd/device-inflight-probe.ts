/**
 * The durable device-command ledger, on real Durable Object SQLite, across a
 * real activation reset.
 *
 * WHY THIS IS A PLATFORM TEST AND NOT A SQL-SHAPE ONE. `device_inflight_requests`
 * is the only durable record that a command is running on a user's computer, and
 * its whole protocol is about surviving an activation that ends mid-decision: a
 * claim is exclusive and ACTIVATION-SCOPED (a fresh activation releases every
 * claim, because the sweep holding one lived in an isolate that no longer
 * exists), the first stored answer wins, and every later write is guarded by the
 * claim it was taken under. The bun suite exercises those decisions over
 * `bun:sqlite`, where nothing is ever evicted and the "next activation" is a
 * second harness object constructed by hand over the same file. So a green bun
 * suite says only that the statements agree with each other — not that a real
 * eviction leaves a request retryable rather than stranded, and not that a
 * confirmed stop is still confirmed after it.
 *
 * The subject is the PRODUCTION ledger — the same `initDeviceInflightTable` DDL
 * and the same `DeviceRequestLedger` statements UserDO runs. Only the `SqlExec`
 * adapter is local, and it is the positional protocol `UserDO.sqlx` uses.
 *
 * Policy is deliberately NOT here. Which authority may cancel what, which frames
 * reach the device, and how an unconfirmed stop is reported to the owner all
 * live in UserDO and are asserted under `bun test`; hosting UserDO itself in
 * this pool would drag the whole production module graph (and its separate type
 * environment) into a layer whose charter is one platform semantic per class.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  DeviceRequestLedger, initDeviceInflightTable,
  type DeviceCancelOutcome,
} from '../../src/user/device-inflight';
import type { SqlExec, SqlValue } from '@kinu.run/core';

/** One request as the probe reports it across the RPC boundary. */
export interface ProbeRequest {
  readonly requestId: string;
  readonly claim: string;
  readonly settled: DeviceCancelOutcome | null;
}

/** What one claim attempt saw, flattened for the same reason. */
export interface ProbeClaim {
  readonly requestId: string;
  readonly deviceId: string;
  readonly claim: string;
  readonly settled: DeviceCancelOutcome | null;
}

const WORKSPACE = 'workspace-a';
const DEVICE = 'dev-probe';

export class DeviceLedgerProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the positional SQL protocol `UserDO.sqlx` hands the ledger, bridged
  // here because the Agents SDK is not hosted in this worker. `SqlExec` admits
  // the portable value vocabulary; Durable Object SQLite binds the same values
  // and types them as `SqlStorageValue`, so the cast is made once at the
  // boundary rather than at each row.
  //
  // The statement runs on `exec`, exactly as the platform's does: a DDL
  // statement nobody reads rows from still has to have executed.
  private readonly sql: SqlExec = {
    exec: (query: string, ...bindings: SqlValue[]) => {
      // SAFETY: `SqlValue` declares the same string/number/null/bytes union the
      // platform's `SqlStorageValue` declares, so the checked binding widens
      // nothing — the cast renames the union, it does not add members.
      const cursor = this.ctx.storage.sql.exec(query, ...bindings as SqlStorageValue[]);
      return { toArray: () => cursor.toArray() };
    },
  };


  private readonly ledger = new DeviceRequestLedger(this.sql);

  /** Whether THIS activation has already initialized. One Durable Object
   *  instance is one activation, so the flag is the activation boundary — the
   *  same shape as `UserDO.ensureInit`. */
  private initialized = false;

  /**
   * What a fresh activation does before serving anything: create the table if it
   * is not there, then release every claim in storage. Both are UserDO's own
   * first steps (`ensureInit`), and the release is the semantic this probe
   * exists to observe — after an eviction it runs against rows a dead
   * activation left claimed.
   */
  private activate(): void {
    if (this.initialized) return;
    initDeviceInflightTable(this.sql);
    // `transferToBackgroundJob` joins the device registry, so the probe holds a
    // real row for the device its requests belong to.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS user_devices (id TEXT PRIMARY KEY, revoked_at INTEGER)`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO user_devices (id, revoked_at) VALUES (?, NULL)`, DEVICE,
    );
    this.ledger.releaseAbandonedClaims();
    this.initialized = true;
  }

  /** Record one command as live work, exactly as a durable exec does. */
  admit(requestId: string, turnId: string): void {
    this.activate();
    this.ledger.insert({
      requestId, deviceId: DEVICE, workspace: WORKSPACE, turnId, backgroundJobId: null,
    });
  }

  /** Take the turn's claims and report them, leaving them HELD — the state an
   *  activation that dies mid-sweep leaves behind. */
  claimTurn(turnId: string): ProbeClaim[] {
    this.activate();
    return this.ledger.claimTurnRequests(WORKSPACE, turnId).map((row) => ({
      requestId: row.requestId,
      deviceId: row.deviceId,
      claim: row.claim,
      settled: row.settled,
    }));
  }

  /** Whether this claim still holds the row, and what answer it carries. */
  held(requestId: string, claim: string): { settled: DeviceCancelOutcome | null } | null {
    this.activate();
    return this.ledger.held(requestId, claim);
  }

  /** Store an answer under a claim and report the answer that now STANDS.
   *  `null` means the claim no longer held the row, which is the whole
   *  precedence rule in one value. */
  settle(requestId: string, claim: string, outcome: DeviceCancelOutcome): DeviceCancelOutcome | null {
    this.activate();
    return this.ledger.settleHeld(requestId, claim, outcome);
  }

  /** The tool path answering for its own aborted exec: no claim, and the first
   *  stored answer wins. This is what lands while a sweep is mid-await. */
  settleUnclaimed(requestId: string, outcome: DeviceCancelOutcome): void {
    this.activate();
    this.ledger.settleUnclaimed(requestId, outcome);
  }

  release(requestId: string, claim: string): boolean {
    this.activate();
    return this.ledger.releaseClaim(requestId, claim);
  }

  /** The acknowledgement path's two steps, separately, so a test can put an
   *  eviction between them: this is the read that decides whether the row is
   *  still this workspace's to acknowledge. */
  acknowledgeable(requestId: string): { deviceId: string } | null {
    this.activate();
    return this.ledger.acknowledgeable(requestId, WORKSPACE);
  }

  /** The delete an acknowledgement earns, compare-guarded against the row that
   *  was read. */
  deleteAcknowledged(requestId: string, deviceId: string): void {
    this.activate();
    this.ledger.deleteAcknowledged({ requestId, workspace: WORKSPACE, deviceId });
  }

  deleteHeld(requestId: string, claim: string): void {
    this.activate();
    this.ledger.deleteHeld(requestId, claim);
  }

  transfer(requestId: string, jobId: string): { transferred: boolean } {
    this.activate();
    return this.ledger.transferToBackgroundJob({ requestId, workspace: WORKSPACE, jobId });
  }

  /** Every row as storage now holds it — the only read that is not the
   *  ledger's, because a test asserting survival has to see the raw record. */
  rows(): ProbeRequest[] {
    this.activate();
    return this.ctx.storage.sql.exec(
      `SELECT request_id, cancel_claim, cancel_outcome FROM device_inflight_requests
        ORDER BY request_id`,
    ).toArray().map((row) => ({
      requestId: String(row.request_id),
      claim: row.cancel_claim === null ? '' : String(row.cancel_claim),
      // SAFETY: the table's CHECK constraint guarantees `cancel_outcome` is one
      // of the `DeviceCancelOutcome` members, so a non-null read is validated
      // by the schema the production ledger created.
      settled: row.cancel_outcome === null
        ? null
        : (String(row.cancel_outcome) as DeviceCancelOutcome),
    }));
  }
}
