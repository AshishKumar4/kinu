/**
 * What an agent asks the owner to decide, in one table: an `action` parked on the owner (a command, a file write, a
 * slate effect, a mail; safety/deferred-approval.ts) and a `device` call's ask (safety/device-consent.ts). Both wait
 * `queued` for one answer, wake the agent that asked, stand a denial for a day and resume the surface the ask came
 * from. Each kind keeps its own answers and how one is spent: an action's approval is spent once per run and given
 * back if the command provably did not run (`spend_seq`); a device ask's answer is deleted by the call it answers,
 * under the grant epoch it was given in. The columns after `surface` are one kind's.
 */

import type { RawSqlExec } from '../types/primitives';

export function initOwnerRequestsTable(execRaw: RawSqlExec): void {
  // `id` is an action's within its actor, a device ask's within the workspace. An action's `rule_hits` are the rules it
  // tripped, as data (`reason` is display text): a JSON array of `{ rule, decision }`, one per rule, by rule. A device
  // ask's `actor_id` is null for the owner's own call, which wakes nobody; its `workspace_name` null for none.
  execRaw(`CREATE TABLE IF NOT EXISTS owner_requests (
    kind           TEXT NOT NULL CHECK (kind IN ('action', 'device')),
    id             TEXT NOT NULL,
    actor_id       TEXT,
    command        TEXT NOT NULL,
    status         TEXT NOT NULL,
    requested_at   INTEGER NOT NULL,
    decided_at     INTEGER,
    surface        TEXT,
    executor       TEXT,
    context        TEXT,
    reason         TEXT,
    spend_seq      INTEGER,
    rule_hits      TEXT,
    device_id      TEXT,
    device_label   TEXT,
    method         TEXT,
    workspace_name TEXT,
    epoch          INTEGER,
    CHECK ((kind = 'action' AND actor_id IS NOT NULL AND status IN ('queued', 'approved', 'denied', 'spent')
        AND executor IS NOT NULL AND context IS NOT NULL AND reason IS NOT NULL AND spend_seq IS NOT NULL AND rule_hits IS NOT NULL
        AND device_id IS NULL AND device_label IS NULL AND method IS NULL AND workspace_name IS NULL AND epoch IS NULL)
      OR (kind = 'device' AND status IN ('queued', 'once', 'always', 'deny')
        AND device_id IS NOT NULL AND device_label IS NOT NULL AND method IS NOT NULL AND epoch IS NOT NULL
        AND executor IS NULL AND context IS NULL AND reason IS NULL AND spend_seq IS NULL AND rule_hits IS NULL))
  )`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_requests_action ON owner_requests(actor_id, id) WHERE kind = 'action'`);
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_requests_device ON owner_requests(id) WHERE kind = 'device'`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_owner_requests_status ON owner_requests(kind, actor_id, status, requested_at)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_owner_requests_command
    ON owner_requests(actor_id, command, executor, context, requested_at DESC) WHERE kind = 'action'`);
}
