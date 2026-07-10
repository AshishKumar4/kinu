// Mission Inbox — inbound side. Addressing (recipient → agent), MIME parsing
// + quoted-history stripping, the sender trust gate (owner / allowlist /
// dropped), Message-ID dedupe, the rate limit, and the Worker-level routing
// seam. Mocks live only at the email seam (raw MIME in, RPC target out).
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initEventsHubTables, EventLog, ReplyChannelStore, buildDrainBatch,
} from '@proteus/core';
import {
  agentEmailAddress, agentNameFromRecipient, normalizeEmailAddress,
  parseInboundMime, stripQuotedReply,
} from '../src/email/inbound.js';
import { acceptInboundEmail, type EmailIngressDeps, type IncomingEmail } from '../src/events/ingress/email.js';
import { routeInboundEmail, type EmailDeliveryTarget } from '../src/email/route.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

function makeSql(): SqlExec {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
}

const DOMAIN = 'agents.example.com';

function makeDeps(overrides: Partial<EmailIngressDeps> = {}) {
  const sql = makeSql();
  initEventsHubTables(sql);
  const log = new EventLog(sql);
  const replies = new ReplyChannelStore(sql, {});
  const deps: EmailIngressDeps = {
    log, replies,
    owner_email: 'owner@example.com',
    allowlist: [],
    tryConsumeRateLimit: () => true,
    ...overrides,
  };
  return { deps, log, replies, sql };
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

describe('stripQuotedReply', () => {
  test('cuts Gmail-style quoted history', () => {
    const text = 'Yes please deploy.\n\nOn Mon, Jun 1, 2026 at 9:00 AM Agent <a@b.c> wrote:\n> earlier\n> stuff';
    expect(stripQuotedReply(text)).toBe('Yes please deploy.');
  });
  test('cuts Outlook original-message blocks and signatures', () => {
    expect(stripQuotedReply('Do it.\n-----Original Message-----\nFrom: x')).toBe('Do it.');
    expect(stripQuotedReply('Do it.\n-- \nSent from my phone')).toBe('Do it.');
  });
  test('falls back to the full text when stripping would leave nothing', () => {
    expect(stripQuotedReply('> just a quote\n> nothing else')).toBe('> just a quote\n> nothing else');
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
    const parsed = await parseInboundMime(new TextEncoder().encode(raw).buffer as ArrayBuffer);
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
    const parsed = await parseInboundMime(new TextEncoder().encode(raw).buffer as ArrayBuffer);
    expect(parsed.body_text).toBe('Run the tests');
  });
});

describe('acceptInboundEmail — the trust gate', () => {
  test('the owner drives a turn: event admitted at authenticated trust with a thread channel', () => {
    const { deps, log, replies } = makeDeps();
    const result = acceptInboundEmail(deps, incoming());
    expect(result).toMatchObject({ admitted: true, duplicate: false, sender_class: 'owner' });
    if (!result.admitted) throw new Error('unreachable');

    const event = log.get(result.event_id)!;
    expect(event.variant).toBe('email');
    expect(event.trust).toBe('authenticated');       // capped — never owner
    expect(event.priority).toBe('normal');

    // The thread reply channel is bound to the event and carries threading.
    const channel = replies.findOpenByEvent(result.event_id)!;
    expect(channel.kind).toBe('email_thread');
    expect(JSON.parse(channel.holder_addr)).toMatchObject({
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

  test('owner match ignores case and display-name wrappers', () => {
    const { deps } = makeDeps({ owner_email: 'Owner@Example.COM' });
    const result = acceptInboundEmail(deps, incoming({ from: 'Owner <owner@example.com>' }));
    expect(result).toMatchObject({ admitted: true, sender_class: 'owner' });
  });

  test('an unknown sender is dropped — no event row, no reply channel', () => {
    const { deps, log, sql } = makeDeps();
    const result = acceptInboundEmail(deps, incoming({ from: 'attacker@evil.example.com' }));
    expect(result).toEqual({ admitted: false, reason: 'sender not authorized for this agent' });
    expect(log.pending()).toHaveLength(0);
    expect(sql.exec(`SELECT COUNT(*) AS n FROM reply_channels`).toArray()[0].n).toBe(0);
  });

  test('an allowlisted sender is admitted at external trust', () => {
    const { deps, log } = makeDeps({ allowlist: ['Friend@Example.com'] });
    const result = acceptInboundEmail(deps, incoming({ from: 'friend@example.com' }));
    expect(result).toMatchObject({ admitted: true, sender_class: 'allowlisted' });
    if (!result.admitted) throw new Error('unreachable');
    const event = log.get(result.event_id)!;
    expect(event.trust).toBe('external');
    expect(event.priority).toBe('background');
  });

  test('a retried delivery of the same Message-ID dedupes and aborts its extra channel', () => {
    const { deps, log, sql } = makeDeps();
    const first = acceptInboundEmail(deps, incoming());
    const retry = acceptInboundEmail(deps, incoming({ now: 9_000 }));
    expect(retry).toMatchObject({ admitted: true, duplicate: true });
    if (!first.admitted || !retry.admitted) throw new Error('unreachable');
    expect(retry.event_id).toBe(first.event_id);
    expect(log.pending()).toHaveLength(1);
    const states = sql.exec(`SELECT state FROM reply_channels ORDER BY created_at`).toArray();
    expect(states.map((r) => r.state)).toEqual(['open', 'aborted']);
  });

  test('the rate limit drops mail before publish', () => {
    const { deps, log } = makeDeps({ tryConsumeRateLimit: () => false });
    const result = acceptInboundEmail(deps, incoming());
    expect(result).toEqual({ admitted: false, reason: 'inbound email rate limit exceeded' });
    expect(log.pending()).toHaveLength(0);
  });
});

describe('routeInboundEmail — the Worker seam', () => {
  function mockMessage(opts: { from?: string; to?: string; raw?: string } = {}) {
    const raw = opts.raw ?? [
      'From: owner@example.com',
      `To: ${opts.to ?? `scout-a1b2c3@${DOMAIN}`}`,
      'Subject: Check the deploy',
      'Message-ID: <abc@mail.example.com>',
      'Content-Type: text/plain',
      '',
      'Is staging green?',
    ].join('\r\n');
    return {
      from: opts.from ?? 'owner@example.com',
      to: opts.to ?? `scout-a1b2c3@${DOMAIN}`,
      headers: new Headers({ 'message-id': '<abc@mail.example.com>' }),
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
    };
  }

  test('delivers the parsed email to the agent named by the recipient', async () => {
    const deliveries: Array<{ agent: string; opts: unknown }> = [];
    const target: EmailDeliveryTarget = {
      acceptEmailDelivery: async (opts) => {
        deliveries.push({ agent: 'scout-a1b2c3', opts });
        return { admitted: true, duplicate: false };
      },
    };
    const resolved: string[] = [];
    const result = await routeInboundEmail(mockMessage(), DOMAIN, async (name) => {
      resolved.push(name);
      return target;
    }, 42);

    expect(result).toEqual({ outcome: 'admitted', agent: 'scout-a1b2c3' });
    expect(resolved).toEqual(['scout-a1b2c3']);
    expect(deliveries[0].opts).toMatchObject({
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
      async () => { resolves++; return { acceptEmailDelivery: async () => ({ admitted: true }) }; },
    );
    expect(result.outcome).toBe('dropped');
    expect(resolves).toBe(0);
  });

  test('a gate rejection surfaces as dropped with the agent reason', async () => {
    const result = await routeInboundEmail(mockMessage(), DOMAIN, async () => ({
      acceptEmailDelivery: async () => ({ admitted: false, reason: 'sender not authorized for this agent' }),
    }));
    expect(result).toEqual({
      outcome: 'dropped', agent: 'scout-a1b2c3', reason: 'sender not authorized for this agent',
    });
  });
});
