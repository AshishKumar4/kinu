// Email events in the hub — trust/priority derivation, dedupe, rendering,
// email_thread reply channels, the drain path, and the CHECK-widening
// rebuild that lets live DOs accept the new enum members.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initEventsHubTables, EventLog, ReplyChannelStore, TriggerRegistry,
  deriveEventTrust, derivePriority, deriveFields, dedupeKeyFor, renderForLLM,
  buildDrainBatch,
  type IngressDescriptor, type EmailPayload, type KinuEvent,
  type ReplyDispatcher,
} from '../src/events/hub/index';
import {
  EmailInbox, EMAIL_INBOUND_RATE_PER_MIN, initWebhookRateLimitTables, setEmailAllowlist,
  type SqlExec,
} from '../src/index';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { makeSqlExec } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';

/** One hub database and the ONE actor whose rows it holds.
 *
 *  `EventLog` is actor-scoped now, so the handle is part of the fixture rather
 *  than of the reader: a log bound to a fabricated id publishes rows no
 *  production reader resolves. Bound through the production directory. */
interface Hub {
  readonly sql: SqlExec;
  readonly actor: ActorHandle;
}

function makeSql(): Hub {
  const db = new Database(':memory:');
  return { sql: makeSqlExec(db), actor: createTestActorsOver(db).main };
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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
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
    const mk = (received_at: number, body?: string): KinuEvent => {
      const payload: EmailPayload = { ...base };
      if (body) payload.body_text = body;
      return {
        id: 'e', trace_id: 't', caused_by: null,
        ingress: 'email_inbound', variant: 'email',
        trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
        received_at, schema_version: 1, reply_channel: null, dedupe_key: null,
        payload,
      };
    };
    const k1 = dedupeKeyFor(mk(1000));
    const k2 = dedupeKeyFor(mk(2000));                    // same 5-min bucket
    const k3 = dedupeKeyFor(mk(6 * 60 * 1000));           // next bucket
    const k4 = dedupeKeyFor(mk(1000, 'different body'));
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);
  });
});

describe('email rendering for the LLM', () => {
  test('renderForLLM shows sender, subject, body and attachment count', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    log.publish({ descriptor: emailDescriptor('owner'), now: 1000 });
    const batch = buildDrainBatch(log.pending());
    expect(batch).not.toBeNull();
    expect(batch!.ids).toHaveLength(1);
    expect(batch!.text).toContain('email (owner@example.com)');
  });
});

describe('email_thread reply channels', () => {
  test('open → bindEvent → findOpenByEvent → reply dispatches through the email dispatcher', async () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const sent: unknown[] = [];
    const dispatcher: ReplyDispatcher = {
      async dispatch(_channel, payload) { sent.push(payload); return { delivered: true }; },
    };
    const store = new ReplyChannelStore(sql, actor, { email_thread: dispatcher });

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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const store = new ReplyChannelStore(sql, actor, {});
    const id = store.open({
      event_id: 'e', kind: 'email_thread', holder_addr: '{}', payload_policy: 'full',
    }, 0)!;
    const outcome = await store.reply(id, 'late', 25 * 60 * 60 * 1000);
    expect(outcome).toEqual({ outcome: 'channel_closed', state: 'expired' });
  });
});

/**
 * The inbox itself — the gate, the shared rate window, and the one thing an
 * agent can otherwise never learn: that its inbox is refusing mail right now.
 */
describe('the agent inbox', () => {
  const NOW = 1_700_000_000_000;

  function inbox(ownerEmail: string | null = 'owner@example.com') {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    initWebhookRateLimitTables(sql);
    const log = new EventLog(sql, actor);
    const triggers = new TriggerRegistry(sql, actor, { scheduleAt: async () => {} });
    const { vfs } = createMemoryVfs();
    let drains = 0;
    return {
      log, triggers,
      drains: () => drains,
      inbox: new EmailInbox({
        log, triggers, sql,
        replies: new ReplyChannelStore(sql, actor),
        vfs: () => vfs,
        ownerEmail: async () => ownerEmail,
        onAdmitted: () => { drains += 1; },
      }),
    };
  }

  const mail = (from: string, n = 1) => ({
    from, to: 'scout@agents.example.com', subject: `hello ${n}`, body_text: 'ping',
    message_id: `<m-${n}@example.com>`, in_reply_to: null, references: null,
    attachments: [], now: NOW,
  });

  test('the owner is admitted, a stranger is not, and an allowlisted sender is', async () => {
    const scene = inbox();

    expect(await scene.inbox.accept(mail('Owner <OWNER@example.com>')))
      .toMatchObject({ admitted: true, duplicate: false });
    expect(await scene.inbox.accept(mail('stranger@example.com', 2)))
      .toEqual({ admitted: false, reason: 'sender not authorized for this agent' });

    await setEmailAllowlist(scene.triggers, ['Ally <ally@example.com>'], NOW);
    expect(await scene.inbox.accept(mail('ally@example.com', 3))).toMatchObject({ admitted: true });

    expect(scene.log.pending({ variant: 'email' })).toHaveLength(2);
    expect(scene.drains()).toBe(2);
  });

  test('with no owner email resolvable, nothing is admitted', async () => {
    const scene = inbox(null);
    expect(await scene.inbox.accept(mail('owner@example.com')))
      .toEqual({ admitted: false, reason: 'agent owner email unknown' });
    expect(scene.log.pending({})).toEqual([]);
  });

  test('past the rate window the agent is told once, and told it is deaf until it resets', async () => {
    const scene = inbox();
    for (let n = 0; n <= EMAIL_INBOUND_RATE_PER_MIN; n += 1) {
      await scene.inbox.accept(mail('owner@example.com', n));
    }

    // The last one was refused…
    expect(await scene.inbox.accept(mail('owner@example.com', 999)))
      .toEqual({ admitted: false, reason: 'inbound email rate limit exceeded' });
    // …and the agent learns of it exactly once per window, not once per message.
    const notices = scene.log.pending({ variant: 'internal' });
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toMatchObject({ kind: 'email_inbound_rate_limited' });

    // The live line stays up while the window is still refusing…
    expect(scene.inbox.dropNotice(NOW)?.reason).toContain('you have NOT seen your inbox');
    // …and expires with it, so no turn is told about a deafness that has ended.
    expect(scene.inbox.dropNotice(NOW + 60_000)).toBeNull();
  });

  test('before anything is dropped there is no notice at all', () => {
    expect(inbox().inbox.dropNotice(NOW)).toBeNull();
  });
});
