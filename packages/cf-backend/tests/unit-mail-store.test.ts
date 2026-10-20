import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { initMailboxTables, mailInContext, type SqlExec } from '@kinu.run/core';
import { makeSqlExec } from '../../core/tests/helpers';
import type { MailDelivery } from '@kinu.run/core';
import { MailStore, type MailBlobs } from '@kinu.run/core';
import { parseMail } from '../src/mail/parse';
import { routeInboundMail } from '../src/mail/router';

// The Mailbox's store over SQLite, with the three real deliveries Cloudflare's MX made on 2026-10-19 (docs/MAIL.md §4)
// as its mail. Their From is probe@ashishkumarsingh.com, which passed DMARC; the account's email is set per test to
// make that sender the owner or a stranger.
const FIXTURES = join(import.meta.dir, '../../core/tests/fixtures/mail');

const raw = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, `${name}.eml`)));

/** A message as Dana at Northwind would send it: plain, unsigned, so nothing verifies it. */
function stranger(subject: string, body: string, headers = ''): Uint8Array {
  return new TextEncoder().encode([
    'From: Dana Whitfield <dana@northwind.io>', 'To: scout.api-worker.ashish@kinu.run', `Subject: ${subject}`,
    'Message-ID: <hooks-v2-500@northwind.io>', headers, 'Content-Type: text/plain; charset=utf-8', '', body,
  ].filter((line, index) => line !== '' || index > 4).join('\r\n'));
}

class Blobs implements MailBlobs {
  readonly held = new Map<string, Uint8Array | string>();

  put(key: string, value: Uint8Array | string): Promise<void> {
    this.held.set(key, value);

    return Promise.resolve();
  }

  text(key: string): Promise<string | null> {
    const value = this.held.get(key);

    if (value === undefined) return Promise.resolve(null);

    return Promise.resolve(typeof value === 'string' ? value : new TextDecoder().decode(value));
  }

  delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.held.delete(key);

    return Promise.resolve();
  }
}

let db: SqlExec;

let blobs: Blobs;

let clock: number;

let store: MailStore;

let next: number;

beforeEach(() => {
  db = makeSqlExec(new Database(':memory:'));
  initMailboxTables(db);
  blobs = new Blobs();
  clock = Date.UTC(2026, 9, 19, 19, 30);
  next = 0;
  store = new MailStore({
    sql: db, blobs, domain: 'kinu.run', now: () => clock, id: () => { next += 1;

 return `id-${String(next)}`; }, parse: parseMail,
    digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
  });
});

const open = (email: string) => store.open({ userId: 'u-ashish', email, username: 'ashish', assistant: { workspace: 'personal-assistant', actorId: 'actor-kinu' } });

const toPerson = { username: 'ashish', path: '', tag: null } as const;

/** A delivery to a box the account has. */
async function delivered(input: Parameters<MailStore['deliver']>[0]): Promise<MailDelivery> {
  const delivery = await store.deliver(input);

  if (delivery === null) throw new Error(`no box at "${input.recipient.path}"`);

  return delivery;
}

describe('an arrival is filed, and wakes by the verdict and the box\'s policy', () => {
  test('the verified owner\'s mail wakes the box\'s reader as the owner, with their own words as the instruction', async () => {
    open('probe@ashishkumarsingh.com');
    const delivery = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'bounce@cf-bounce.ashishkumarsingh.com', recipient: toPerson });

    expect(delivery).toMatchObject({ verified: true, woke: 'owner', duplicate: false, wake: { workspace: 'personal-assistant', actorId: 'actor-kinu', main: true } });
    expect(delivery.instruction).toContain('control message');
  });

  test('the person\'s box wakes the Personal assistant they have now, which reads it; before an address, there is none to read', async () => {
    expect(store.readBy({ workspace: 'personal-assistant', actorId: 'actor-kinu' })).toBeNull();
    store.open({ userId: 'u-ashish', email: 'probe@ashishkumarsingh.com', username: 'ashish', assistant: null });
    store.setWake('', 'verified');
    expect((await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: toPerson })).wake).toBeNull();

    store.readBy({ workspace: 'personal-assistant', actorId: 'actor-kinu' });
    store.readBy({ workspace: 'kinu-2', actorId: 'actor-kinu-2' });
    const delivery = await delivered({ raw: raw('second-local-part-pass'), envelopeFrom: 'b@x', recipient: toPerson });
    const caller = { workspace: 'kinu-2', title: 'Kinu', mainActorId: 'actor-kinu-2', actorId: 'actor-kinu-2', name: 'main' };

    expect(delivery.wake).toEqual({ workspace: 'kinu-2', actorId: 'actor-kinu-2', main: true });
    expect(store.readableBy(caller).map((box) => box.path)).toContain('');
    expect(store.readableBy({ ...caller, workspace: 'personal-assistant', mainActorId: 'actor-kinu', actorId: 'actor-kinu' }).map((box) => box.path)).not.toContain('');
  });

  test('a redelivery is filed once but woken as the first was, so a handoff that failed after filing is made again', async () => {
    open('probe@ashishkumarsingh.com');
    const first = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'bounce@cf-bounce.ashishkumarsingh.com', recipient: toPerson });
    const again = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'bounce@cf-bounce.ashishkumarsingh.com', recipient: toPerson });

    expect(again).toMatchObject({
      duplicate: true, messageId: first.messageId, threadId: first.threadId, headerId: first.headerId, woke: 'owner',
      wake: first.wake, instruction: first.instruction, references: first.references, attachments: first.attachments,
    });
    expect((await store.thread(first.threadId))?.messages).toHaveLength(1);
  });

  test('another verified sender on the same domain is not the owner: by default a box wakes for its owner only', async () => {
    open('probe@ashishkumarsingh.com');
    const delivery = await delivered({ raw: raw('second-local-part-pass'), envelopeFrom: 'x@cf-bounce.ashishkumarsingh.com', recipient: toPerson });

    expect(delivery).toMatchObject({ verified: true, woke: null, wake: null, instruction: null });
  });

  test('a box set to wake for verified senders wakes for them as input, with no words handed over', async () => {
    open('ashish@kinu.run');
    store.setWake('', 'verified');
    const delivery = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@cf-bounce.ashishkumarsingh.com', recipient: toPerson });

    expect(delivery).toMatchObject({ verified: true, woke: 'input', instruction: null });
  });

  test('an allowlist wakes only the senders on it', async () => {
    open('ashish@kinu.run');
    store.setWake('', 'allowlist', ['Probe@AshishKumarSingh.com']);
    expect((await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: toPerson })).woke).toBe('input');
    expect((await delivered({ raw: raw('second-local-part-pass'), envelopeFrom: 'b@x', recipient: toPerson })).woke).toBeNull();
  });

  test('unverified mail is kept and woken by nothing, whatever the policy', async () => {
    open('ashish@kinu.run');
    store.boxFor({ kind: 'agent', workspace: 'api-worker', name: 'scout', actorId: 'actor-scout' });
    store.boxFor({ kind: 'workspace', workspace: 'api-worker', name: 'API Worker', actorId: 'actor-main' });
    const scout = store.boxes().find((box) => box.workspace === 'api-worker' && box.actorId === 'actor-scout');

    expect(scout?.address).toBe('scout.api-worker.ashish@kinu.run');
    store.setWake(scout?.path ?? '', 'verified');

    const delivery = await delivered({ raw: stranger('Webhook deliveries to /hooks/v2 failing with 500', 'Since Tuesday every delivery gets a 500.'),
      envelopeFrom: 'dana@northwind.io', recipient: { username: 'ashish', path: scout?.path ?? '', tag: null } });

    expect(delivery).toMatchObject({ verified: false, woke: null, wake: null });
    expect((await store.thread(delivery.threadId))?.messages[0]).toMatchObject({ verified: false, text: 'Since Tuesday every delivery gets a 500.' });
  });

  test('a +tag reaches the same box and is kept as the address it was delivered to', async () => {
    open('ashish@kinu.run');
    const delivery = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: { username: 'ashish', path: '', tag: 'receipts' } });

    expect((await store.thread(delivery.threadId))?.messages[0]?.deliveredTo).toBe('ashish+receipts@kinu.run');
  });

  test('mail to a workspace or agent label the person does not have is kept in their own box, and wakes nothing', async () => {
    // Accepted, so a sender cannot learn which workspaces exist by which addresses bounce (docs/MAIL.md §4).
    open('ashish@kinu.run');

    const delivery = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: { username: 'ashish', path: 'payroll', tag: null } });

    expect(delivery).toMatchObject({ box: '', woke: null, wake: null });
    expect((await store.thread(delivery.threadId))?.messages[0]?.deliveredTo).toBe('payroll.ashish@kinu.run');
  });

  test('before the person has a box, nothing is delivered', async () => {
    expect(await store.deliver({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: { username: 'ashish', path: '', tag: null } })).toBeNull();
  });
});

describe('threads, views and search', () => {
  test('a reply joins the thread it answers; Sent, Drafts and Important are queries over it', async () => {
    open('ashish@kinu.run');
    const box = store.boxFor({ kind: 'agent', workspace: 'api-worker', name: 'scout', actorId: 'actor-scout' });

    const arrived = await delivered({ raw: stranger('Webhook deliveries to /hooks/v2 failing with 500', 'Every delivery to /hooks/v2 gets a 500.'),
      envelopeFrom: 'dana@northwind.io', recipient: { username: 'ashish', path: box.path, tag: null } });

    await store.draft({ path: box.path, threadId: arrived.threadId, to: ['dana@northwind.io'], subject: 'Re: Webhook deliveries', text: 'It is ours; the fix is going out.', writtenBy: 'scout' });
    expect(store.list({ view: 'drafts' }).threads.map((thread) => thread.id)).toEqual([arrived.threadId]);
    expect(store.list({ view: 'sent' }).threads).toEqual([]);

    await store.queue({ path: box.path, threadId: arrived.threadId, to: ['dana@northwind.io'], subject: 'Re: Webhook deliveries', text: 'It is ours.', inReplyTo: '<hooks-v2-500@northwind.io>' });
    expect(store.list({ view: 'drafts' }).threads).toEqual([]);
    expect(store.list({ view: 'sent' }).threads[0]).toMatchObject({ id: arrived.threadId, count: 2, outgoing: true });

    expect(() => store.update(arrived.threadId, { important: 'Dana is blocked.' })).toThrow();
    expect(store.list({ view: 'important' }).threads).toEqual([]);
  });

  test('a reply given only its thread answers the thread\'s newest message, as its headers say', async () => {
    open('ashish@kinu.run');
    const box = store.boxFor({ kind: 'agent', workspace: 'api-worker', name: 'scout', actorId: 'actor-scout' });

    const arrived = await delivered({ raw: stranger('Webhook deliveries to /hooks/v2 failing with 500', 'Every delivery to /hooks/v2 gets a 500.'),
      envelopeFrom: 'dana@northwind.io', recipient: { username: 'ashish', path: box.path, tag: null } });

    const reply = await store.queue({ path: box.path, threadId: arrived.threadId, to: ['dana@northwind.io'], subject: 'Re: Webhook deliveries', text: 'It is ours.' });

    expect(reply.inReplyTo).toBe(`<${arrived.headerId ?? ""}>`);
    expect(arrived.headerId).not.toBeNull();
  });

  test('Important is the person\'s box only, with the reason; unread counts what is unread there', async () => {
    open('ashish@kinu.run');
    const delivery = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: toPerson });

    store.update(delivery.threadId, { important: 'A control message for the trust check.' });
    expect(store.list({ view: 'important' })).toMatchObject({ unread: 1, threads: [{ important: 'A control message for the trust check.' }] });
    store.update(delivery.threadId, { read: true });
    expect(store.list({ view: 'important' }).unread).toBe(0);
  });

  test('unread is asked of every thread, before the newest few are taken', async () => {
    open('ashish@kinu.run');
    const older = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: toPerson });

    clock += 60_000;
    const newer = await delivered({ raw: raw('second-local-part-pass'), envelopeFrom: 'b@x', recipient: toPerson });

    store.update(newer.threadId, { read: true });
    expect(store.list({ view: 'all', unread: true, limit: 1 })).toMatchObject({ unread: 1, threads: [{ id: older.threadId }] });
    expect(store.list({ view: 'all', limit: 1 })).toMatchObject({ unread: 1, threads: [{ id: newer.threadId }] });
  });

  test('a thread names who wrote its newest message, not whoever wrote in it last of those who wrote first', async () => {
    open('ashish@kinu.run');
    const box = store.boxFor({ kind: 'agent', workspace: 'api-worker', name: 'scout', actorId: 'actor-scout' });
    const recipient = { username: 'ashish', path: box.path, tag: null };
    const first = await delivered({ raw: stranger('Webhook deliveries to /hooks/v2 failing with 500', 'Every delivery gets a 500.'), envelopeFrom: 'dana@northwind.io', recipient });

    clock += 60_000;
    await store.queue({ path: box.path, threadId: first.threadId, to: ['dana@northwind.io'], subject: 'Re: Webhook deliveries', text: 'Looking now.' });
    clock += 60_000;
    await delivered({ raw: new TextEncoder().encode([
      'From: Dana Whitfield <dana@northwind.io>', 'To: scout.api-worker.ashish@kinu.run', 'Subject: Re: Webhook deliveries', 'Message-ID: <hooks-v2-500-2@northwind.io>',
      'In-Reply-To: <hooks-v2-500@northwind.io>', 'Content-Type: text/plain; charset=utf-8', '', 'Still failing.',
    ].join('\r\n')), envelopeFrom: 'dana@northwind.io', recipient });

    const [thread] = store.list({ view: 'all', unread: true }).threads;

    expect(thread).toMatchObject({ id: first.threadId, from: [{ address: 'dana@northwind.io' }, { address: 'scout.api-worker.ashish@kinu.run' }], sender: { address: 'dana@northwind.io' } });
    expect(mailInContext(store.list({ view: 'all', unread: true })).items).toEqual([expect.objectContaining({ from: 'dana@northwind.io' })]);
  });

  test('search finds words in subject, sender and body, and quoted words are not syntax', async () => {
    open('ashish@kinu.run');
    await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: toPerson });
    await delivered({ raw: raw('second-local-part-pass'), envelopeFrom: 'b@x', recipient: toPerson });

    expect(store.list({ view: 'all', query: 'probe 01b' }).threads).toHaveLength(1);
    expect(store.list({ view: 'all', query: 'kinu-probe-b@ashishkumarsingh.com' }).threads).toHaveLength(1);
    expect(store.list({ view: 'all', query: 'NEAR( "x' }).threads).toEqual([]);
  });
});

describe('Trash', () => {
  test('a trashed thread leaves All for Trash, and empties 30 days later with its bytes', async () => {
    open('ashish@kinu.run');
    const delivery = await delivered({ raw: raw('cloudflare-pass'), envelopeFrom: 'b@x', recipient: toPerson });

    expect(blobs.held.size).toBeGreaterThan(0);
    store.update(delivery.threadId, { trashed: true });
    expect(store.list({ view: 'all' }).threads).toEqual([]);
    expect(store.list({ view: 'trash' }).threads).toHaveLength(1);

    // Thirty days, the owner's (2026-10-19).
    clock += 29 * 86_400_000;
    expect(await store.purge()).toBe(0);
    clock += 86_400_000;
    expect(await store.purge()).toBe(1);
    expect(store.list({ view: 'trash' }).threads).toEqual([]);
    expect(blobs.held.size).toBe(0);
    expect(store.list({ view: 'all', query: 'probe' }).threads).toEqual([]);
  });
});

describe('what a sent message shows, and what replies to it reach', () => {
  test('its state is the outbox\'s, however its send went; the reply that names the service\'s Message-ID joins its thread', async () => {
    const outbox = new Map<string, 'pending' | 'sent' | 'dlq'>();

    store = new MailStore({
      sql: db, blobs, domain: 'kinu.run', now: () => clock, id: () => { next += 1;

 return `id-${String(next)}`; }, parse: parseMail,
      digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')), sendState: (messageId) => outbox.get(messageId) ?? null,
    });
    open('ashish@kinu.run');

    const { view } = await store.queue({ path: '', to: ['dana@northwind.io'], subject: 'Webhook signing', text: 'We moved to the Northwind-Signature header.' });
    const shown = async () => (await store.messageView(view.threadId, view.id))?.sendState;

    expect(await shown()).toBe('queued');
    outbox.set(view.id, 'pending');
    expect(await shown()).toBe('queued');
    outbox.set(view.id, 'sent');
    expect(await shown()).toBe('sent');
    outbox.set(view.id, 'dlq');
    expect(await shown()).toBe('failed');

    store.sentAs(view.id, '<0100019a2b3c.4d5e@email.cloudflare.net>');

    const reply = await delivered({
      raw: new TextEncoder().encode([
        'From: Dana Whitfield <dana@northwind.io>', 'To: ashish@kinu.run', 'Subject: Re: Webhook signing', 'Message-ID: <signing-ack@northwind.io>',
        'In-Reply-To: <0100019a2b3c.4d5e@email.cloudflare.net>', 'Content-Type: text/plain; charset=utf-8', '', 'Thanks, deploying the change now.',
      ].join('\r\n')),
      envelopeFrom: 'dana@northwind.io', recipient: toPerson,
    });

    expect(reply.threadId).toBe(view.threadId);
  });
});

// Schema audit, 2026-10-20: a clash on a 20-character label took `-2` past the label's 20 characters, so the address Kinu
// gave the agent was one its router refused; under a 20-character workspace label the path broke the table's 41 outright.
describe('a clash on a full-length label', () => {
  test('is numbered inside the label, keeps its workspace, and mail reaches the address it gives', async () => {
    open('ashish@kinu.run');
    const writer = (workspace: string, actorId: string) => store.boxFor({ kind: 'agent', workspace, name: 'release-notes-writer', actorId });

    const reached = async (address: string) => {
      const bytes = stranger('Release notes for v2', 'Draft the notes.');
      const rejected: string[] = [];

      const routed = await routeInboundMail({
        from: 'dana@northwind.io', to: address, headers: new Headers(), rawSize: bytes.byteLength,
        raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }), setReject: (reason) => { rejected.push(reason); },
      }, {
        domain: 'kinu.run',
        name: () => ({ lookup: () => Promise.resolve({ label: 'ashish', user_id: 'u-ashish', kind: 'username', target_path: null, state: 'active' }) }),
        mailbox: () => store,
        wake: () => Promise.resolve(),
        triage: () => Promise.resolve(),
      });

      return rejected.length === 0 && routed.outcome === 'filed' ? routed.delivery.box : `refused: ${rejected.join(', ')}`;
    };

    // Under a short workspace the numbered label alone was too long, which the router refuses; under a 20-character
    // one the whole path was, which the table refuses.
    for (const workspace of ['api', 'northwind-api-worker']) {
      const [first, second] = [writer(workspace, `actor-writer-${workspace}`), writer(workspace, `actor-writer-2-${workspace}`)];

      expect([first.path, second.path]).toEqual([`release-notes-writer.${workspace}`, `release-notes-writ-2.${workspace}`]);
      expect(await reached(second.address)).toBe(second.path);
    }
  });
});
