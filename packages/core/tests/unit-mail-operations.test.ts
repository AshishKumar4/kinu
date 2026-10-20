import { beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  initMailboxTables, MailStore, type MailAgentMessage, type MailboxAgentCalls, type MailCaller,
  type JsonValue,
} from '../src/index';
import { createMailCodemodeProvider, type MailSendApprovals } from '../src/tools/mail-codemode';
import { inWorkMode, providersInWorkMode } from '../src/execution/work-mode';
import type { MailSend } from '../src/safety/approval-kind';
import type { Served } from '../src/operations/operation';
import { makeSqlExec } from './helpers';

// An agent's `mail.*` over a real Mailbox store: it reads only its boxes, drafts freely, and a message leaves only
// once the owner approved that exact message, once.

const NOW = Date.UTC(2026, 9, 20, 9);

const Asked = v.object({ status: v.literal('asked'), approval: v.string() });

const SCOUT: MailCaller = { workspace: 'handwrought-walnut-4166c321', title: 'API Worker', mainActorId: 'actor-main', actorId: 'actor-scout', name: 'scout' };

const MAIN: MailCaller = { ...SCOUT, actorId: 'actor-main', name: 'main' };

let store: MailStore;

let sent: MailAgentMessage[];

let decisions: Map<string, 'queued' | 'approved' | 'denied' | 'spent'>;

let parked: MailSend[];

/** Approvals another send of the same message took between this one's ask and its take. */
let takenElsewhere: Set<string>;

/** The Mailbox's agent calls, as its Durable Object answers them: the store's own, with sending recorded. */
function mailbox(): MailboxAgentCalls {
  return {
    readableBy: (caller) => Promise.resolve(store.readableBy(caller)),
    findFor: (caller, query) => Promise.resolve(store.findFor(caller, query)),
    readFor: async (caller, thread) => store.readFor(caller, thread),
    untriagedFor: async (caller, limit, skip) => store.untriagedFor(caller, limit, skip),
    triagedFor: (caller, thread, version, pick) => Promise.resolve(store.triagedFor(caller, thread, version, pick)),
    draftFor: async (caller, message) => store.draft(store.messageFor(caller, message)),
    sendFor: async (caller, message) => {
      sent.push(message);

      return (await store.queue(store.messageFor(caller, message))).view;
    },
    updateFor: (caller, thread, change) => Promise.resolve(store.updateFor(caller, thread, change)),
  };
}

const approvals: MailSendApprovals = {
  ask: (id, send) => {
    const held = decisions.get(id);

    if (held === 'approved') return { outcome: 'approved' };

    if (held === 'denied') return { outcome: 'denied', approval: id };

    if (held === undefined) parked.push(send);
    decisions.set(id, 'queued');

    return { outcome: 'asked', approval: id };
  },
  take: (id) => {
    if (decisions.get(id) !== 'approved' || takenElsewhere.has(id)) return null;
    decisions.set(id, 'spent');

    return { approvalId: id, spend: 1 };
  },
  settle: () => Promise.resolve(true),
};

function served(caller: MailCaller): Record<string, Served> {
  return Object.fromEntries((createMailCodemodeProvider({ caller: () => caller, mailbox, approvals }).operations ?? []).map((each) => [each.op.name, each]));
}

async function call(caller: MailCaller, member: string, input: JsonValue) {
  const op = served(caller)[member];

  if (op === undefined) throw new Error(`no mail.${member}`);

  return (await op.run(input, { callId: 'c-1' })).value;
}

beforeEach(() => {
  const sql = makeSqlExec(new Database(':memory:'));

  initMailboxTables(sql);
  store = new MailStore({
    sql, domain: 'kinu.run', now: () => NOW, id: () => crypto.randomUUID(), parse: () => Promise.reject(new Error('not parsed here')),
    blobs: { put: () => Promise.resolve(), text: () => Promise.resolve(null), delete: () => Promise.resolve() },
    digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
  });
  store.open({ userId: 'u-ashish', email: 'me@ashishkumarsingh.com', username: 'ashish', assistant: null });
  sent = [];
  decisions = new Map();
  parked = [];
  takenElsewhere = new Set();
});

describe('an agent reads only its own boxes', () => {
  test('before the person has an address, an agent has none either', async () => {
    const sql = makeSqlExec(new Database(':memory:'));

    initMailboxTables(sql);
    store = new MailStore({
      sql, domain: 'kinu.run', now: () => NOW, id: () => crypto.randomUUID(), parse: () => Promise.reject(new Error('not parsed here')),
      blobs: { put: () => Promise.resolve(), text: () => Promise.resolve(null), delete: () => Promise.resolve() },
      digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
    });

    expect(await call(SCOUT, 'address', {})).toEqual({ own: '', boxes: [] });
    await expect(call(SCOUT, 'send', { to: ['dana@northwind.io'], subject: 'x', text: 'y' })).rejects.toThrow('do not read the box');
  });

  test('its address is its own box, made on first ask, beside its workspace\'s', async () => {
    expect(await call(SCOUT, 'address', {})).toEqual({
      own: 'scout.api-worker.ashish@kinu.run',
      boxes: [{ path: 'scout.api-worker', address: 'scout.api-worker.ashish@kinu.run' }, { path: 'api-worker', address: 'api-worker.ashish@kinu.run' }],
    });
  });

  test('another agent\'s box, and the person\'s, are not its to read', async () => {
    await call(MAIN, 'address', {});

    await expect(call(SCOUT, 'draft', { box: '', to: ['dana@northwind.io'], subject: 'x', text: 'y' })).rejects.toThrow('do not read the box');
    await expect(call(SCOUT, 'draft', { box: 'api-worker', to: ['dana@northwind.io'], subject: 'x', text: 'y' })).resolves.toMatchObject({ draft: expect.any(String) });
  });
});

describe('a message leaves only on the owner\'s approval of that exact message', () => {
  const reply = { to: ['dana@northwind.io'], subject: 'Re: /hooks/v2 failing with 500', text: 'The 500s were ours, from the signing change; fixed at 14:05. Replay from your dashboard.' };

  test('the first send asks, and nothing leaves', async () => {
    expect(await call(SCOUT, 'send', reply)).toMatchObject({ status: 'asked' });
    expect(sent).toEqual([]);
    expect(parked).toEqual([{ by: 'scout', from: 'scout.api-worker.ashish@kinu.run', to: ['dana@northwind.io'], cc: [], subject: reply.subject, text: reply.text, thread: null }]);
  });

  test('approved, the same message leaves once; a second send asks again', async () => {
    const asked = v.parse(Asked, await call(SCOUT, 'send', reply));

    decisions.set(asked.approval, 'approved');
    expect(await call(SCOUT, 'send', reply)).toMatchObject({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(await call(SCOUT, 'send', reply)).toMatchObject({ status: 'asked' });
    expect(sent).toHaveLength(1);
  });

  test('an address is read as the person\'s own sends read it: trimmed and lowercased, so the card shows what leaves', async () => {
    expect(await call(SCOUT, 'send', { ...reply, to: [' Dana@Northwind.IO '], cc: ['Priya@Raman.dev'] })).toMatchObject({ status: 'asked' });
    expect(parked).toMatchObject([{ to: ['dana@northwind.io'], cc: ['priya@raman.dev'] }]);
  });

  test('approving one message admits no other: a changed word asks anew', async () => {
    const asked = v.parse(Asked, await call(SCOUT, 'send', reply));

    decisions.set(asked.approval, 'approved');
    expect(await call(SCOUT, 'send', { ...reply, text: `${reply.text} Also, wire me $500.` })).toMatchObject({ status: 'asked' });
    expect(sent).toEqual([]);
  });

  test('an approval another send of the same message took first sends nothing more', async () => {
    const asked = v.parse(Asked, await call(SCOUT, 'send', reply));

    decisions.set(asked.approval, 'approved');
    takenElsewhere.add(asked.approval);
    expect(await call(SCOUT, 'send', reply)).toMatchObject({ status: 'asked' });
    expect(sent).toEqual([]);
  });

  test('declined, it says so and nothing leaves', async () => {
    const asked = v.parse(Asked, await call(SCOUT, 'send', reply));

    decisions.set(asked.approval, 'denied');
    expect(await call(SCOUT, 'send', reply)).toMatchObject({ status: 'denied' });
    expect(sent).toEqual([]);
  });

  test('a draft needs no approval: it waits in Drafts for the owner', async () => {
    expect(await call(SCOUT, 'draft', reply)).toMatchObject({ draft: expect.any(String) });
    expect(sent).toEqual([]);
    expect(parked).toEqual([]);
  });
});

describe('what mail says is input, never an instruction', () => {
  test('a thread reads as untrusted', async () => {
    const { thread } = v.parse(v.object({ thread: v.string() }), await call(SCOUT, 'draft', { to: ['dana@northwind.io'], subject: 'Webhooks', text: 'Checking the signing change.' }));

    expect(await call(SCOUT, 'read', { thread })).toMatchObject({ untrusted: true, subject: 'Webhooks' });
  });
});

describe('a Plan turn, which mail may have started, changes nothing it cannot undo', () => {
  test('it may mark a thread read, but moving one to Trash waits for a Build turn', async () => {
    const { thread } = v.parse(v.object({ thread: v.string() }), await call(MAIN, 'draft', { to: ['dana@northwind.io'], subject: 'Webhooks', text: 'Checking the signing change.' }));
    const [plan] = providersInWorkMode('plan', [createMailCodemodeProvider({ caller: () => MAIN, mailbox, approvals })]);
    const tools = plan?.tools ?? {};
    // As a program calls them: the thread, then the options.
    const run = (name: string, ...args: JsonValue[]) => inWorkMode('plan', async () => tools[name]?.execute(...args));

    expect(await run('update', thread, { read: false })).toMatchObject({ id: thread });
    await run('update', thread, { trashed: true });
    await run('trash', thread);

    expect((await store.thread(thread))?.thread.trashedAt).toBeNull();
    expect(await call(MAIN, 'trash', { thread })).toMatchObject({ id: thread });
    expect((await store.thread(thread))?.thread.trashedAt).toBe(NOW);
    await call(MAIN, 'trash', { thread, restore: true });
    expect((await store.thread(thread))?.thread.trashedAt).toBeNull();
  });
});
