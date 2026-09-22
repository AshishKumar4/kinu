/**
 * Durable record of device commands still running on a user's computer, and the precedence protocol over it.
 * A row is inserted before its frame leaves the UserDO and removed only after the daemon acknowledges a terminal answer.
 * Claims are exclusive and activation-scoped (a fresh activation releases all); the first stored answer wins.
 */
import * as v from 'valibot';
import type { SqlExec } from '../types/primitives';
import { nextDeviceRequestId } from './device-tunnel';

/** Terminal cancellation answer; either way nothing runs under the request any more. */
export type DeviceCancelOutcome = 'terminated' | 'unknown';

/** A request a sweep holds the cancellation claim on; `settled` is the stored terminal answer. */
export interface ClaimedDeviceRequest {
  requestId: string;
  deviceId: string;
  claim: string;
  settled: DeviceCancelOutcome | null;
}

/** A request as revocation sees it; revocation never releases claims, so no token. */
export interface SweptDeviceRequest {
  requestId: string;
  settled: DeviceCancelOutcome | null;
}

export interface DeviceTransferOutcome {
  readonly transferred: boolean;
}

const StoredOutcomeSchema = v.nullable(v.picklist(['terminated', 'unknown'] as const));

const ClaimedRowSchema = v.object({
  request_id: v.string(),
  device_id: v.string(),
  claim: v.string(),
  cancel_outcome: StoredOutcomeSchema,
});

const SweptRowSchema = v.object({
  request_id: v.string(),
  cancel_outcome: StoredOutcomeSchema,
});

const OutcomeRowSchema = v.object({ cancel_outcome: StoredOutcomeSchema });

/** Not nullable: the settle write COALESCEs an answer in, so NULL is a broken invariant. */
const SettledOutcomeRowSchema = v.object({
  cancel_outcome: v.picklist(['terminated', 'unknown'] as const),
});

const DeviceRowSchema = v.object({ device_id: v.string() });

const OwnershipRowSchema = v.object({
  background_job_id: v.nullable(v.string()),
  cancel_claim: v.nullable(v.string()),
  cancel_outcome: StoredOutcomeSchema,
  live_device: v.number(),
});

/** `turn_id` is the same durable turn key `tool_effect_claims` uses. */
export function initDeviceInflightTable(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_inflight_requests (
      request_id        TEXT PRIMARY KEY,
      device_id         TEXT NOT NULL,
      workspace         TEXT NOT NULL,
      turn_id           TEXT,
      background_job_id TEXT,
      -- The exclusive cancellation claim. A claimed row belongs to exactly one
      -- in-flight sweep, so a parallel detach cannot move it and a second sweep
      -- cannot cancel it twice. Claims are taken before any device await, and
      -- they are activation-scoped: a fresh activation releases every one.
      cancel_claim      TEXT,
      -- The terminal cancellation answer, once one exists: 'terminated' when the
      -- kernel confirmed the owned process group died, 'unknown' when the daemon
      -- held no active control entry. Either way NOTHING is running under this
      -- request, so the row is no longer work: it is untransferable and owes only
      -- its cleanup acknowledgement, which is the step that can fail. A retry
      -- reports THIS answer rather than inventing a fresh one.
      cancel_outcome    TEXT CHECK (cancel_outcome IN ('terminated', 'unknown'))
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_inflight_turn
      ON device_inflight_requests (workspace, turn_id)
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_inflight_device
      ON device_inflight_requests (device_id)
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_inflight_background_job
      ON device_inflight_requests (workspace, background_job_id)
  `);
}

export class DeviceRequestLedger {
  constructor(private readonly sql: SqlExec) {}

  /** Run once per activation: any stored claim belongs to a dead activation. */
  releaseAbandonedClaims(): void {
    this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_claim = NULL WHERE cancel_claim IS NOT NULL`,
    );
  }

  /** Call before the frame leaves the UserDO, so no running command lacks a durable row. */
  insert(input: {
    requestId: string;
    deviceId: string;
    workspace: string;
    turnId: string | null;
    backgroundJobId: string | null;
  }): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO device_inflight_requests
         (request_id, device_id, workspace, turn_id, background_job_id)
       VALUES (?, ?, ?, ?, ?)`,
      input.requestId, input.deviceId, input.workspace,
      input.backgroundJobId === null ? input.turnId : null,
      input.backgroundJobId,
    );
  }

  /** Store the answer of a forwarded (unclaimed) cancellation; first answer wins. */
  settleUnclaimed(requestId: string, outcome: DeviceCancelOutcome): void {
    this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_outcome = ?
        WHERE request_id = ? AND cancel_outcome IS NULL`,
      outcome, requestId,
    );
  }

  /** Claim one turn's live requests, excluding rows already detached to a background job. */
  claimTurnRequests(workspace: string, turnId: string): ClaimedDeviceRequest[] {
    return this.claim(`turn_id = ? AND background_job_id IS NULL`, workspace, turnId);
  }

  claimBackgroundJobRequests(workspace: string, jobId: string): ClaimedDeviceRequest[] {
    return this.claim(`background_job_id = ?`, workspace, jobId);
  }

  /** Revocation takes every claim of a device, whoever held it; displaced sweeps find rows gone. */
  claimEveryRequestOf(deviceId: string): SweptDeviceRequest[] {
    return this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_claim = ?
        WHERE device_id = ? RETURNING request_id, cancel_outcome`,
      nextDeviceRequestId(), deviceId,
    ).toArray().map((row) => {
      const parsed = v.parse(SweptRowSchema, row);

      return { requestId: parsed.request_id, settled: parsed.cancel_outcome };
    });
  }

  /** The row while this claim still holds it, else `null`. Re-read before every frame. */
  held(requestId: string, claim: string): { settled: DeviceCancelOutcome | null } | null {
    const row = this.sql.exec(
      `SELECT cancel_outcome FROM device_inflight_requests
        WHERE request_id = ? AND cancel_claim = ?`,
      requestId, claim,
    ).toArray()[0];

    return row === undefined ? null : { settled: v.parse(OutcomeRowSchema, row).cancel_outcome };
  }

  /**
   * Store a terminal answer under its claim and return the answer that stands; `null` if revocation took the claim.
   * `COALESCE` keeps a confirmed `terminated` from being overwritten by a later `unknown`.
   */
  settleHeld(requestId: string, claim: string, outcome: DeviceCancelOutcome): DeviceCancelOutcome | null {
    const row = this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_outcome = COALESCE(cancel_outcome, ?)
        WHERE request_id = ? AND cancel_claim = ? RETURNING cancel_outcome`,
      outcome, requestId, claim,
    ).toArray()[0];

    return row === undefined ? null : v.parse(SettledOutcomeRowSchema, row).cancel_outcome;
  }

  /** Unguarded by design: revocation holds every claim and drops every row afterwards. */
  settleRevoked(requestId: string, outcome: DeviceCancelOutcome): void {
    this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_outcome = ? WHERE request_id = ?`,
      outcome, requestId,
    );
  }

  /** Hand the row back for a retry; returns whether this claim still held it. */
  releaseClaim(requestId: string, claim: string): boolean {
    return this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_claim = NULL
        WHERE request_id = ? AND cancel_claim = ? RETURNING request_id`,
      requestId, claim,
    ).toArray().length === 1;
  }

  deleteHeld(requestId: string, claim: string): void {
    this.sql.exec(
      `DELETE FROM device_inflight_requests WHERE request_id = ? AND cancel_claim = ?`,
      requestId, claim,
    );
  }

  deleteEveryRequestOf(deviceId: string): void {
    this.sql.exec(`DELETE FROM device_inflight_requests WHERE device_id = ?`, deviceId);
  }

  /** Guards retiring a revocation incident: remaining rows mean a sweep is unfinished. */
  hasRequestsFor(deviceId: string): boolean {
    return this.sql.exec(
      `SELECT 1 AS present FROM device_inflight_requests WHERE device_id = ? LIMIT 1`,
      deviceId,
    ).toArray().length === 1;
  }

  /** Device of an unclaimed request; a claimed row's cancellation sends its own acknowledgement. */
  acknowledgeable(requestId: string, workspace: string): { deviceId: string } | null {
    const row = this.sql.exec(
      `SELECT device_id FROM device_inflight_requests
        WHERE request_id = ? AND workspace = ? AND cancel_claim IS NULL`,
      requestId, workspace,
    ).toArray()[0];

    return row === undefined ? null : { deviceId: v.parse(DeviceRowSchema, row).device_id };
  }

  /** Compare-delete against the selected row: the id may have been re-inserted mid-acknowledgement. */
  deleteAcknowledged(input: { requestId: string; workspace: string; deviceId: string }): void {
    this.sql.exec(
      `DELETE FROM device_inflight_requests
        WHERE request_id = ? AND workspace = ? AND device_id = ? AND cancel_claim IS NULL`,
      input.requestId, input.workspace, input.deviceId,
    );
  }

  /**
   * Move one live request (unclaimed, unsettled, on an unrevoked device) to a background job.
   * The result re-reads every condition, so it describes the row as it now is.
   */
  transferToBackgroundJob(
    input: { requestId: string; workspace: string; jobId: string },
  ): DeviceTransferOutcome {
    this.sql.exec(
      `UPDATE device_inflight_requests
          SET turn_id = NULL, background_job_id = ?
        WHERE request_id = ? AND workspace = ?
          AND background_job_id IS NULL AND cancel_claim IS NULL AND cancel_outcome IS NULL
          AND device_id IN (SELECT id FROM user_devices WHERE revoked_at IS NULL)`,
      input.jobId, input.requestId, input.workspace,
    );

    const row = this.sql.exec(
      `SELECT r.background_job_id, r.cancel_claim, r.cancel_outcome,
              EXISTS (SELECT 1 FROM user_devices d
                       WHERE d.id = r.device_id AND d.revoked_at IS NULL) AS live_device
         FROM device_inflight_requests r
        WHERE r.request_id = ? AND r.workspace = ?`,
      input.requestId, input.workspace,
    ).toArray()[0];

    if (row === undefined) return { transferred: false };
    const owned = v.parse(OwnershipRowSchema, row);

    return {
      transferred: owned.background_job_id === input.jobId && owned.live_device === 1
        && owned.cancel_claim === null && owned.cancel_outcome === null,
    };
  }

  private claim(ownership: string, workspace: string, owner: string): ClaimedDeviceRequest[] {
    const claim = nextDeviceRequestId();

    return this.sql.exec(
      `UPDATE device_inflight_requests
          SET cancel_claim = ?
        WHERE workspace = ? AND ${ownership} AND cancel_claim IS NULL
        RETURNING request_id, device_id, cancel_claim AS claim, cancel_outcome`,
      claim, workspace, owner,
    ).toArray().map((row) => {
      const parsed = v.parse(ClaimedRowSchema, row);

      return {
        requestId: parsed.request_id,
        deviceId: parsed.device_id,
        claim: parsed.claim,
        settled: parsed.cancel_outcome,
      };
    });
  }
}
