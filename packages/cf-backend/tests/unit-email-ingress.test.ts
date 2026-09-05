// Mission Inbox — inbound side. Addressing (recipient → agent), MIME parsing
// + quoted-history stripping, the sender trust gate (owner / allowlist /
// dropped), Message-ID dedupe, the rate limit, and the Worker-level routing
// seam. Mocks live only at the email seam (raw MIME in, RPC target out).
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  initEventsHubTables, EventLog, ReplyChannelStore, buildDrainBatch,
  acceptInboundEmail, boundedMessageId, boundedReferences,
  inboundEmailDropNotice, normalizeEmailAddress,
  type EmailIngressDeps, type IncomingEmail, type KinuEvent, type SqlExec,
} from '@kinu.run/core';
import {
  agentEmailAddress, agentNameFromRecipient, parseInboundMime,
} from '../src/email/inbound';
import {
  routeInboundEmail, type EmailDeliveryTarget,
} from '../src/email/route';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { sqlExec } from './helpers/user-do';

function makeSql(): SqlExec {
  return sqlExec(new Database(':memory:'));
}

const DOMAIN = 'agents.example.com';
type EmailEvent = Extract<KinuEvent, { variant: 'email' }>;

function requireEmailEvent(log: EventLog, eventId: string): EmailEvent {
  const event = log.get(eventId);
  if (!event || (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact')
    || event.variant !== 'email') {
    throw new Error(`expected readable email event ${eventId}`);
  }
  return event;
}

function makeDeps(overrides: Partial<EmailIngressDeps> = {}) {
  const sql = makeSql();
  initEventsHubTables(sql);
  const log = new EventLog(sql);
  const replies = new ReplyChannelStore(sql, {});
  const { vfs, files } = createMemoryVfs();
  const deps: EmailIngressDeps = {
    log, replies,
    owner_email: 'owner@example.com',
    allowlist: [],
    tryConsumeRateLimit: () => true,
    vfs,
    ...overrides,
  };
  return { deps, log, replies, sql, files };
}

function incoming(overrides: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    from: 'owner@example.com',
    to: `scout-a1b2c3@${DOMAIN}`,
    subject: 'Check the deploy',
    body_text: 'Is staging green?',
    message_id: '<abc@mail.example.com>',
    in_reply_to: null,
    references: null,
    attachments: [],
    now: 1_000,
    ...overrides,
  };
}

describe('addressing', () => {
  test('local part is the agent name; +tag and case are tolerated', () => {
    expect(agentNameFromRecipient(`scout-a1b2c3@${DOMAIN}`, DOMAIN)).toBe('scout-a1b2c3');
    expect(agentNameFromRecipient(`Scout-A1B2C3+notes@${DOMAIN}`, DOMAIN)).toBe('scout-a1b2c3');
    expect(agentNameFromRecipient(`Agent Scout <scout-a1b2c3@${DOMAIN}>`, DOMAIN)).toBe('scout-a1b2c3');
  });
  test('wrong domain, missing domain config, or bad local part → unroutable', () => {
    expect(agentNameFromRecipient('scout-a1b2c3@evil.example.com', DOMAIN)).toBeNull();
    expect(agentNameFromRecipient(`scout-a1b2c3@${DOMAIN}`, undefined)).toBeNull();
    expect(agentNameFromRecipient(`not a name!@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(agentNameFromRecipient('no-at-sign', DOMAIN)).toBeNull();
  });
  test('normalizeEmailAddress strips display names and lowercases', () => {
    expect(normalizeEmailAddress('Owner <Owner@Example.COM>')).toBe('owner@example.com');
    expect(normalizeEmailAddress('  owner@example.com  ')).toBe('owner@example.com');
  });
  test('agentEmailAddress builds the canonical address', () => {
    expect(agentEmailAddress('Scout-A1B2C3', 'Agents.Example.COM')).toBe(`scout-a1b2c3@${DOMAIN}`);
  });
});

/** The text MIME part `text` parses to, through the production parse. */
async function strippedBody(text: string): Promise<string> {
  const raw = [
    'From: owner@example.com',
    `To: scout-a1b2c3@${DOMAIN}`,
    'Subject: strip',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
  ].join('\r\n');
  return (await parseInboundMime(await new Blob([raw]).arrayBuffer())).body_text;
}

describe('quoted history never reaches turn input', () => {
  test('cuts Gmail-style quoted history', async () => {
    const text = 'Yes please deploy.\n\nOn Mon, Jun 1, 2026 at 9:00 AM Agent <a@b.c> wrote:\n> earlier\n> stuff';
    expect(await strippedBody(text)).toBe('Yes please deploy.');
  });
  test('cuts Outlook original-message blocks and signatures', async () => {
    expect(await strippedBody('Do it.\n-----Original Message-----\nFrom: x')).toBe('Do it.');
    expect(await strippedBody('Do it.\n-- \nSent from my phone')).toBe('Do it.');
  });
  test('falls back to the full text when stripping would leave nothing', async () => {
    expect(await strippedBody('> just a quote\n> nothing else')).toBe('> just a quote\n> nothing else');
  });
});
describe('parseInboundMime', () => {
  test('extracts subject, new text, threading headers, attachment metadata', async () => {
    const raw = [
      'From: Owner <owner@example.com>',
      `To: scout-a1b2c3@${DOMAIN}`,
      'Subject: Check the deploy',
      'Message-ID: <abc@mail.example.com>',
      'In-Reply-To: <prev@mail.example.com>',
      'References: <root@mail.example.com> <prev@mail.example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'Is staging green?',
      '',
      'On Mon, Jun 1, 2026, the agent wrote:',
      '> previously',
      '--B',
      'Content-Type: text/csv',
      'Content-Disposition: attachment; filename="report.csv"',
      '',
      'a,b',
      '1,2',
      '--B--',
      '',
    ].join('\r\n');
    const parsed = await parseInboundMime(await new Blob([raw]).arrayBuffer());
    expect(parsed.subject).toBe('Check the deploy');
    expect(parsed.body_text).toBe('Is staging green?');
    expect(parsed.message_id).toBe('<abc@mail.example.com>');
    expect(parsed.in_reply_to).toBe('<prev@mail.example.com>');
    expect(parsed.references).toBe('<root@mail.example.com> <prev@mail.example.com>');
    expect(parsed.attachments).toEqual([
      { filename: 'report.csv', content_type: 'text/csv', size: expect.any(Number) },
    ]);
  });

  test('HTML-only mail degrades to stripped text', async () => {
    const raw = [
      'From: owner@example.com',
      `To: scout-a1b2c3@${DOMAIN}`,
      'Subject: hi',
      'Content-Type: text/html',
      '',
      '<div><p>Run the <b>tests</b></p><style>p{color:red}</style></div>',
    ].join('\r\n');
    const parsed = await parseInboundMime(await new Blob([raw]).arrayBuffer());
    expect(parsed.body_text).toBe('Run the tests');
  });
});

describe('acceptInboundEmail — the trust gate', () => {
  test('the owner drives a turn: event admitted at authenticated trust with a thread channel', async () => {
    const { deps, log, replies } = makeDeps();
    const result = await acceptInboundEmail(deps, incoming());
    expect(result).toMatchObject({ admitted: true, duplicate: false, sender_class: 'owner' });
    if (!result.admitted) throw new Error('unreachable');

    const event = requireEmailEvent(log, result.event_id);
    expect(event.variant).toBe('email');
    expect(event.trust).toBe('authenticated');       // capped — never owner
    expect(event.priority).toBe('normal');

    // The thread reply channel is bound to the event and carries threading.
    const channel = replies.findOpenByEvent(result.event_id)!;
    expect(channel.kind).toBe('email_thread');
    expect(v.parse(v.object({
      to: v.string(), from: v.string(), subject: v.string(), message_id: v.nullable(v.string()),
    }), JSON.parse(channel.holder_addr))).toMatchObject({
      to: 'owner@example.com',
      from: `scout-a1b2c3@${DOMAIN}`,
      subject: 'Check the deploy',
      message_id: '<abc@mail.example.com>',
    });

    // The event wakes a turn: it appears in the drain batch.
    const batch = buildDrainBatch(log.pending());
    expect(batch!.ids).toContain(result.event_id);
    expect(batch!.text).toContain('email (owner@example.com)');
  });

  test('owner match ignores case and display-name wrappers', async () => {
    const { deps } = makeDeps({ owner_email: 'Owner@Example.COM' });
    const result = await acceptInboundEmail(deps, incoming({ from: 'Owner <owner@example.com>' }));
    expect(result).toMatchObject({ admitted: true, sender_class: 'owner' });
  });

  test('an unknown sender is dropped — no event row, no reply channel', async () => {
    const { deps, log, sql } = makeDeps();
    const result = await acceptInboundEmail(deps, incoming({ from: 'attacker@evil.example.com' }));
    expect(result).toEqual({ admitted: false, reason: 'sender not authorized for this agent' });
    expect(log.pending()).toHaveLength(0);
    expect(sql.exec(`SELECT COUNT(*) AS n FROM reply_channels`).toArray()[0].n).toBe(0);
  });

  test('an allowlisted sender is admitted at external trust', async () => {
    const { deps, log } = makeDeps({ allowlist: ['Friend@Example.com'] });
    const result = await acceptInboundEmail(deps, incoming({ from: 'friend@example.com' }));
    expect(result).toMatchObject({ admitted: true, sender_class: 'allowlisted' });
    if (!result.admitted) throw new Error('unreachable');
    const event = log.get(result.event_id)!;
    expect(event.trust).toBe('external');
    expect(event.priority).toBe('background');
  });

  test('a retried delivery of the same Message-ID dedupes and aborts its extra channel', async () => {
    const { deps, log, sql } = makeDeps();
    const first = await acceptInboundEmail(deps, incoming());
    const retry = await acceptInboundEmail(deps, incoming({ now: 9_000 }));
    expect(retry).toMatchObject({ admitted: true, duplicate: true });
    if (!first.admitted || !retry.admitted) throw new Error('unreachable');
    expect(retry.event_id).toBe(first.event_id);
    expect(log.pending()).toHaveLength(1);
    const states = sql.exec(`SELECT state FROM reply_channels ORDER BY created_at`).toArray();
    expect(states.map((r) => r.state)).toEqual(['open', 'aborted']);
  });

  test('the rate limit drops mail before publish', async () => {
    const { deps, log } = makeDeps({ tryConsumeRateLimit: () => false });
    const result = await acceptInboundEmail(deps, incoming());
    expect(result).toEqual({ admitted: false, reason: 'inbound email rate limit exceeded' });
    expect(log.pending()).toHaveLength(0);
  });

  test('a long mail spills its body and the brief cites the path', async () => {
    // The agent is woken BY this message. A brief that silently holds its
    // first few hundred characters leaves it reading a fragment it cannot
    // tell is a fragment, with nothing to read the rest from.
    const { deps, log, files } = makeDeps();
    const body = `URGENT-HEAD ${'detail '.repeat(400)}ACTION-TAIL`;
    const result = await acceptInboundEmail(deps, incoming({ body_text: body }));
    if (!result.admitted) throw new Error('unreachable');

    const payload = requireEmailEvent(log, result.event_id).payload;
    expect(payload.body_path).toBeTruthy();
    if (!payload.body_path) throw new Error('expected spilled email body path');
    expect(files.get(payload.body_path)).toBe(body);

    const batch = buildDrainBatch(log.pending());
    if (!batch) throw new Error('expected pending email drain batch');
    expect(batch.text).toContain(payload.body_path);
    expect(batch.text).toContain('chars omitted');
    expect(batch.text).toContain('URGENT-HEAD');
    expect(batch.text).toContain('ACTION-TAIL');
  });

  test('mail that fits the brief is not spilled — a reference would be noise', async () => {
    const { deps, log } = makeDeps();
    const result = await acceptInboundEmail(deps, incoming());
    if (!result.admitted) throw new Error('unreachable');
    expect(requireEmailEvent(log, result.event_id).payload.body_path).toBeUndefined();
    const batch = buildDrainBatch(log.pending());
    if (!batch) throw new Error('expected pending email drain batch');
    expect(batch.text).toContain('Is staging green?');
  });
});

// KINU-054, the header half. Every id in a References chain arrives from
// outside, the chain only ever grows, and nothing in the protocol shortens it.
// Left alone it becomes a header no receiver is obliged to accept — RFC 5322
// §2.1.1 puts the whole field, name included, inside 998 octets.
describe('threading identity is bounded at admission', () => {
  /** The field body budget for `References`, from the protocol: the 998-octet
   *  line minus the field name and its `: `. */
  const REFERENCES_BUDGET = 998 - 'References'.length - 2;

  test('a msg-id is admitted, repaired never, and refused when it cannot fit a line', () => {
    expect(boundedMessageId('<abc@mail.example.com>')).toBe('<abc@mail.example.com>');
    expect(boundedMessageId('  <abc@mail.example.com>  ')).toBe('<abc@mail.example.com>');
    // Not a msg-id: no brackets, or whitespace inside them.
    expect(boundedMessageId('abc@mail.example.com')).toBeNull();
    expect(boundedMessageId('<a b@x>')).toBeNull();
    expect(boundedMessageId(null)).toBeNull();
    // Longer than a line can carry. Null, not a truncation: a cut msg-id is a
    // DIFFERENT identity, and threading on it would silently thread on nothing.
    expect(boundedMessageId(`<${'x'.repeat(1_200)}@x>`)).toBeNull();
  });

  test('a chain past the line budget keeps the first id and the most recent', () => {
    const chain = Array.from({ length: 200 }, (_, i) => `<r${String(i).padStart(3, '0')}@x>`);
    const bounded = boundedReferences(chain.join(' '), '<answered@x>')!;

    expect(bounded.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    const kept = bounded.split(' ');
    // The first id is what a reader threads the whole conversation under.
    expect(kept[0]).toBe('<r000@x>');
    // The tail is what it threads THIS message under, so the newest survive.
    expect(kept[kept.length - 1]).toBe('<answered@x>');
    expect(kept[kept.length - 2]).toBe('<r199@x>');
    // Trimming came from the middle, so entries were genuinely dropped.
    expect(kept.length).toBeLessThan(201);
    expect(kept).not.toContain('<r001@x>');
  });

  test('an id already at the tail is not appended twice', () => {
    expect(boundedReferences('<a@x> <b@x>', '<b@x>')).toBe('<a@x> <b@x>');
    expect(boundedReferences(null, '<b@x>')).toBe('<b@x>');
    expect(boundedReferences(null, null)).toBeNull();
  });

  test('the stored event and the thread channel both carry the bounded chain', async () => {
    const { deps, log, replies } = makeDeps();
    const chain = Array.from({ length: 200 }, (_, i) => `<r${String(i).padStart(3, '0')}@x>`);
    const result = await acceptInboundEmail(deps, incoming({ references: chain.join(' ') }));
    if (!result.admitted) throw new Error('unreachable');

    const payload = requireEmailEvent(log, result.event_id).payload;
    expect(payload.references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    // One authority: the payload the model reads and the address the reply is
    // sent from cannot disagree about which thread this is.
    const channel = replies.findOpenByEvent(result.event_id)!;
    const addr = v.parse(
      v.object({ references: v.nullable(v.string()), message_id: v.nullable(v.string()) }),
      JSON.parse(channel.holder_addr),
    );
    expect(addr.references).toBe(payload.references);
    expect(result.thread.references).toBe(payload.references);
  });

  test('an unusable Message-ID is stored as absent rather than as itself', async () => {
    const { deps, log } = makeDeps();
    const result = await acceptInboundEmail(deps, incoming({
      message_id: 'not-a-message-id', in_reply_to: '<ok@x>',
    }));
    if (!result.admitted) throw new Error('unreachable');
    const payload = requireEmailEvent(log, result.event_id).payload;
    expect(payload.message_id).toBeNull();
    expect(payload.in_reply_to).toBe('<ok@x>');
  });
});

describe('the inbox gate says when it is deaf', () => {
  // A rate-limited delivery leaves no trace the agent can read: the sender
  // gets nothing, nothing is stored, and the agent goes on believing it has
  // seen its inbox. A reply storm or a list subscription makes it silently
  // deaf for a whole minute.
  const RESET_AT = 1_700_000_060_000;

  test('while the window is exhausted, the turn is told — with the limit and the reset', () => {
    const notice = inboundEmailDropNotice(30, RESET_AT, RESET_AT - 20_000);
    if (!notice) throw new Error('expected active rate-limit notice');
    expect(notice.source).toBe('inbound email');
    expect(notice.reason).toContain('more than 30 messages');
    expect(notice.reason).toContain(new Date(RESET_AT).toISOString());
    expect(notice.reason).toContain('have NOT seen your inbox');
  });

  test('once the window resets it says nothing — a deafness that ended is not news', () => {
    expect(inboundEmailDropNotice(30, RESET_AT, RESET_AT)).toBeNull();
    expect(inboundEmailDropNotice(30, RESET_AT, RESET_AT + 1)).toBeNull();
  });
});

describe('routeInboundEmail — the Worker seam', () => {
  /** A target that accepts whoever asks — the pre-parse gate's happy answer. */
  function target(over: Partial<EmailDeliveryTarget> = {}): EmailDeliveryTarget {
    return {
      authorizeEmailSender: async () => ({ authorized: true }),
      acceptEmailDelivery: async () => ({ admitted: true, duplicate: false }),
      ...over,
    };
  }

  function mockMessage(opts: {
    from?: string; to?: string; raw?: string; headers?: Record<string, string>; rawSize?: number;
  } = {}) {
    const raw = opts.raw ?? [
      'From: owner@example.com',
      `To: ${opts.to ?? `scout-a1b2c3@${DOMAIN}`}`,
      'Subject: Check the deploy',
      'Message-ID: <abc@mail.example.com>',
      'Content-Type: text/plain',
      '',
      'Is staging green?',
    ].join('\r\n');
    const body = new Response(raw).body;
    if (!body) throw new Error('expected response body stream');
    return {
      from: opts.from ?? 'owner@example.com',
      to: opts.to ?? `scout-a1b2c3@${DOMAIN}`,
      headers: new Headers({ 'message-id': '<abc@mail.example.com>', ...opts.headers }),
      raw: body,
      rawSize: opts.rawSize ?? raw.length,
    };
  }

  test('delivers the parsed email to the agent named by the recipient', async () => {
    const deliveries: Array<Parameters<EmailDeliveryTarget['acceptEmailDelivery']>[0]> = [];
    const resolved: string[] = [];
    const result = await routeInboundEmail(mockMessage(), DOMAIN, async (name) => {
      resolved.push(name);
      return target({
        acceptEmailDelivery: async (opts) => {
          deliveries.push(opts);
          return { admitted: true, duplicate: false };
        },
      });
    }, 42);

    expect(result).toEqual({ outcome: 'admitted', agent: 'scout-a1b2c3' });
    expect(resolved).toEqual(['scout-a1b2c3']);
    expect(deliveries[0]).toMatchObject({
      from: 'owner@example.com',
      to: `scout-a1b2c3@${DOMAIN}`,
      subject: 'Check the deploy',
      body_text: 'Is staging green?',
      message_id: '<abc@mail.example.com>',
      now: 42,
    });
  });

  test('unroutable recipients are dropped without touching any agent', async () => {
    let resolves = 0;
    const result = await routeInboundEmail(
      mockMessage({ to: 'anyone@wrong-domain.example.com' }),
      DOMAIN,
      async () => { resolves++; return target(); },
    );
    expect(result.outcome).toBe('dropped');
    expect(resolves).toBe(0);
  });

  test('auto-reply / bulk mail (RFC 3834) is dropped before any agent is touched', async () => {
    let resolves = 0;
    const autoReplyHeaders: Array<Record<string, string>> = [
      { 'auto-submitted': 'auto-replied' },
      { precedence: 'bulk' },
      { 'list-id': '<newsletter.example.com>' },
      { 'x-auto-response-suppress': 'All' },
    ];
    for (const headers of autoReplyHeaders) {
      const result = await routeInboundEmail(mockMessage({ headers }), DOMAIN, async () => {
        resolves++;
        return target();
      });
      expect(result).toEqual({ outcome: 'dropped', agent: 'scout-a1b2c3', reason: 'auto-reply (RFC 3834)' });
    }
    expect(resolves).toBe(0);
  });

  test('Auto-Submitted: no is human mail and still drives a turn', async () => {
    const result = await routeInboundEmail(
      mockMessage({ headers: { 'auto-submitted': 'no' } }), DOMAIN, async () => target(),
    );
    expect(result).toEqual({ outcome: 'admitted', agent: 'scout-a1b2c3' });
  });

  test('a gate rejection surfaces as dropped with the agent reason', async () => {
    const result = await routeInboundEmail(mockMessage(), DOMAIN, async () => target({
      acceptEmailDelivery: async () => ({ admitted: false, reason: 'inbound email rate limit exceeded' }),
    }));
    expect(result).toEqual({
      outcome: 'dropped', agent: 'scout-a1b2c3', reason: 'inbound email rate limit exceeded',
    });
  });

  test('an unauthorized sender is refused BEFORE the message is read or parsed', async () => {
    // The defect: the whole raw stream was buffered and PostalMime parsed every
    // body and attachment before anything asked who the sender was — the first
    // owner/allowlist comparison ran inside the agent, after the parse.
    let pulled = false;
    const message = mockMessage({ from: 'stranger@elsewhere.example' });
    const watched = {
      ...message,
      // `highWaterMark: 0` so nothing is pulled until a READER asks, which is
      // the thing that must not happen for a sender the agent does not accept.
      raw: new ReadableStream<Uint8Array>(
        { pull(controller) { pulled = true; controller.close(); } },
        { highWaterMark: 0 },
      ),
    };

    const result = await routeInboundEmail(watched, DOMAIN, async () => target({
      authorizeEmailSender: async () => ({ authorized: false, reason: 'sender not authorized for this agent' }),
      acceptEmailDelivery: async () => { throw new Error('an unauthorized message reached the delivery'); },
    }));

    expect(result).toEqual({
      outcome: 'dropped', agent: 'scout-a1b2c3', reason: 'sender not authorized for this agent',
    });
    expect(pulled).toBe(false);
  });

  test('a message over the byte ceiling is dropped without resolving an agent', async () => {
    let resolves = 0;
    // Sized clearly over any ceiling the route sets. The ceiling itself is
    // read from the refusal the route hands back, never restated here.
    const result = await routeInboundEmail(
      mockMessage({ rawSize: 10 * 1024 * 1024 }),
      DOMAIN,
      async () => { resolves++; return target(); },
    );
    expect(result).toEqual({
      outcome: 'dropped',
      agent: 'scout-a1b2c3',
      reason: expect.stringContaining('message over the 2 MiB inbound limit'),
    });
    expect(resolves).toBe(0);
  });

  test('a message that LIES about its size is refused by the count of arriving bytes', async () => {
    // `rawSize` is the edge's claim and the pre-filter; the gate is the count,
    // so a stream that keeps arriving past the limit is cut off there rather
    // than assembled. Sized clearly over, for the same reason as above.
    const oversize = 'x'.repeat(3 * 1024 * 1024);
    const body = new Response(`Subject: big\r\n\r\n${oversize}`).body;
    if (!body) throw new Error('expected response body stream');
    let parsedFor: string | null = null;
    const result = await routeInboundEmail(
      { ...mockMessage(), raw: body, rawSize: 10 },
      DOMAIN,
      async () => target({
        acceptEmailDelivery: async (opts) => { parsedFor = opts.from; return { admitted: true }; },
      }),
    );
    expect(result.outcome).toBe('dropped');
    expect(result.reason).toContain('message over the 2 MiB inbound limit');
    expect(parsedFor).toBeNull();
  });
});
