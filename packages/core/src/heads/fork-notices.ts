/**
 * The fork-interrupted notices a reconcile minted and the root's inbox has not yet taken. The row is the notice's only
 * carrier: the reconcile that mints it retired the forks it names, so no later reconcile mints it again. An attempt
 * stamps `started_at`; a row stamped before this activation began lost its attempt with that activation and is due
 * again, and one stamped since is in flight, so no wake re-delivers it.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, diagnostics, toKinuError, type KinuError } from '../obs/index';
import { JsonObjectSchema } from '../utils/json';
import { recoveryBackoffMs } from '../utils/recovery-backoff';
import type { AgentSignal, SendOutcome } from '../types/signals';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

/** Rows one wake starts; the rest stay due for the next. */
const NOTICES_PER_PASS = 16;

const NoticeSchema = v.object({
  kind: v.string(),
  text: v.string(),
  idempotencyKey: v.optional(v.string()),
  metadata: v.optional(JsonObjectSchema),
});

export interface ForkNotice {
  readonly key: string;
  /** Held as written; {@link decodeForkNotice} reads it. */
  readonly signal: string;
  readonly attempts: number;
}

function decodeForkNotice(signal: string): AgentSignal {
  return v.parse(NoticeSchema, JSON.parse(signal));
}

export function initForkNoticeTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS fork_notices (
    notice_key TEXT PRIMARY KEY,
    signal     TEXT NOT NULL,
    attempts   INTEGER NOT NULL,
    due_at     INTEGER NOT NULL,
    started_at INTEGER
  )`);
}

export class ForkNotices {
  constructor(private readonly sql: SqlExecutor, private readonly activationStartedAt: number) {}

  /** A notice already held under its key is the same notice: the key names the retired run set. */
  hold(key: string, signal: AgentSignal, now: number): void {
    const stored: v.InferOutput<typeof NoticeSchema> = { kind: signal.kind, text: signal.text };

    if (signal.idempotencyKey !== undefined) stored.idempotencyKey = signal.idempotencyKey;

    if (signal.metadata !== undefined) stored.metadata = signal.metadata;
    void this.sql`INSERT OR IGNORE INTO fork_notices (notice_key, signal, attempts, due_at, started_at)
      VALUES (${key}, ${JSON.stringify(stored)}, 0, ${now}, NULL)`;
  }

  /** Stamps each due row as started and returns it, so the caller starts every one it is handed exactly once. */
  start(now: number): ForkNotice[] {
    const rows = this.sql<{ notice_key: string; signal: string; attempts: number }>`
      UPDATE fork_notices SET started_at = ${now}
      WHERE notice_key IN (
        SELECT notice_key FROM fork_notices
        WHERE due_at <= ${now} AND (started_at IS NULL OR started_at < ${this.activationStartedAt})
        ORDER BY due_at LIMIT ${NOTICES_PER_PASS}
      )
      RETURNING notice_key, signal, attempts`;

    return rows.map((row) => ({ key: row.notice_key, signal: row.signal, attempts: row.attempts }));
  }

  /** The inbox took it. */
  delivered(key: string): void {
    void this.sql`DELETE FROM fork_notices WHERE notice_key = ${key}`;
  }

  /** The turn it opened came back undelivered: due again at the shared capped backoff, since an unpaced retry loops
   *  turns. Returns that instant. */
  refused(notice: ForkNotice, now: number): number {
    const dueAt = now + recoveryBackoffMs(notice.attempts + 1);

    void this.sql`UPDATE fork_notices SET attempts = ${notice.attempts + 1}, due_at = ${dueAt}, started_at = NULL
      WHERE notice_key = ${notice.key}`;

    return dueAt;
  }

  /** Soonest instant a notice not in flight is due, or null. */
  nextDueAt(): number | null {
    return this.sql<{ at: number | null }>`SELECT MIN(due_at) AS at FROM fork_notices
      WHERE started_at IS NULL OR started_at < ${this.activationStartedAt}`[0]?.at ?? null;
  }
}

/**
 * One delivery per due notice, each to be run detached. `undelivered` (the turn it opened failed or was pre-empted) and a
 * refused send leave it owed at the shared capped backoff, and `arm` names the wake for that instant; an undecodable row
 * can never be delivered and goes.
 */
export function forkNoticeDeliveries(
  notices: ForkNotices,
  deps: {
    readonly send: (signal: AgentSignal) => Promise<SendOutcome>;
    readonly arm: (dueAt: number) => Promise<void>;
    readonly workspace: string;
  },
  now: number,
): Effect.Effect<void>[] {
  return notices.start(now).map((notice) => {
    const owed = (): Effect.Effect<void, KinuError> => {
      diagnostics.event('head.fork_notice_owed', { workspace: deps.workspace, key: notice.key, attempts: notice.attempts + 1 });
      const dueAt = notices.refused(notice, Date.now());

      return attempt({ doing: 'arming the wake for an owed fork-interrupted notice', otherwise: 'io' }, () => deps.arm(dueAt));
    };

    const delivery = (signal: AgentSignal): Effect.Effect<void, KinuError> => attempt(
      { doing: 'delivering a fork-interrupted notice', otherwise: 'io' }, () => deps.send(signal),
    ).pipe(Effect.matchEffect({
      onSuccess: (outcome) => (outcome === 'undelivered' ? owed() : Effect.sync(() => { notices.delivered(notice.key); })),
      onFailure: (failure) => {
        diagnostics.failure('head.fork_notice_failed', failure, { workspace: deps.workspace });

        return owed();
      },
    }));

    return Effect.try({
      try: () => decodeForkNotice(notice.signal),
      catch: (cause) => toKinuError({ doing: 'decoding a held fork-interrupted notice', cause, otherwise: 'bad_input' }),
    }).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Effect.sync(() => {
          diagnostics.failure('head.fork_notice_undecodable', failure, { workspace: deps.workspace });
          notices.delivered(notice.key);
        }),
        onSuccess: delivery,
      }),
      Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('head.fork_notice_unarmed', failure, { workspace: deps.workspace }); })),
    );
  });
}
