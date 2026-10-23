// `google.*` over the pinned method table: a method is found by what it does and described as TypeScript; a read goes
// at once; a write waits on the owner's approval of that exact call, goes once on it, and a changed field asks anew. Its
// card shows the message a Gmail write sends, read as the Mailbox reads mail, a draft's read from Google first.
import { describe, expect, test } from 'bun:test';
import { approvalKindOf, buildPendingActions, callOperation, createGoogleCodemodeProvider, type GoogleAnswer, type GoogleDeps, type GoogleRequest, type GoogleWrite, type JsonValue } from '../src/index';
import { googleWriteExecutor, googleWriteText } from '../src/safety/approval-kind';
import { googleRequest } from '../src/google/catalog';
import { Effect, Exit } from 'effect';
import * as v from 'valibot';

const toBase64Url = (text: string) => Buffer.from(text).toString('base64url');

/** A message as Gmail takes it, base64url; the Mailbox's parser (postal-mime) is the fake below, which reads it whole. */
const MESSAGE = 'To: Ada <ada@example.com>\r\nSubject: Launch day moved\r\n\r\nLaunch is Thursday now.\nBring the slides.';

const RAW = toBase64Url(MESSAGE);

/** The reading the card is drawn from, as `parseMail` would give it for MESSAGE. */
const READ = {
  to: [{ name: 'Ada', address: 'ada@example.com' }], cc: [{ name: null, address: 'ops@example.com' }], bcc: [{ name: null, address: 'eve@example.com' }],
  subject: 'Launch day moved', text: 'Launch is Thursday now.\nBring the slides.',
};

const CARD = { to: 'Ada <ada@example.com>', cc: 'ops@example.com', bcc: 'eve@example.com', subject: 'Launch day moved', start: 'Launch is Thursday now. Bring the slides.' };

const NOT_FOUND: JsonValue = { error: { code: 404, message: 'Not Found' } };

/** Google, as the account answers for it, and the owner's queue: what was sent, what was asked, and the owner's say. */
function harness(options: { readonly held?: boolean; readonly draft?: string } = {}) {
  const sent: GoogleRequest[] = [];
  const asked: GoogleWrite[] = [];
  const approved = new Set<string>();
  const spent: string[] = [];

  const read: string[] = [];

  const deps: GoogleDeps = {
    by: () => 'Kinu',
    held: async () => options.held ?? true,
    readMail: async (bytes) => {
      read.push(new TextDecoder().decode(bytes));

      return READ;
    },
    send: async (request): Promise<GoogleAnswer> => {
      sent.push(request);

      if (request.url.includes('/events/gone') || request.url.endsWith('/messages/send') && request.body?.includes('"gone"') === true) {
        return { status: 404, body: NOT_FOUND, headers: {} };
      }

      const body: JsonValue = request.url.includes('/drafts/d1') ? { id: 'd1', message: { raw: options.draft ?? RAW } } : { id: 'm1' };

      return { status: 200, body, headers: { etag: '"e1"' } };
    },
    approvals: {
      ask: (id, write) => {
        asked.push(write);

        return approved.has(id) ? { outcome: 'approved' } : { outcome: 'asked', approval: id };
      },
      take: (id) => (approved.delete(id) ? { approvalId: id, spend: 1 } : null),
      settle: async (spend) => {
        spent.push(spend.approvalId);

        return true;
      },
    },
  };

  const provider = createGoogleCodemodeProvider(deps);
  const call = async (member: string, input: Record<string, JsonValue>) => (await callOperation([provider], `google.${member}`, input, { callId: `call-${member}` })).value;

  return { sent, asked, approved, spent, read, call };
}

describe('finding and describing a method', () => {
  test('search names the methods for what is asked, each read or write, and describe writes one out as TypeScript', async () => {
    const { call } = harness();
    const found = await call('search', { query: 'send mail', limit: 3 });

    expect(found).toContainEqual({ id: 'gmail.users.messages.send', kind: 'write', d: expect.stringContaining('Sends the specified message') });
    const listing = await call('describe', { name: 'gmail.users.messages.list' });

    expect(listing).toContain('google.read("gmail.users.messages.list", {\n  params: {\n');
    expect(listing).toContain('    "userId": string;');
    expect(listing).toContain('}): Promise<{ status: number; body: ListMessagesResponse }>;');
    expect(await call('describe', { name: 'gmail.users.messages.send' })).toContain("Promise<{ status: 'done'; answer: { status: number; body: Message } } | { status: 'asked' | 'denied'; approval: string }>");
    expect(await call('describe', { name: 'gmail.Message' })).toContain('interface Message {');
  });

  test('a request is built from the table alone: path filled in, the rest its query, an unknown or missing parameter refused', async () => {
    const built = await Effect.runPromise(googleRequest('gmail.users.messages.list', { userId: 'me', labelIds: ['INBOX', 'UNREAD'], maxResults: 5 }, undefined));

    expect(built.request).toEqual({ method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=5' });
    expect((await Effect.runPromise(googleRequest('people.people.get', { resourceName: 'people/me', personFields: 'names' }, undefined))).request.url)
      .toBe('https://people.googleapis.com/v1/people/me?personFields=names');

    const unknown = await Effect.runPromiseExit(googleRequest('gmail.users.messages.list', { user: 'me' }, undefined));
    const missing = await Effect.runPromiseExit(googleRequest('calendar.events.list', {}, undefined));

    expect(Exit.isFailure(unknown) && String(unknown.cause)).toContain('takes no user');
    expect(Exit.isFailure(missing) && String(missing.cause)).toContain('needs calendarId');

    // A value that spells another route is that route at Google: deleting the file "trash" would empty the trash.
    const trash = await Effect.runPromiseExit(googleRequest('drive.files.delete', { fileId: 'trash' }, undefined));
    const up = await Effect.runPromiseExit(googleRequest('drive.files.get', { fileId: '..' }, undefined));
    const contactGroup = await Effect.runPromise(googleRequest('people.contactGroups.get', { resourceName: 'contactGroups/myContacts' }, undefined));

    expect(Exit.isFailure(trash) && String(trash.cause)).toContain('is the route of drive.files.emptyTrash');
    expect(Exit.isFailure(up) && String(up.cause)).toContain('may not be . or ..');
    expect(contactGroup.request.url).toBe('https://people.googleapis.com/v1/contactGroups/myContacts');
    // Drive answers about.get only for the fields named, an API-wide parameter the table keeps for every method.
    expect((await Effect.runPromise(googleRequest('drive.about.get', { fields: 'user' }, undefined))).request.url).toBe('https://www.googleapis.com/drive/v3/about?fields=user');
  });
});

describe('reading and writing', () => {
  test('a read goes at once; a write through read is refused, as a read through write is', async () => {
    const { call, sent } = harness();

    expect(await call('read', { method: 'calendar.events.list', params: { calendarId: 'primary' } })).toEqual({ status: 200, body: { id: 'm1' } });
    expect(sent.map((r) => [r.method, r.url])).toEqual([['GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events']]);
    await expect(call('read', { method: 'gmail.users.messages.send', params: { userId: 'me' } })).rejects.toThrow('call it with google.write');
    await expect(call('write', { method: 'calendar.events.list', params: { calendarId: 'primary' } })).rejects.toThrow('call it with google.read');
    await expect(call('read', { method: 'calendar.events.get', params: { calendarId: 'primary', eventId: 'gone' } })).rejects.toThrow('Google refused it: Not Found');
  });

  test('a write asks first, goes once on approval, and a changed body asks anew', async () => {
    const { call, sent, asked, approved, spent, read } = harness();
    const send = { method: 'gmail.users.messages.send', params: { userId: 'me' }, body: { raw: RAW } };
    const first = v.parse(v.object({ status: v.literal('asked'), approval: v.pipe(v.string(), v.regex(/^google-[0-9a-f]{32}$/u)) }), await call('write', send));

    expect(sent).toEqual([]);
    expect(asked[0]).toEqual({
      by: 'Kinu', method: 'gmail.users.messages.send', does: expect.stringContaining('Sends the specified message'), params: { userId: 'me' }, body: { raw: RAW },
      mail: CARD, content: null,
    });
    expect(read).toEqual([MESSAGE]);

    approved.add(first.approval);

    expect(await call('write', send)).toEqual({ status: 'done', answer: { status: 200, body: { id: 'm1' } } });
    expect(sent.map((r) => [r.method, r.url, r.body])).toEqual([['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', JSON.stringify({ raw: RAW })]]);
    expect(spent).toEqual([first.approval]);
    expect(await call('write', send)).toMatchObject({ status: 'asked' });
    expect(await call('write', { ...send, body: { raw: toBase64Url('To: eve@example.com\r\n\r\nhi') } })).not.toEqual(first);
  });

  test('a draft sent by id shows on its card as the message it is, and a draft changed since asks anew', async () => {
    const draft = { method: 'gmail.users.drafts.send', params: { userId: 'me' }, body: { id: 'd1' } };
    const first = harness();
    const changed = harness({ draft: toBase64Url(`${MESSAGE}\r\nP.S. one more line`) });

    const asked = await first.call('write', draft);

    expect(first.sent.map((r) => r.url)).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=raw']);
    expect(first.asked[0]).toMatchObject({ mail: CARD, content: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(await changed.call('write', draft)).not.toEqual(asked);
  });

  test('a write is asked only of an account that holds the connection, and a refused one is spent, so it asks anew', async () => {
    const unheld = harness({ held: false });

    await expect(unheld.call('write', { method: 'calendar.events.insert', params: { calendarId: 'primary' }, body: { summary: 'x' } })).rejects.toThrow('Google is not connected');
    expect(unheld.asked).toEqual([]);

    const { call, approved, spent } = harness();
    const gone = { method: 'gmail.users.messages.send', params: { userId: 'me' }, body: { raw: 'gone' } };
    const first = v.parse(v.object({ approval: v.string() }), await call('write', gone));

    approved.add(first.approval);

    await expect(call('write', gone)).rejects.toThrow('Google refused it: Not Found');
    expect(spent).toEqual([first.approval]);
  });
});

describe('the owner\'s card', () => {
  test('a parked Google write reads back as itself, never a command, and its card carries the call', () => {
    const write: GoogleWrite = { by: 'Kinu', method: 'calendar.events.insert', does: 'Creates an event.', params: { calendarId: 'primary' }, body: { summary: 'Launch' }, mail: null, content: null };
    const row = { id: 'google-1', command: googleWriteText(write), executor: googleWriteExecutor(write.method) };

    expect(approvalKindOf(row)).toEqual({ kind: 'google-write', write });
    expect(approvalKindOf({ ...row, executor: googleWriteExecutor('gmail.users.messages.send') })).toEqual({ kind: 'command', command: row.command });

    const [card] = buildPendingActions({
      deferredActions: [{ ...row, status: 'queued', requestedAt: 1, decidedAt: null, actor: 'a1', context: {}, reason: '' }], pendingPlans: [],
    });

    expect(card).toMatchObject({ title: 'Google: Creates an event.', google: write, raisedBy: 'a1' });
  });

  test('a Gmail write that carries no message shows none on its card', async () => {
    const { call, asked, read } = harness();

    await call('write', { method: 'gmail.users.labels.create', params: { userId: 'me' }, body: { name: 'Receipts' } });

    expect({ mail: asked[0]?.mail, read }).toEqual({ mail: null, read: [] });
  });
});
