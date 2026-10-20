// Inbound mail's words and threading: what the Mailbox files from a raw message (mail/parse.ts), what an owner's
// instruction keeps of it, how threading identity is bounded, and the agent being told its inbox went deaf. The
// recipient, verdict and wake are tested in unit-mail-router.test.ts, unit-mail-store.test.ts and core's
// unit-mail-verdict.test.ts and unit-events-hub-email.test.ts.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  initEventsHubTables, EventLog, ReplyChannelStore, admitMailArrival, boundedMessageId, boundedReferences, inboundEmailDropNotice,
  type KinuEvent, type MailArrival,
} from '@kinu.run/core';
import { parseMail } from '../src/mail/parse';
import { createMemoryVfs, createTestActorsOver, present } from '@kinu.run/test-utils';
import { sqlExec } from './helpers/user-do';

type EmailEvent = Extract<KinuEvent, { variant: 'email' }>;

function requireEmailEvent(log: EventLog, eventId: string): EmailEvent {
  const event = log.get(eventId);

  if (!event || (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') || event.variant !== 'email') {
    throw new Error(`expected readable email event ${eventId}`);
  }

  return event;
}

function admission() {
  const db = new Database(':memory:');
  const exec = sqlExec(db);

  initEventsHubTables(exec);
  const actor = createTestActorsOver(db).main;
  const log = new EventLog(exec, actor);
  const replies = new ReplyChannelStore(exec, actor, {});
  const { vfs } = createMemoryVfs();

  return { log, replies, deps: { log, replies, owner_email: 'ashish@kinu.run', tryConsumeRateLimit: () => true, vfs } };
}

function arrival(overrides: Partial<MailArrival> = {}): MailArrival {
  return {
    woke: 'owner', from: 'ashish@kinu.run', to: 'api-worker.ashish@kinu.run', subject: 'Worker error rate above 5%',
    instruction: 'Ship your fix to staging, and to production if the canary holds for 15 minutes.',
    message_id: '<alert-1@notify.cloudflare.com>', references: null, attachments: [],
    mail: { box: 'api-worker', thread: 't-alert', message: 'm-alert' }, now: 1_000, ...overrides,
  };
}

const message = (body: string, headers: readonly string[] = ['Content-Type: text/plain; charset=utf-8']): Uint8Array => new TextEncoder().encode([
  'From: Ashish Kumar Singh <ashish@kinu.run>', 'To: api-worker.ashish@kinu.run', 'Subject: Worker error rate above 5%', 'MIME-Version: 1.0',
  ...headers, '', body, '',
].join('\r\n'));

describe('an instruction is the words its sender wrote this time', () => {
  test('Gmail and Outlook quoted history and signatures are set aside, and the reader keeps the whole text', async () => {
    const gmail = await parseMail(message('Ship it to staging.\n\nOn Mon, 19 Oct 2026 at 18:40, Cloudflare <noreply@notify.cloudflare.com> wrote:\n> Error rate 7.2%'));

    expect(gmail.ownWords).toBe('Ship it to staging.');
    expect(gmail.text).toContain('> Error rate 7.2%');
    expect((await parseMail(message('Do it.\n-----Original Message-----\nFrom: x'))).ownWords).toBe('Do it.');
    expect((await parseMail(message('Do it.\n-- \nSent from my phone'))).ownWords).toBe('Do it.');
  });

  test('a message that is only a quote keeps the quote rather than nothing', async () => {
    expect((await parseMail(message('> just a quote\n> nothing else'))).ownWords).toBe('> just a quote\n> nothing else');
  });

  test('HTML-only mail reads as its text', async () => {
    const parsed = await parseMail(message('<div><p>Run the <b>tests</b></p><style>p{color:red}</style></div>', ['Content-Type: text/html']));

    expect(parsed.text).toBe('Run the tests');
    expect(parsed.html).toContain('<b>tests</b>');
  });

  test('threading headers, every address, and attachments with their bytes', async () => {
    const parsed = await parseMail(new TextEncoder().encode([
      'From: Dana Whitfield <dana@northwind.io>', 'To: scout.api-worker.ashish@kinu.run', 'Cc: "Ops, Northwind" <ops@northwind.io>',
      'Subject: Webhook deliveries to /hooks/v2 failing with 500', 'Message-ID: <hooks-v2-500@northwind.io>',
      'In-Reply-To: <prev@kinu.run>', 'References: <root@kinu.run> <prev@kinu.run>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'Since Tuesday every delivery gets a 500.', '--B',
      'Content-Type: text/csv', 'Content-Disposition: attachment; filename="failed-events.csv"', '', 'event,status', 'order.created,500', '--B--', '',
    ].join('\r\n')));

    expect(parsed).toMatchObject({
      from: { name: 'Dana Whitfield', address: 'dana@northwind.io' }, cc: [{ name: 'Ops, Northwind', address: 'ops@northwind.io' }],
      messageId: '<hooks-v2-500@northwind.io>', inReplyTo: '<prev@kinu.run>', references: ['<root@kinu.run>', '<prev@kinu.run>'],
    });
    expect(parsed.attachments.map((file) => [file.filename, file.contentType, new TextDecoder().decode(file.content).replaceAll('\r\n', '\n').trimEnd()]))
      .toEqual([['failed-events.csv', 'text/csv', 'event,status\norder.created,500']]);
  });
});

describe('threading identity is bounded at admission', () => {
  /** The 998-octet line minus the field name and its `: `. */
  const REFERENCES_BUDGET = 998 - 'References'.length - 2;

  test('a msg-id is admitted, repaired never, and refused when it cannot fit a line', () => {
    expect(boundedMessageId('<abc@mail.example.com>')).toBe('<abc@mail.example.com>');
    expect(boundedMessageId('  <abc@mail.example.com>  ')).toBe('<abc@mail.example.com>');
    // Not a msg-id: no brackets, or whitespace inside them.
    expect(boundedMessageId('abc@mail.example.com')).toBeNull();
    expect(boundedMessageId('<a b@x>')).toBeNull();
    expect(boundedMessageId(null)).toBeNull();
    // Null, not a truncation: a cut msg-id is a different identity.
    expect(boundedMessageId(`<${'x'.repeat(1_200)}@x>`)).toBeNull();
  });

  test('a chain past the line budget keeps the first id and the most recent', () => {
    const chain = Array.from({ length: 200 }, (_, i) => `<r${String(i).padStart(3, '0')}@x>`);
    const bounded = present(boundedReferences(chain.join(' '), '<answered@x>'), 'the bounded References header');

    expect(bounded.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    const kept = bounded.split(' ');
    expect(kept[0]).toBe('<r000@x>');
    // The tail threads this message, so the newest survive.
    expect(kept[kept.length - 1]).toBe('<answered@x>');
    expect(kept[kept.length - 2]).toBe('<r199@x>');
    expect(kept.length).toBeLessThan(201);
    expect(kept).not.toContain('<r001@x>');
  });

  test('an id already at the tail is not appended twice', () => {
    expect(boundedReferences('<a@x> <b@x>', '<b@x>')).toBe('<a@x> <b@x>');
    expect(boundedReferences(null, '<b@x>')).toBe('<b@x>');
    expect(boundedReferences(null, null)).toBeNull();
  });

  test('the stored event and the owner\'s reply thread both carry the bounded chain', async () => {
    const { deps, log, replies } = admission();
    const chain = Array.from({ length: 200 }, (_, i) => `<r${String(i).padStart(3, '0')}@x>`);
    const result = await admitMailArrival(deps, arrival({ references: chain.join(' ') }));

    if (!result.admitted || result.thread === null) throw new Error('unreachable');

    const payload = requireEmailEvent(log, result.event_id).payload;
    expect(present(payload.references, 'the event payload References').length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    // One authority: the payload and the reply address cannot disagree about the thread.
    const channel = present(replies.findOpenByEvent(result.event_id), 'the open reply channel for the event');
    const addr = v.parse(v.object({ references: v.nullable(v.string()), message_id: v.nullable(v.string()) }), JSON.parse(channel.holder_addr));

    expect(addr.references).toBe(payload.references);
    expect(result.thread.references).toBe(payload.references);
  });

  test('an unusable Message-ID is stored as absent rather than as itself', async () => {
    const { deps, log } = admission();
    const result = await admitMailArrival(deps, arrival({ message_id: 'not-a-message-id' }));

    if (!result.admitted) throw new Error('unreachable');
    expect(requireEmailEvent(log, result.event_id).payload.message_id).toBeNull();
  });

  test('a long instruction spills, and the brief cites the path', async () => {
    const { deps, log } = admission();
    const result = await admitMailArrival(deps, arrival({ instruction: `Ship it.\n${'Rollback steps if the canary fails. '.repeat(40)}` }));

    if (!result.admitted) throw new Error('unreachable');
    expect(requireEmailEvent(log, result.event_id).payload.body_path).toMatch(/^\.kinu\/event-content\//u);
  });

  test('the rate limit drops mail before anything is published', async () => {
    const { deps, log } = admission();

    expect(await admitMailArrival({ ...deps, tryConsumeRateLimit: () => false }, arrival())).toMatchObject({ admitted: false });
    expect(log.pending({})).toEqual([]);
  });
});

describe('the inbox gate says when it is deaf', () => {
  // A rate-limited delivery leaves no trace the agent can read: it silently goes deaf.
  const RESET_AT = 1_700_000_060_000;

  test('while the window is exhausted, the turn is told: with the limit and the reset', () => {
    const notice = inboundEmailDropNotice(30, RESET_AT, RESET_AT - 20_000);

    if (!notice) throw new Error('expected active rate-limit notice');
    expect(notice.source).toBe('inbound email');
    expect(notice.reason).toContain('30');
    expect(notice.reason).toContain(new Date(RESET_AT).toISOString());
  });

  test('once the window resets it says nothing: a deafness that ended is not news', () => {
    expect(inboundEmailDropNotice(30, RESET_AT, RESET_AT)).toBeNull();
    expect(inboundEmailDropNotice(30, RESET_AT, RESET_AT + 1)).toBeNull();
  });
});
