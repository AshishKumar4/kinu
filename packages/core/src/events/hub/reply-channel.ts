/**
 * ReplyChannel — a durable, addressable, TTL-bounded sink for one event's
 * response. NOT a socket. Outlives DO eviction; survives crashes.
 *
 * Each kind has different TTL semantics + dispatcher:
 *
 *   ws_session    — open WebSocket; bound to socket lifetime
 *   http_pending  — held-open HTTP request; 30s TTL
 *   peer_back     — async reply to a peer agent; 24h TTL
 *   mcp_pending   — open MCP HTTP request; 60s TTL
 *   email_thread  — reply sent onto the inbound email's thread; 24h TTL
 *   none          — event has no reply channel (timer, file_watch, etc.)
 *
 * The single `reply()` LLM tool dispatches based on the channel bound to
 * the current event being processed. The LLM never picks the channel —
 * it's determined mechanically by the consumed event.
 */

import {
  type ReplyChannelId, type ReplyChannelKind, type ReplyChannelRow,
  type ReplyChannelState, type EventId, type PayloadPolicy,
} from './types.js';
import { ulid } from './ulid.js';
import type { SqlExec } from '../../types/primitives.js';

const TTL_MS: Record<Exclude<ReplyChannelKind, 'none'>, number> = {
  ws_session: 0,          // 0 → bound to holder, no clock-based expiry
  http_pending: 30_000,
  peer_back: 24 * 60 * 60 * 1000,
  mcp_pending: 60_000,
  email_thread: 24 * 60 * 60 * 1000,
};

/** Dispatcher that actually moves the reply over the wire. Implementations
 *  live in cf-backend (one per kind). */
export interface ReplyDispatcher {
  /** Deliver `payload` to the channel's `holder_addr`. Throws on transport
   *  failure; the caller retries via channel's attempt_count. */
  dispatch(channel: ReplyChannelRow, payload: unknown): Promise<{ delivered: boolean; detail?: string }>;
}

export interface OpenChannelOpts {
  event_id: EventId;
  kind: ReplyChannelKind;
  holder_addr: string;
  payload_policy: PayloadPolicy;
  /** Override default TTL; ignored for ws_session. */
  ttl_ms_override?: number;
}

export class ReplyChannelStore {
  constructor(
    private readonly sql: SqlExec,
    private readonly dispatchers: Partial<Record<ReplyChannelKind, ReplyDispatcher>> = {},
  ) {}

  /** Create a new channel. Returns the row's id. Channels for `kind='none'`
   *  return a sentinel id and are never persisted; the caller treats null
   *  reply intent the same way. */
  open(opts: OpenChannelOpts, now: number): ReplyChannelId | null {
    if (opts.kind === 'none') return null;
    const id = ulid();
    const ttl = opts.kind === 'ws_session'
      ? 0
      : opts.ttl_ms_override ?? TTL_MS[opts.kind];
    const expires = ttl === 0 ? 0 : now + ttl;
    this.sql.exec(
      `INSERT INTO reply_channels
         (id, event_id, kind, holder_addr, ttl_expires_at, payload_policy,
          state, reply_payload, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, 0, ?, ?)`,
      id, opts.event_id, opts.kind, opts.holder_addr, expires,
      opts.payload_policy, now, now,
    );
    return id;
  }

  /** The open channel bound to an event (optionally narrowed by kind). Used by
   *  reply tools that hold an event id, not a channel id — e.g. a peer answering
   *  the ask event it was woken with. */
  findOpenByEvent(event_id: EventId, kind?: ReplyChannelKind): ReplyChannelRow | null {
    const rows = this.sql.exec(
      `SELECT id FROM reply_channels
       WHERE event_id = ? AND state = 'open'${kind ? ` AND kind = ?` : ''}
       ORDER BY created_at DESC LIMIT 1`,
      ...(kind ? [event_id, kind] : [event_id]),
    ).toArray() as Array<{ id: string }>;
    return rows.length > 0 ? this.get(rows[0].id) : null;
  }

  get(id: ReplyChannelId): ReplyChannelRow | null {
    const rows = this.sql.exec(
      `SELECT id, event_id, kind, holder_addr, ttl_expires_at, payload_policy,
              state, reply_payload, attempt_count, created_at, updated_at
       FROM reply_channels WHERE id = ?`, id,
    ).toArray() as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      event_id: r.event_id as string,
      kind: r.kind as ReplyChannelKind,
      holder_addr: r.holder_addr as string,
      ttl_expires_at: r.ttl_expires_at as number,
      payload_policy: r.payload_policy as PayloadPolicy,
      state: r.state as ReplyChannelState,
      reply_payload: r.reply_payload != null ? JSON.parse(r.reply_payload as string) : null,
      attempt_count: r.attempt_count as number,
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
    };
  }

  /** Re-point a channel at its real event id (channels are opened before
   *  publish so the event row can carry the ref). */
  bindEvent(id: ReplyChannelId, eventId: EventId): void {
    this.sql.exec(
      `UPDATE reply_channels SET event_id = ? WHERE id = ?`, eventId, id,
    );
  }

  /** Mechanically dispatch a reply to a channel.
   *
   * Returns an outcome:
   *   - `delivered` — reply landed, channel transitioned to `replied`
   *   - `channel_closed` — channel was `replied`/`expired`/`aborted`; no-op
   *   - `failed` — transport error; attempt_count incremented; retry possible
   *   - `no_dispatcher` — no dispatcher registered for this channel kind
   *
   * In all cases except `channel_closed`, an audit row should be appended
   * to `agent_log` by the caller (kind='reply_attempt').
   */
  async reply(id: ReplyChannelId, payload: unknown, now: number): Promise<ReplyOutcome> {
    const channel = this.get(id);
    if (!channel) return { outcome: 'channel_not_found' };
    if (channel.state !== 'open') return { outcome: 'channel_closed', state: channel.state };

    // Expiry check (ws_session has TTL=0 — bound to holder, not clock).
    if (channel.kind !== 'ws_session' && now > channel.ttl_expires_at) {
      this.markState(id, 'expired', now);
      return { outcome: 'channel_closed', state: 'expired' };
    }

    const dispatcher = this.dispatchers[channel.kind];
    if (!dispatcher) {
      this.bumpAttempt(id, now);
      return { outcome: 'no_dispatcher', kind: channel.kind };
    }

    try {
      const r = await dispatcher.dispatch(channel, payload);
      if (r.delivered) {
        this.sql.exec(
          `UPDATE reply_channels
             SET state = 'replied',
                 reply_payload = ?,
                 attempt_count = attempt_count + 1,
                 updated_at = ?
           WHERE id = ?`,
          JSON.stringify(payload ?? null), now, id,
        );
        return { outcome: 'delivered' };
      }
      this.bumpAttempt(id, now);
      return { outcome: 'failed', detail: r.detail };
    } catch (err) {
      this.bumpAttempt(id, now);
      return { outcome: 'failed', detail: (err as Error).message };
    }
  }

  /** Mark a channel as aborted (e.g. on socket close). Idempotent. */
  abort(id: ReplyChannelId, now: number, reason?: string): void {
    this.sql.exec(
      `UPDATE reply_channels
         SET state = 'aborted',
             reply_payload = COALESCE(?, reply_payload),
             updated_at = ?
       WHERE id = ? AND state = 'open'`,
      reason ? JSON.stringify({ aborted: reason }) : null, now, id,
    );
  }

  /** Expire channels whose TTL has passed. Returns the number of channels
   *  expired. Currently unwired — no periodic caller exists. */
  expireDue(now: number): number {
    const before = this.countOpen();
    this.sql.exec(
      `UPDATE reply_channels
         SET state = 'expired',
             updated_at = ?
       WHERE state = 'open' AND ttl_expires_at > 0 AND ttl_expires_at < ?`,
      now, now,
    );
    return Math.max(0, before - this.countOpen());
  }

  private markState(id: ReplyChannelId, state: ReplyChannelState, now: number): void {
    this.sql.exec(
      `UPDATE reply_channels SET state = ?, updated_at = ? WHERE id = ?`,
      state, now, id,
    );
  }

  private bumpAttempt(id: ReplyChannelId, now: number): void {
    this.sql.exec(
      `UPDATE reply_channels SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`,
      now, id,
    );
  }

  private countOpen(): number {
    const rows = this.sql.exec(
      `SELECT COUNT(*) AS n FROM reply_channels WHERE state = 'open'`,
    ).toArray() as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }
}

export type ReplyOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'channel_not_found' }
  | { outcome: 'channel_closed'; state: ReplyChannelState }
  | { outcome: 'no_dispatcher'; kind: ReplyChannelKind }
  | { outcome: 'failed'; detail?: string };

