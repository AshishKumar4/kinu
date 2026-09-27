/** Durable, TTL-bounded sink for one event's response; survives DO eviction. The channel is
 *  determined by the consumed event, never picked by the LLM. */

import * as v from 'valibot';
import {
  type ReplyChannelId, type ReplyChannelKind, type ReplyChannelRow,
  type ReplyChannelState, type EventId,
} from './types';
import { ulid } from './ulid';
import type { SqlExec } from '../../types/primitives';
import type { ActorHandle } from '../../identity/actor-handle';
import { parseJsonValue, type JsonValue } from '../../utils/json';
import { renderThrownChain } from '../../obs/index';

const TTL_MS = {
  http_pending: 30_000,
  peer_back: 24 * 60 * 60 * 1000,
  email_thread: 24 * 60 * 60 * 1000,
} satisfies Record<ReplyChannelKind, number>;

/** Implementations live in cf-backend. */
export interface ReplyDispatcher {
  dispatch(channel: ReplyChannelRow, payload: JsonValue): Promise<{ delivered: boolean; detail?: string }>;
}

const ReplyChannelRowSchema = v.object({
  id: v.string(),
  event_id: v.string(),
  kind: v.picklist(['http_pending', 'peer_back', 'email_thread']),
  holder_addr: v.string(),
  ttl_expires_at: v.number(),
  state: v.picklist(['open', 'replied', 'expired', 'aborted']),
  reply_payload: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

const IdRowSchema = v.object({ id: v.string() });

export interface OpenChannelOpts {
  event_id: EventId;
  kind: ReplyChannelKind;
  holder_addr: string;
  ttl_ms_override?: number;
}

export class ReplyChannelStore {
  private readonly actorId: string;

  /** Actor-scoped: a channel id alone is not authority over a sibling's open reply. */
  constructor(
    private readonly sql: SqlExec,
    private readonly actor: ActorHandle,
    private readonly dispatchers: Partial<Record<ReplyChannelKind, ReplyDispatcher>> = {},
  ) {
    this.actorId = actor.actorId;
  }

  open(opts: OpenChannelOpts, now: number): ReplyChannelId {
    this.actor.assertCurrent();
    const id = ulid();
    const expires = now + (opts.ttl_ms_override ?? TTL_MS[opts.kind]);
    this.sql.exec(
      `INSERT INTO reply_channels
         (actor_id, id, event_id, kind, holder_addr, ttl_expires_at,
          state, reply_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
      this.actorId, id, opts.event_id, opts.kind, opts.holder_addr, expires, now, now,
    );

    return id;
  }

  findOpenByEvent(event_id: EventId, kind?: ReplyChannelKind): ReplyChannelRow | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id FROM reply_channels
       WHERE actor_id = ? AND event_id = ? AND state = 'open'${kind ? ` AND kind = ?` : ''}
       ORDER BY created_at DESC LIMIT 1`,
      ...(kind ? [this.actorId, event_id, kind] : [this.actorId, event_id]),
    ).toArray().map((row) => v.parse(IdRowSchema, row));

    return rows.length > 0 ? this.get(rows[0].id) : null;
  }

  get(id: ReplyChannelId): ReplyChannelRow | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id, event_id, kind, holder_addr, ttl_expires_at,
              state, reply_payload, created_at, updated_at
       FROM reply_channels WHERE actor_id = ? AND id = ?`, this.actorId, id,
    ).toArray();

    if (rows.length === 0) return null;
    const r = v.parse(ReplyChannelRowSchema, rows[0]);

    return {
      id: r.id,
      event_id: r.event_id,
      kind: r.kind,
      holder_addr: r.holder_addr,
      ttl_expires_at: r.ttl_expires_at,
      state: r.state,
      reply_payload: r.reply_payload === null ? null : parseJsonValue(r.reply_payload),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  /** Channels are opened before publish so the event row can carry the ref. */
  bindEvent(id: ReplyChannelId, eventId: EventId): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE reply_channels SET event_id = ? WHERE actor_id = ? AND id = ?`,
      eventId, this.actorId, id,
    );
  }

  /** Callers append a `reply_attempt` audit row for every outcome except `channel_closed`. */
  async reply(id: ReplyChannelId, payload: JsonValue, now: number): Promise<ReplyOutcome> {
    const channel = this.get(id);

    if (!channel) return { outcome: 'channel_not_found' };

    if (channel.state !== 'open') return { outcome: 'channel_closed', state: channel.state };

    if (now > channel.ttl_expires_at) {
      this.markState(id, 'expired', now);

      return { outcome: 'channel_closed', state: 'expired' };
    }

    const dispatcher = this.dispatchers[channel.kind];

    if (!dispatcher) return { outcome: 'no_dispatcher', kind: channel.kind };

    try {
      const r = await dispatcher.dispatch(channel, payload);

      if (r.delivered) {
        this.sql.exec(
          `UPDATE reply_channels
             SET state = 'replied',
                 reply_payload = ?,
                 updated_at = ?
           WHERE actor_id = ? AND id = ?`,
          JSON.stringify(payload ?? null), now, this.actorId, id,
        );

        return { outcome: 'delivered' };
      }

      return { outcome: 'failed', detail: r.detail };
    } catch (err) {
      return { outcome: 'failed', detail: renderThrownChain({ cause: err }) };
    }
  }

  abort(id: ReplyChannelId, now: number, reason?: string): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE reply_channels
         SET state = 'aborted',
             reply_payload = COALESCE(?, reply_payload),
             updated_at = ?
       WHERE actor_id = ? AND id = ? AND state = 'open'`,
      reason ? JSON.stringify({ aborted: reason }) : null, now, this.actorId, id,
    );
  }

  private markState(id: ReplyChannelId, state: ReplyChannelState, now: number): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE reply_channels SET state = ?, updated_at = ? WHERE actor_id = ? AND id = ?`,
      state, now, this.actorId, id,
    );
  }
}

export type ReplyOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'channel_not_found' }
  | { outcome: 'channel_closed'; state: ReplyChannelState }
  | { outcome: 'no_dispatcher'; kind: ReplyChannelKind }
  | { outcome: 'failed'; detail?: string };
