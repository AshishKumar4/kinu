/**
 * Kinu port of `@nimbus-sh/fabric`'s durable outbox, scheduled via the host's existing alarm.
 * Import the `outbox.js` subpath only: the package root re-exports a `cloudflare:workers` import
 * that would follow @kinu.run/core into the CLI.
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

/** Rows live in `outbox_<name>`. `C` is per-drain state (e.g. a binding resolved per alarm). */
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
