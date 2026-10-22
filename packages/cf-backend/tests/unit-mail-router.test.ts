import { describe, expect, test } from 'bun:test';
import type { MailDelivery, MailRecipient } from '@kinu.run/core';
import { routeInboundMail, type InboundMail, type MailRouterDeps } from '../src/mail/router';
import type { MailNameClaim } from '../src/mail/mailname-do';

// The one inbound path, from Email Routing's handoff to a filed message and, when the Mailbox says so, a wake. The
// Mailbox is a fake here; its decisions (verdict, policy) are tested in unit-mail-store.test.ts.

const DANA = 'From: Dana Whitfield <dana@northwind.io>\r\nSubject: Webhook deliveries to /hooks/v2 failing with 500\r\n\r\nSince Tuesday every delivery gets a 500.';

/** A message as Email Routing hands it over; `rejected` records what the router answered the sender. */
class Inbound implements InboundMail {
  readonly from = 'bounce@northwind.io';

  readonly headers: Headers;

  readonly raw: ReadableStream<Uint8Array>;

  readonly rawSize: number;

  rejected: string | null = null;

  constructor(readonly to: string, headers: Record<string, string> = {}, body = DANA) {
    const bytes = new TextEncoder().encode(body);

    this.headers = new Headers(headers);
    this.rawSize = bytes.byteLength;
    this.raw = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  setReject(reason: string): void {
    this.rejected = reason;
  }
}

const inbound = (to: string, headers: Record<string, string> = {}): Inbound => new Inbound(to, headers);

const CLAIMS = new Map<string, MailNameClaim>(Object.entries({
  ashish: { label: 'ashish', user_id: 'u-ashish', kind: 'username', target_path: null },
  ashishks: { label: 'ashishks', user_id: 'u-ashish', kind: 'username', target_path: null },
  // Retired: kept with no owner, so nobody claims it again.
  gone: { label: 'gone', user_id: '', kind: 'username', target_path: null },
  hello: { label: 'hello', user_id: 'u-ashish', kind: 'alias', target_path: 'api-worker' },
}));

function delivery(woke: MailDelivery['woke'], extra: Partial<MailDelivery> = {}): MailDelivery {
  return {
    box: 'scout.api-worker', messageId: 'm-1', threadId: 't-1', headerId: 'hooks-v2-500@northwind.io', references: null, attachments: [], duplicate: false, verified: woke !== null, from: { name: 'Dana Whitfield', address: 'dana@northwind.io' },
    subject: 'Webhook deliveries to /hooks/v2 failing with 500', woke, instruction: woke === 'owner' ? 'Ship the fix.' : null,
    wake: woke === null ? null : { workspace: 'api-worker', actorId: 'actor-scout', main: false }, triage: null, ...extra,
  };
}

/** The router's objects, recording what it delivered and whom it woke. */
class Deps implements MailRouterDeps {
  readonly domain = 'kinu.run';

  readonly delivered: { userId: string; recipient: MailRecipient }[] = [];

  readonly woken: MailDelivery[] = [];

  readonly triaging: string[] = [];

  constructor(private readonly answer: MailDelivery | null) {}

  name(label: string) {
    return { lookup: () => Promise.resolve(CLAIMS.get(label) ?? null) };
  }

  mailbox(userId: string) {
    return {
      deliver: (input: { recipient: MailRecipient }) => {
        this.delivered.push({ userId, recipient: input.recipient });

        return Promise.resolve(this.answer);
      },
    };
  }

  wake(arrived: MailDelivery): Promise<void> {
    this.woken.push(arrived);

    return Promise.resolve();
  }

  triage(reader: { workspace: string }): Promise<void> {
    this.triaging.push(reader.workspace);

    return Promise.resolve();
  }
}

const deps = (answer: MailDelivery | null): Deps => new Deps(answer);

describe('the recipient names a box, or the message is refused', () => {
  test('an agent\'s address reaches its account\'s Mailbox with the box\'s path', async () => {
    const routed = deps(delivery('input'));

    expect(await routeInboundMail(inbound('scout.api-worker.ashish@kinu.run'), routed)).toMatchObject({ outcome: 'filed', woke: true });
    expect(routed.delivered).toEqual([{ userId: 'u-ashish', recipient: { username: 'ashish', path: 'scout.api-worker', tag: null } }]);
  });

  test('a former username still reaches its account; an alias reaches the box it names', async () => {
    const routed = deps(delivery(null));

    await routeInboundMail(inbound('ashishks@kinu.run'), routed);
    await routeInboundMail(inbound('hello@kinu.run'), routed);
    expect(routed.delivered.map((each) => [each.userId, each.recipient.path])).toEqual([['u-ashish', ''], ['u-ashish', 'api-worker']]);
  });

  test('an unclaimed or retired label, another domain, or an account with no box yet is refused at SMTP time', async () => {
    for (const to of ['nobody@kinu.run', 'gone@kinu.run', 'ashish@example.com', 'a.b.c.ashish@kinu.run']) {
      const message = inbound(to);

      expect(await routeInboundMail(message, deps(delivery(null)))).toMatchObject({ outcome: 'refused' });
      expect(message.rejected).toBe('No such address here.');
    }

    // The Mailbox files an unknown label in the person's own box; it answers nothing only before the person has one.
    const lacking = inbound('ashish@kinu.run');

    expect(await routeInboundMail(lacking, deps(null))).toMatchObject({ outcome: 'refused' });
    expect(lacking.rejected).toBe('No such address here.');
  });

  test('a message larger than Email Routing carries is refused, by its declared size or its counted bytes', async () => {
    const declared = Object.assign(inbound('ashish@kinu.run'), { rawSize: 26 * 1024 * 1024 });

    expect(await routeInboundMail(declared, deps(delivery(null)))).toMatchObject({ outcome: 'refused' });
    expect(declared.rejected).not.toBeNull();
  });
});

describe('a filed message wakes only as the Mailbox decided, and never for a machine', () => {
  test('the owner\'s mail wakes its workspace with the instruction', async () => {
    const routed = deps(delivery('owner'));

    await routeInboundMail(inbound('ashish@kinu.run'), routed);
    expect(routed.woken.map((each) => [each.woke, each.instruction, each.wake?.workspace])).toEqual([['owner', 'Ship the fix.', 'api-worker']]);
  });

  test('nothing wakes when the Mailbox says so, for a redelivery, or for an auto-reply or a list message', async () => {
    const quiet = deps(delivery(null));

    expect(await routeInboundMail(inbound('ashish@kinu.run'), quiet)).toMatchObject({ outcome: 'filed', woke: false });


    const machine = deps(delivery('input'));

    await routeInboundMail(inbound('ashish@kinu.run', { 'Auto-Submitted': 'auto-replied' }), machine);
    await routeInboundMail(inbound('ashish@kinu.run', { 'List-Id': '<kinu.kinu-run.github.com>' }), machine);
    expect([quiet.woken, machine.woken]).toEqual([[], []]);
    expect(machine.delivered).toHaveLength(2);
  });
});

test('a redelivery is handed to its workspace again, which admits it once: a handoff lost after filing is not lost', async () => {
  const again = deps(delivery('owner', { duplicate: true }));

  expect(await routeInboundMail(inbound('ashish@kinu.run'), again)).toMatchObject({ outcome: 'filed', woke: true });
  expect(again.woken.map((each) => [each.woke, each.instruction])).toEqual([['owner', 'Ship the fix.']]);
});

describe('new mail in the person\'s box goes to their assistant to triage', () => {
  test('the assistant the Mailbox names is told, whether or not anything wakes, auto-replies too', async () => {
    const triage = { workspace: 'personal-assistant-7f3a', actorId: 'actor-kinu' };
    const quiet = deps(delivery(null, { box: '', triage }));

    await routeInboundMail(inbound('ashish@kinu.run'), quiet);
    await routeInboundMail(inbound('ashish@kinu.run', { 'Auto-Submitted': 'auto-replied' }), quiet);
    expect(quiet.triaging).toEqual(['personal-assistant-7f3a', 'personal-assistant-7f3a']);
    expect(quiet.woken).toEqual([]);
  });

  test('mail the Mailbox gives no one to triage tells no one', async () => {
    const agent = deps(delivery('input'));

    await routeInboundMail(inbound('scout.api-worker.ashish@kinu.run'), agent);
    expect(agent.triaging).toEqual([]);
  });
});
