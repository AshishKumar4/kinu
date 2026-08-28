/**
 * The durable record of device commands that are still running on a user's
 * computer, and the precedence protocol over it.
 *
 * A command's row is inserted before its frame leaves the UserDO and removed
 * only once the daemon has acknowledged a terminal answer, so the row IS the
 * state: present and unsettled means live work on someone's machine. Several
 * authorities can reach for the same row at once — the turn's Stop, a detached
 * background job's Stop, the tool aborting its own exec, and device revocation —
 * and every one of them can be interrupted by an activation ending mid-flight.
 *
 * This module owns the table and every statement over it, which is what makes
 * the precedence rules a single decision each rather than a convention repeated
 * at four call sites:
 *
 *   A CLAIM is exclusive. Taking one hides the row from every other authority,
 *   so a transfer cannot move it out from under an in-flight sweep and two
 *   sweeps cannot cancel one command twice.
 *
 *   Claims are ACTIVATION-SCOPED. The sweep holding one lives in an isolate's
 *   memory, so a claim found in storage when an activation begins was abandoned
 *   by the activation that died: the activation boundary is the expiry, with no
 *   lease clock and no elapsed guess.
 *
 *   The FIRST stored answer wins, and every write that follows it is guarded by
 *   the claim it was taken under. A later authority reports the stored answer
 *   instead of killing a command that is already dead.
 *
 * What is NOT here: who may cancel what, which frames go to the device, and how
 * an unconfirmed stop is reported to the owner. That policy lives in UserDO,
 * which holds the sockets and the consent boundary.
 */
import {
  nextDeviceRequestId, type SqlExec,
} from '@kinu.run/core';
import * as v from 'valibot';

/** A terminal cancellation answer: the kernel confirmed the daemon's owned
 *  process group died, or the daemon held no active control entry. Either way
 *  nothing runs under the request any more. */
export type DeviceCancelOutcome = 'terminated' | 'unknown';

/** One device request a sweep holds the cancellation claim on. `settled` is the
 *  stored terminal answer, present only when nothing runs under it any more. */
export interface ClaimedDeviceRequest {
  requestId: string;
  deviceId: string;
  claim: string;
  settled: DeviceCancelOutcome | null;
}

/** One request as revocation sees it: revocation takes every claim at once and
 *  never releases them, so the claim token is not part of what it reads back. */
export interface SweptDeviceRequest {
  requestId: string;
  settled: DeviceCancelOutcome | null;
}

/** Whether one live request now belongs to the named background job. */
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
const DeviceRowSchema = v.object({ device_id: v.string() });
const OwnershipRowSchema = v.object({
  background_job_id: v.nullable(v.string()),
  cancel_claim: v.nullable(v.string()),
  cancel_outcome: StoredOutcomeSchema,
  live_device: v.number(),
});

/**
 * The table, created where every statement over it lives.
 *
 * `turn_id` is the actor's existing durable turn identity — the same key
 * `tool_effect_claims` uses — so this table links a socket-owned command to its
 * turn without copying the actor's effect ledger into UserDO.
 */
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

  /**
   * Release every claim in storage. Run once per activation, because a claim
   * found here was taken by an activation that no longer exists — see the
   * activation-scoped rule in this module's header.
   */
  releaseAbandonedClaims(): void {
    this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_claim = NULL WHERE cancel_claim IS NOT NULL`,
    );
  }

  /**
   * Record a command as live work. Called BEFORE its frame leaves the UserDO:
   * an insert afterwards would leave a window in which a command is running on
   * the machine with nothing durable naming it.
   *
   * A command issued inside an already-detached scope carries its job from the
   * insert, so there is no window in which the row belongs to a turn that no
   * longer owns it.
   */
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

  /** Store the answer a cancellation this UserDO merely forwarded came back
   *  with. First answer wins: it is the one that actually ended the process
   *  group, and a later sweep then reports it instead of killing a dead
   *  command again. */
  settleUnclaimed(requestId: string, outcome: DeviceCancelOutcome): void {
    this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_outcome = ?
        WHERE request_id = ? AND cancel_outcome IS NULL`,
      outcome, requestId,
    );
  }

  /** Take exclusive cancellation ownership of one turn's live requests. Rows a
   *  detach already moved to a background job are not the turn's. */
  claimTurnRequests(workspace: string, turnId: string): ClaimedDeviceRequest[] {
    return this.claim(`turn_id = ? AND background_job_id IS NULL`, workspace, turnId);
  }

  /** Take exclusive cancellation ownership of one background job's requests. */
  claimBackgroundJobRequests(workspace: string, jobId: string): ClaimedDeviceRequest[] {
    return this.claim(`background_job_id = ?`, workspace, jobId);
  }

  /**
   * Take the claim on every request of one device, whoever held it.
   *
   * Revocation is the terminal device authority, so it TAKES rather than
   * competes: a displaced sweep keeps reporting the outcome it observed, and its
   * guarded cleanup simply finds the row already gone.
   */
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

  /**
   * The row as it stands right now, but only while THIS claim still holds it.
   * `null` means another authority took or dropped it, so the caller neither
   * sends a frame for it nor reports it. Read before every frame, because both
   * facts change under the awaits of earlier rows.
   */
  held(requestId: string, claim: string): { settled: DeviceCancelOutcome | null } | null {
    const row = this.sql.exec(
      `SELECT cancel_outcome FROM device_inflight_requests
        WHERE request_id = ? AND cancel_claim = ?`,
      requestId, claim,
    ).toArray()[0];
    return row === undefined ? null : { settled: v.parse(OutcomeRowSchema, row).cancel_outcome };
  }

  /**
   * Store a terminal answer under the claim it was obtained with, and report
   * whether this claim still held the row. `false` means the terminal authority
   * took the claim mid-flight, and IT — not this caller — answers for the
   * request.
   */
  settleHeld(requestId: string, claim: string, outcome: DeviceCancelOutcome): boolean {
    return this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_outcome = ?
        WHERE request_id = ? AND cancel_claim = ? RETURNING request_id`,
      outcome, requestId, claim,
    ).toArray().length === 1;
  }

  /** Store an answer for a request revocation swept. Unguarded by design:
   *  revocation already took every claim and drops every row afterwards. */
  settleRevoked(requestId: string, outcome: DeviceCancelOutcome): void {
    this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_outcome = ? WHERE request_id = ?`,
      outcome, requestId,
    );
  }

  /** Hand the row back for a retry. Returns whether THIS claim still held it. */
  releaseClaim(requestId: string, claim: string): boolean {
    return this.sql.exec(
      `UPDATE device_inflight_requests SET cancel_claim = NULL
        WHERE request_id = ? AND cancel_claim = ? RETURNING request_id`,
      requestId, claim,
    ).toArray().length === 1;
  }

  /** Drop a settled row, but only the one this claim holds. */
  deleteHeld(requestId: string, claim: string): void {
    this.sql.exec(
      `DELETE FROM device_inflight_requests WHERE request_id = ? AND cancel_claim = ?`,
      requestId, claim,
    );
  }

  /** Every row of a device, dropped: revocation's last step. */
  deleteEveryRequestOf(deviceId: string): void {
    this.sql.exec(`DELETE FROM device_inflight_requests WHERE device_id = ?`, deviceId);
  }

  /** Whether any request row of a device remains — the guard on retiring a
   *  revocation incident, because a sweep still holding rows has not finished
   *  deciding what the owner would be acknowledging. */
  hasRequestsFor(deviceId: string): boolean {
    return this.sql.exec(
      `SELECT 1 AS present FROM device_inflight_requests WHERE device_id = ? LIMIT 1`,
      deviceId,
    ).toArray().length === 1;
  }

  /**
   * The device a workspace's request is running on, while the request is still
   * this workspace's to acknowledge. A CLAIMED row belongs to an in-flight
   * cancellation, which owns the terminal outcome and sends its own
   * acknowledgement, so completion racing cancellation settles once.
   */
  acknowledgeable(requestId: string, workspace: string): { deviceId: string } | null {
    const row = this.sql.exec(
      `SELECT device_id FROM device_inflight_requests
        WHERE request_id = ? AND workspace = ? AND cancel_claim IS NULL`,
      requestId, workspace,
    ).toArray()[0];
    return row === undefined ? null : { deviceId: v.parse(DeviceRowSchema, row).device_id };
  }

  /**
   * Drop the row an acknowledgement was obtained for.
   *
   * Compare-delete against the row the caller SELECTED: a caller-supplied id
   * can be re-inserted while the acknowledgement is in flight, and deleting on
   * the id alone would remove a replacement command's live row.
   */
  deleteAcknowledged(input: { requestId: string; workspace: string; deviceId: string }): void {
    this.sql.exec(
      `DELETE FROM device_inflight_requests
        WHERE request_id = ? AND workspace = ? AND device_id = ? AND cancel_claim IS NULL`,
      input.requestId, input.workspace, input.deviceId,
    );
  }

  /**
   * Move ONE live request to the background job that now owns it.
   *
   * Only LIVE work changes hands, and only on a device that can still be told
   * to stop: a claimed row is mid-sweep, a settled row is not work at all, and
   * a REVOKED device can never reconnect, so its unresolved commands belong to
   * revocation's incident rather than to a job that could not cancel them.
   *
   * Every condition the write required is read back the same way, so the answer
   * describes the row as it now IS rather than as the write hoped.
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
