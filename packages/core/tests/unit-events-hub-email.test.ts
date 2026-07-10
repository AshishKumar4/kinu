// Email events in the hub — trust/priority derivation, dedupe, rendering,
// email_thread reply channels, the drain path, and the CHECK-widening
// rebuild that lets live DOs accept the new enum members.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initEventsHubTables, EventLog, ReplyChannelStore, TriggerRegistry,
  deriveEventTrust, derivePriority, deriveFields, dedupeKeyFor, renderForLLM,
  buildDrainBatch,
  type IngressDescriptor, type EmailPayload, type ProteusEvent,
  type ReplyDispatcher, type AlarmScheduler,
} from '../src/events/hub/index.ts';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

function makeSql(): SqlExec {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.query(query);
      const rows = stmt.all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
}

function emailPayload(overrides: Partial<EmailPayload> = {}): EmailPayload {
  return {
    from: 'owner@example.com',
    to: 'scout-a1b2c3@agents.example.com',
    subject: 'Please check the deploy',
    body_text: 'Is staging green?',
    message_id: '<msg-1@example.com>',
    in_reply_to: null,
    references: null,
    attachments: [],
    ...overrides,
  };
}

function emailDescriptor(
  sender_class: 'owner' | 'allowlisted',
  payload: Partial<EmailPayload> = {},
): IngressDescriptor {
  return {
    ingress: 'email_inbound', variant: 'email',
    payload: emailPayload(payload), sender_class,
  };
}

describe('email trust + priority derivation', () => {
  test('owner sender is capped at authenticated (never owner)', () => {
    expect(deriveEventTrust(emailDescriptor('owner'))).toBe('authenticated');
  });
  test('allowlisted sender runs at external', () => {
    expect(deriveEventTrust(emailDescriptor('allowlisted'))).toBe('external');
  });
  test('priority: owner email → normal, allowlisted → background', () => {
    expect(derivePriority('authenticated', 'email')).toBe('normal');
    expect(derivePriority('external', 'email')).toBe('background');
  });
  test('deriveFields is coherent for both classes', () => {
    expect(deriveFields(emailDescriptor('owner'))).toEqual({
      trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
    });
    // Allowlisted senders run at external trust, but the body stays readable
    // ('redact', not the external default 'hash') — the allowlist is an
    // explicit owner grant and the body is the turn input. Execution is
    // still gated by the external trust.
    expect(deriveFields(emailDescriptor('allowlisted'))).toEqual({
      trust: 'external', priority: 'background', payload_visibility: 'redact',
    });
  });
});

describe('email dedupe', () => {
  test('Message-ID is the idempotency key', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const r1 = log.publish({ descriptor: emailDescriptor('owner'), now: 1000 });
    expect(r1.admitted).toBe(true);
    // A retried delivery of the same message dedupes to the original event.
    const r2 = log.publish({ descriptor: emailDescriptor('owner'), now: 5000 });
    expect(r2.admitted).toBe(false);
    expect(r2.id).toBe(r1.id);
    // A different message admits.
    const r3 = log.publish({
      descriptor: emailDescriptor('owner', { message_id: '<msg-2@example.com>' }), now: 6000,
    });
    expect(r3.admitted).toBe(true);
  });

  test('missing Message-ID falls back to a content hash bucket', () => {
    const base = emailPayload({ message_id: null });
    const mk = (received_at: number, body?: string): ProteusEvent => ({
      id: 'e', trace_id: 't', caused_by: null,
      ingress: 'email_inbound', variant: 'email',
      trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
      received_at, schema_version: 1, reply_channel: null, dedupe_key: null,
      payload: { ...base, ...(body ? { body_text: body } : {}) },
    } as ProteusEvent);
    const k1 = dedupeKeyFor(mk(1000));
    const k2 = dedupeKeyFor(mk(2000));                    // same 5-min bucket
    const k3 = dedupeKeyFor(mk(6 * 60 * 1000));           // next bucket
    const k4 = dedupeKeyFor(mk(1000, 'different body'));
    expect(k1).toBe(k2!);
    expect(k1).not.toBe(k3!);
    expect(k1).not.toBe(k4!);
  });
});

describe('email rendering for the LLM', () => {
  test('renderForLLM shows sender, subject, body and attachment count', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const { id } = log.publish({
      descriptor: emailDescriptor('owner', {
        attachments: [{ filename: 'report.pdf', content_type: 'application/pdf', size: 123 }],
      }),
      now: 1000,
    });
    const event = log.get(id)!;
    const r = renderForLLM(event);
    expect(r.variant).toBe('email');
    expect(r.triggered_by).toBe('email (owner@example.com)');
    expect(r.brief).toContain('Please check the deploy');
    expect(r.brief).toContain('Is staging green?');
    expect(r.brief).toContain('1 attachment');
  });

  test('an email event drains into the wake batch', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    log.publish({ descriptor: emailDescriptor('owner'), now: 1000 });
    const batch = buildDrainBatch(log.pending());
    expect(batch).not.toBeNull();
    expect(batch!.ids).toHaveLength(1);
    expect(batch!.text).toContain('email (owner@example.com)');
  });
});

describe('email_thread reply channels', () => {
  test('open → bindEvent → findOpenByEvent → reply dispatches through the email dispatcher', async () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const sent: unknown[] = [];
    const dispatcher: ReplyDispatcher = {
      async dispatch(_channel, payload) { sent.push(payload); return { delivered: true }; },
    };
    const store = new ReplyChannelStore(sql, { email_thread: dispatcher });

    const id = store.open({
      event_id: 'pending', kind: 'email_thread',
      holder_addr: JSON.stringify({ to: 'owner@example.com' }), payload_policy: 'full',
    }, 1000)!;
    store.bindEvent(id, 'evt-1');

    const found = store.findOpenByEvent('evt-1');
    expect(found?.id).toBe(id);
    expect(found?.kind).toBe('email_thread');
    // 24h TTL.
    expect(found!.ttl_expires_at).toBe(1000 + 24 * 60 * 60 * 1000);

    const outcome = await store.reply(id, 'answer', 2000);
    expect(outcome).toEqual({ outcome: 'delivered' });
    expect(sent).toEqual(['answer']);
    expect(store.findOpenByEvent('evt-1')).toBeNull();     // replied ⇒ no longer open
  });

  test('an expired email_thread channel refuses dispatch', async () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const store = new ReplyChannelStore(sql, {});
    const id = store.open({
      event_id: 'e', kind: 'email_thread', holder_addr: '{}', payload_policy: 'full',
    }, 0)!;
    const outcome = await store.reply(id, 'late', 25 * 60 * 60 * 1000);
    expect(outcome).toEqual({ outcome: 'channel_closed', state: 'expired' });
  });
});

describe('CHECK-widening rebuild for live DOs', () => {
  /** The pre-email DDL as it exists on deployed DOs. */
  const OLD_REPLY_CHANNELS_DDL = `
    CREATE TABLE IF NOT EXISTS reply_channels (
      id                  TEXT    PRIMARY KEY,
      event_id            TEXT    NOT NULL,
      kind                TEXT    NOT NULL
                                  CHECK(kind IN ('ws_session', 'http_pending', 'peer_back', 'mcp_pending', 'none')),
      holder_addr         TEXT    NOT NULL DEFAULT '',
      ttl_expires_at      INTEGER NOT NULL,
      payload_policy      TEXT    NOT NULL DEFAULT 'full',
      state               TEXT    NOT NULL DEFAULT 'open'
                                  CHECK(state IN ('open', 'replied', 'expired', 'aborted')),
      reply_payload       TEXT,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    )`;
  const OLD_TRIGGERS_DDL = `
    CREATE TABLE IF NOT EXISTS triggers (
      id                  TEXT    PRIMARY KEY,
      kind                TEXT    NOT NULL
                                  CHECK(kind IN (
                                    'webhook_durable', 'webhook_ephemeral',
                                    'timer_oneshot', 'timer_cron',
                                    'process_watch', 'file_watch',
                                    'peer_inbox', 'mcp_route'
                                  )),
      spec                TEXT    NOT NULL DEFAULT '{}',
      creator_trust       TEXT    NOT NULL
                                  CHECK(creator_trust IN ('external', 'authenticated', 'owner', 'self')),
      fork_policy         TEXT
                                  CHECK(fork_policy IS NULL OR fork_policy IN ('copy', 'sever', 'share')),
      state               TEXT    NOT NULL DEFAULT 'active'
                                  CHECK(state IN ('active', 'paused', 'revoked')),
      rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
      created_at          INTEGER NOT NULL,
      paused_at           INTEGER,
      revoked_at          INTEGER,
      next_fire_at        INTEGER,
      last_fire_at        INTEGER,
      fire_count          INTEGER NOT NULL DEFAULT 0
    )`;

  const noAlarm: AlarmScheduler = { scheduleAt() {}, currentAlarm: () => null };

  test('existing rows survive the rebuild and the new enum members insert', () => {
    const sql = makeSql();
    // Simulate a live DO: old-CHECK tables with data already in them.
    sql.exec(OLD_REPLY_CHANNELS_DDL);
    sql.exec(OLD_TRIGGERS_DDL);
    const preStore = new ReplyChannelStore(sql, {});
    const preId = preStore.open({
      event_id: 'evt-old', kind: 'peer_back', holder_addr: 'peer:x', payload_policy: 'full',
    }, 500)!;
    const preReg = new TriggerRegistry(sql, noAlarm);
    const preTrigger = preReg.register({
      kind: 'timer_cron', spec: { cron: '* * * * *' }, creator_trust: 'owner',
    }, 500);

    // Boot-time init runs the rebuild.
    initEventsHubTables(sql);

    // Old rows preserved.
    const store = new ReplyChannelStore(sql, {});
    expect(store.get(preId)?.kind).toBe('peer_back');
    const reg = new TriggerRegistry(sql, noAlarm);
    expect(reg.get(preTrigger)?.kind).toBe('timer_cron');

    // New enum members now insert (the old CHECK would have thrown).
    const emailChannel = store.open({
      event_id: 'evt-new', kind: 'email_thread', holder_addr: '{}', payload_policy: 'full',
    }, 1000);
    expect(emailChannel).not.toBeNull();
    const emailTrigger = reg.register({
      kind: 'email_route', spec: { allow: ['friend@example.com'] }, creator_trust: 'owner',
    }, 1000);
    expect(reg.get(emailTrigger)?.kind).toBe('email_route');

    // Idempotent: a second init is a no-op.
    initEventsHubTables(sql);
    expect(store.get(preId)?.kind).toBe('peer_back');
    expect(reg.get(emailTrigger)?.kind).toBe('email_route');
  });
});
