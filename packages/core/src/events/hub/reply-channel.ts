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
import type { EventLog } from './log';
import type { JsonValue } from '../../utils/json';
import { Effect } from 'effect';
import { renderThrownChain, settle } from '../../obs/index';

const TTL_MS = {
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
  kind: v.picklist(['peer_back', 'email_thread']),
  holder_addr: v.string(),
  ttl_expires_at: v.number(),
  state: v.picklist(['open', 'replied', 'expired', 'aborted']),
  created_at: v.number(),
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
         (actor_id, id, event_id, kind, holder_addr, ttl_expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      this.actorId, id, opts.event_id, opts.kind, opts.holder_addr, expires, now,
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
      `SELECT id, event_id, kind, holder_addr, ttl_expires_at, state, created_at
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
      created_at: r.created_at,
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
      this.markState(id, 'expired');

      return { outcome: 'channel_closed', state: 'expired' };
    }

    const dispatcher = this.dispatchers[channel.kind];

    if (!dispatcher) return { outcome: 'no_dispatcher', kind: channel.kind };

    return settle(Effect.tryPromise({ try: () => dispatcher.dispatch(channel, payload), catch: (cause) => ({ cause }) }).pipe(Effect.match({
      onSuccess: (r): ReplyOutcome => {
        if (!r.delivered) return { outcome: 'failed', detail: r.detail };
        // The channel keeps that it was answered; the reply itself went out through its dispatcher.
        this.markState(id, 'replied');

        return { outcome: 'delivered' };
      },
      onFailure: (failed): ReplyOutcome => ({ outcome: 'failed', detail: renderThrownChain(failed) }),
    })));
  }

  /** Closes an open channel no reply will travel: its event was a duplicate, or its turn ended without a word. */
  abort(id: ReplyChannelId): void {
    this.actor.assertCurrent();
    this.sql.exec(`UPDATE reply_channels SET state = 'aborted' WHERE actor_id = ? AND id = ? AND state = 'open'`, this.actorId, id);
  }

  private markState(id: ReplyChannelId, state: ReplyChannelState): void {
    this.actor.assertCurrent();
    this.sql.exec(`UPDATE reply_channels SET state = ? WHERE actor_id = ? AND id = ?`, state, this.actorId, id);
  }
}

export type ReplyOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'channel_not_found' }
  | { outcome: 'channel_closed'; state: ReplyChannelState }
  | { outcome: 'no_dispatcher'; kind: ReplyChannelKind }
  | { outcome: 'failed'; detail?: string };

/** `pending` stays true while a retryable email channel is still open. */
export interface EmailReplyDispatchResult {
  delivered: number;
  pending: boolean;
}

/**
 * A settled turn's reply to the mail that started it: sent on every open `email_thread` channel its events opened, each
 * attempt audited as a `reply_attempt` row. A turn that ended without a word answered with silence: its channels close
 * with nothing sent, as an open one owed the reply each wake, once a minute for as long as it stood.
 */
export async function dispatchEmailRepliesForTurn(
  deps: { log: EventLog; replies: ReplyChannelStore },
  drainTurnId: string,
  replyText: string,
  now: number,
): Promise<EmailReplyDispatchResult> {
  const events = deps.log.query({ turn_id: drainTurnId, variant: 'email' });

  if (!replyText.trim()) {
    for (const event of events) {
      const channel = deps.replies.findOpenByEvent(event.id, 'email_thread');

      if (channel !== null) deps.replies.abort(channel.id);
    }

    return { delivered: 0, pending: false };
  }

  let delivered = 0;

  for (const ev of events) {
    const channel = deps.replies.findOpenByEvent(ev.id);

    if (!channel || channel.kind !== 'email_thread') continue;
    const outcome = await deps.replies.reply(channel.id, replyText, now);
    deps.log.appendNonEventRow({
      kind: 'reply_attempt',
      turn_id: drainTurnId,
      step_idx: null,
      parent_id: ev.id,
      trace_id: ev.trace_id,
      payload: { channel_id: channel.id, kind: 'email_thread', outcome },
      now,
    });

    if (outcome.outcome === 'delivered') delivered++;
  }

  return {
    delivered,
    pending: events.some((event) => deps.replies.findOpenByEvent(event.id, 'email_thread') !== null),
  };
}
