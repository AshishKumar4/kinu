/**
 * The one durable retry outbox — write-ahead intent, exponential backoff,
 * per-key ordering, dedupe and a dead-letter state, over the hosting actor's
 * own SQLite. The mechanism is `@nimbus-sh/fabric`'s; this file is the port
 * that lets a Kinu host supply it.
 *
 * Kinu built the discipline twice by hand and fabric says so in its own header:
 * the outbound email intent log (8 attempts from a 30s base) and the peer
 * transport (8 attempts from a 5s base, per-receiver ordering). Both are now
 * policies over this seam, so backoff, dead-lettering and the `nextRetryAt()`
 * alarm fold exist once.
 *
 * Two host facts fabric cannot assume, and this port supplies:
 *
 *   1. THE SQL SHAPE. fabric reads rows as a bare `Iterable`; a Kinu
 *      {@link SqlExec} answers a cursor with `.toArray()`. An array is an
 *      Iterable, so the port is that one call.
 *   2. THE SCHEDULER. Every Kinu Durable Object's alarm already belongs to
 *      something else — the Agents SDK on the orchestrator, the cron handler on
 *      the monitor — so fabric's timer-owning form does not fit. The
 *      scheduler-seam form hands each next due time to `schedule`, and the host
 *      folds it into the alarm it already owns.
 *
 * The import is the `outbox.js` SUBPATH, never the package root: fabric's root
 * barrel re-exports `bindings.ts`, whose `cloudflare:workers` import would
 * follow @kinu.run/core into the CLI. `outbox.ts`'s own import graph never reaches
 * it, so the subpath is portable and the barrel is not.
 */

import { outbox } from '@nimbus-sh/fabric/outbox.js';
import type { Outbox, ScheduledOutboxPolicy } from '@nimbus-sh/fabric/outbox.js';
import type { SqlExec } from '../types/primitives';

export type {
  Outbox,
  OutboxDeadLetter,
  OutboxDisposition,
  OutboxDrainResult,
  OutboxRecord,
  ScheduledOutboxPolicy,
} from '@nimbus-sh/fabric/outbox.js';

/**
 * One named outbox on one actor's storage, scheduled by the host's own alarm.
 * Rows live in `outbox_<name>`; the schema is created on first use.
 *
 * `M` is the stored message, `C` the per-drain state each `send` receives —
 * the email outbox's `SendEmail` binding is resolved per alarm and cannot be
 * closed over at construction.
 */
export function scheduledOutbox<M, C = void>(
  sql: SqlExec,
  name: string,
  policy: ScheduledOutboxPolicy<M, C>,
): Outbox<M, C> {
  return outbox<M, C>(
    { storage: { sql: { exec: (query, ...bindings) => sql.exec(query, ...bindings).toArray() } } },
    name,
    policy,
  );
}
