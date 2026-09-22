/**
 * The production device-command ledger on real DO SQLite across a real activation reset: bun's `bun:sqlite`
 * never evicts, so it cannot show a request staying retryable or a confirmed stop surviving eviction.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  DeviceRequestLedger, initDeviceInflightTable,
  type DeviceCancelOutcome,
} from '@kinu.run/core';
import type { SqlExec, SqlValue } from '@kinu.run/core';

export interface ProbeRequest {
  readonly requestId: string;
  readonly claim: string;
  readonly settled: DeviceCancelOutcome | null;
}

export interface ProbeClaim {
  readonly requestId: string;
  readonly deviceId: string;
  readonly claim: string;
  readonly settled: DeviceCancelOutcome | null;
}

const WORKSPACE = 'workspace-a';

const DEVICE = 'dev-probe';

export class DeviceLedgerProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the positional protocol `UserDO.sqlx` hands the ledger; DO SQLite binds the same values.
  // Runs on `exec` like the platform's: a DDL nobody reads rows from must still execute.
  private readonly sql: SqlExec = {
    exec: (query: string, ...bindings: SqlValue[]) => {
      const cursor = this.ctx.storage.sql.exec(query, ...bindings);

      return { toArray: () => cursor.toArray() };
    },
  };


  private readonly ledger = new DeviceRequestLedger(this.sql);

  /** One DO instance is one activation, so this flag is the activation boundary (as `UserDO.ensureInit`). */
  private initialized = false;

  /** UserDO's first steps (`ensureInit`): create the table, then release every claim a dead activation left. */
  private activate(): void {
    if (this.initialized) return;
    initDeviceInflightTable(this.sql);
    // `transferToBackgroundJob` joins the device registry.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS user_devices (id TEXT PRIMARY KEY, revoked_at INTEGER)`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO user_devices (id, revoked_at) VALUES (?, NULL)`, DEVICE,
    );
    this.ledger.releaseAbandonedClaims();
    this.initialized = true;
  }

  admit(requestId: string, turnId: string): void {
    this.activate();
    this.ledger.insert({
      requestId, deviceId: DEVICE, workspace: WORKSPACE, turnId, backgroundJobId: null,
    });
  }

  /** Leaves claims held: the state an activation dying mid-sweep leaves behind. */
  claimTurn(turnId: string): ProbeClaim[] {
    this.activate();

    return this.ledger.claimTurnRequests(WORKSPACE, turnId).map((row) => ({
      requestId: row.requestId,
      deviceId: row.deviceId,
      claim: row.claim,
      settled: row.settled,
    }));
  }

  held(requestId: string, claim: string): { settled: DeviceCancelOutcome | null } | null {
    this.activate();

    return this.ledger.held(requestId, claim);
  }

  /** `null` means the claim no longer held the row. */
  settle(requestId: string, claim: string, outcome: DeviceCancelOutcome): DeviceCancelOutcome | null {
    this.activate();

    return this.ledger.settleHeld(requestId, claim, outcome);
  }

  /** No claim; the first stored answer wins. */
  settleUnclaimed(requestId: string, outcome: DeviceCancelOutcome): void {
    this.activate();
    this.ledger.settleUnclaimed(requestId, outcome);
  }

  release(requestId: string, claim: string): boolean {
    this.activate();

    return this.ledger.releaseClaim(requestId, claim);
  }

  /** Separate from the delete so a test can put an eviction between them. */
  acknowledgeable(requestId: string): { deviceId: string } | null {
    this.activate();

    return this.ledger.acknowledgeable(requestId, WORKSPACE);
  }

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

  rows(): ProbeRequest[] {
    this.activate();

    return this.ctx.storage.sql.exec(
      `SELECT request_id, cancel_claim, cancel_outcome FROM device_inflight_requests
        ORDER BY request_id`,
    ).toArray().map((row) => ({
      requestId: v.parse(v.string(), row.request_id),
      claim: row.cancel_claim === null ? '' : v.parse(v.string(), row.cancel_claim),
      // The CHECK constraint admits only `DeviceCancelOutcome` members.
      settled: row.cancel_outcome === null
        ? null
        : v.parse(v.picklist(['terminated', 'unknown']), row.cancel_outcome),
    }));
  }
}
