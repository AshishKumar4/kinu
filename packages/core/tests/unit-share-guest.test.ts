// A shared app's guest (slates/guest.ts) answers one visitor of one share and runs no program: its one tool calls the app
// as the visitor's page does. What it may reach is its app's own scope; anything else of the owner's runs only on their
// approval of that exact call, once, which no "always" widens; some members never. A visitor talks to their own guest
// only once they say who they are. Over the real share store, shared servers and the workspace's approval queue.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { createTestActors } from '@kinu.run/test-utils';
import { initSlateLiveShareTables, SlateLiveShareStore } from '../src/slates/live-shares';
import { SlateShareViewers } from '../src/slates/share-viewers';
import { SharedServers } from '../src/slates/shared-server';
import { SlateShareGuests, type GuestPrincipal } from '../src/slates/guest';
import { approvalKindOf, DeferredApprovalQueue, DeferredApprovalStore, initOwnerRequestsTable } from '../src/index';
import { preapproveSlateEffect } from '../src/slates/live-sharing';
import { actorReferenceOf } from '../src/identity/actor-handle';
import type { ShareGrant } from '../src/slates/sharing';
import type { SlateRoute } from '../src/slates/surface';
import type { JsonValue } from '../src/utils/json';
import { KinuError } from '../src/obs/error';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';

/** What a call came to: `ran`, or its refusal's code, as the host answers a refusal to the page that made the call. */
async function cameTo(answer: Promise<{ readonly ok: boolean }>): Promise<string> {
  const [settled] = await Promise.allSettled([answer]);

  if (settled?.status === 'fulfilled') return settled.value.ok ? 'ran' : 'refused';

  return settled?.reason instanceof KinuError ? settled.reason.code : 'threw';
}

// Dana's issue board, shared on her access: its page reads its notes and its digest slate's methods, files an issue
// through her GitHub (ticked), and its chat talks to her agent (ticked).
const grant: ShareGrant = {
  slates: ['board', 'digest'],
  members: [
    { slate: 'board', namespace: 'workspace', member: 'fs.text', impact: 'observe' },
    { slate: 'board', namespace: 'workspace', member: 'fs.write', impact: 'mutate' },
    { slate: 'board', namespace: 'mcp.github', member: 'create_issue', impact: 'externalSend' },
    { slate: 'board', namespace: 'agent', member: 'ask', impact: 'externalSend' },
  ],
};

function world(mode: 'own' | 'owner' = 'owner') {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  const sql = makeSql(db);
  const actors = createTestActors(sql, execRaw);

  initSlateLiveShareTables(execRaw);
  initOwnerRequestsTable(execRaw);
  const live = new SlateLiveShareStore(makeSqlExec(db));
  const guests = new SlateShareGuests(makeSqlExec(db));
  const decided: { guest: string; tool: string; decision: string }[] = [];

  const queue = new DeferredApprovalQueue({
    store: new DeferredApprovalStore(sql, actors.main), writes: null, remember: () => {}, wake: () => Effect.void,
    preapprove: async (effect) => { preapproveSlateEffect(live, effect); },
    guestDecided: async (effect, decision) => { decided.push({ guest: effect.guest, tool: effect.tool, decision }); },
  });

  live.add({ id: 's1', slate: 'board', visibility: 'public', handle: '0123456789', grant });

  if (mode === 'owner') live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, grant);

  const ownerEffects = { ask: queue.slateEffect.bind(queue), take: queue.takeSlateEffect.bind(queue), settle: async (...settled: Parameters<typeof queue.settle>) => queue.settle(...settled) };

  const servers = new SharedServers({
    authoritiesOf: (slate) => live.authoritiesOf(slate), revision: () => 'rev-1', generation: (slate) => live.generation(slate), ownerEffects,
  }, async () => 'Dana');

  const viewers = new SlateShareViewers({ live, shareEntry: () => null, ownerUserId: () => 'dana', ownerEffects });
  const guestActor = actors.sibling('guest-board-ana');
  const guest: GuestPrincipal = { actorId: guestActor.actorId, share: 's1', slate: 'board', subject: 'anon:ana' };

  guests.record(guest);
  const ran: string[] = [];
  const routes: SlateRoute[] = [];

  /**
   * A call on the board's surface: the guest's own (`own`), a call on its way (the app's server answering it), or the
   * visitor's own page's. `reaches`: what the call reaches inside itself as it runs, as a crafted tool's program does.
   */
  const call = (path: readonly string[], options: { by: 'guest' | 'on-guest-way' | 'visitor'; subject?: string; args?: JsonValue[]; reaches?: string } = { by: 'guest' }) => {
    const subject = options.subject ?? guest.subject;
    const args = options.args ?? [];
    const viewer = { share: 's1', subject, request: live.openRequest({ share: 's1', viewer: subject, path: '/' }), ...(options.by !== 'visitor' && { guest }) };

    return viewers.call({
      share: 's1', id: 'board', chain: [],
      request: { path: [...path], args, invocation: null },
      issued: { id: 'board', chain: [], incarnation: 'p1', generations: {}, viewer },
      ...(options.by === 'guest' && { guest }),
      gate: (routed) => servers.gate({ slate: 'board', chain: [], address: routed.address, effect: routed.effect, args, on: subject, viewer: true, ...(routed.guest !== undefined && { guest: routed.guest }) }),
      bound: (address) => servers.bounded({ slate: 'board', chain: [], address, viewer: true }),
      run: async (route, nested, admit) => {
        if (options.reaches !== undefined) {
          const [namespace = '', member = ''] = options.reaches.split(':');

          nested(namespace, member);
        }

        admit();
        ran.push(path.join('.'));
        routes.push(route);

        return { ok: true, value: { done: true } };
      },
    });
  };

  const asked = () => queue.list().map((row) => approvalKindOf(row));
  const decide = async (answer: 'approved' | 'always' | 'denied') => queue.decide(queue.list().map((row) => row.id), answer);

  return { call, ran, routes, asked, decide, decided, guest, guests, actors, guestActor, live };
}

test("a guest reaches its app's methods and files as its visitor would, and asks its owner for the exact call outside them", async () => {
  const { call, ran, asked } = world();

  expect(await cameTo(call(['slates', 'digest', 'latest']))).toBe('ran');
  expect(await cameTo(call(['fs', 'text'], { by: 'guest', args: [{ path: '/slates/board/notes.md' }] }))).toBe('ran');
  expect(ran).toEqual(['slates.digest.latest', 'fs.text']);
  expect(asked()).toEqual([]);

  // Outside its slate's files, a read the share grants still asks: a guest's grant is its app's scope, not the member.
  expect(await cameTo(call(['fs', 'text'], { by: 'guest', args: [{ path: '/home/main/notes.md' }] }))).toBe('denied');
  expect(await cameTo(call(['fs', 'text'], { by: 'guest', args: [{ path: '/slates/board/../../home/main/notes.md' }] }))).toBe('denied');
  // A tool the share grants on her access, and one it does not (memory), both ask her for that exact call.
  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'guest', args: [{ title: 'Webhook retries fail' }] }))).toBe('denied');
  expect(await cameTo(call(['memory', 'search'], { by: 'guest', args: [{ query: 'stripe keys' }] }))).toBe('denied');

  const effects = asked().flatMap((kind) => (kind.kind === 'slate-effect' ? [[kind.effect.server, kind.effect.tool, kind.effect.guest]] : []));

  expect(effects).toEqual([
    ['workspace', 'fs.text', expect.any(String)], ['workspace', 'fs.text', expect.any(String)],
    ['mcp.github', 'create_issue', expect.any(String)], ['memory', 'search', expect.any(String)],
  ]);
  expect(ran).toEqual(['slates.digest.latest', 'fs.text']);
});

test('the owner decides a guest\'s call for that call alone: the guest is told, its next same call runs once, "always" stands for nothing', async () => {
  const { call, ran, asked, decide, decided, guest } = world();
  const issue = [{ title: 'Webhook retries fail' }];

  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'guest', args: issue }))).toBe('denied');
  await decide('always');

  expect(decided).toEqual([{ guest: guest.actorId, tool: 'create_issue', decision: 'approved' }]);
  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'guest', args: issue }))).toBe('ran');
  expect(ran).toEqual(['mcp.github.create_issue']);

  // Spent, and nothing stood pre-approved: the same call, or another, asks again.
  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'guest', args: issue }))).toBe('denied');
  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'guest', args: [{ title: 'Another' }] }))).toBe('denied');
  expect(asked()).toHaveLength(2);
  expect(ran).toEqual(['mcp.github.create_issue']);

  await decide('denied');
  expect(decided.at(-1)).toMatchObject({ decision: 'denied' });
  expect(ran).toEqual(['mcp.github.create_issue']);
});

test('a guest never reaches the agents, a machine or itself, and what its call reaches inside itself stays in its scope', async () => {
  const { call, ran, asked } = world();

  for (const path of [['agent', 'ask'], ['agent', 'send'], ['agents', 'hire'], ['computer', 'exec']]) {
    expect(await cameTo(call(path, { by: 'guest', args: [{ text: 'hello' }] }))).toBe('denied');
  }

  // The app's own method, in scope, reaching the owner's GitHub inside itself, is cut there: it cannot wait on a card.
  expect(await cameTo(call(['slates', 'digest', 'fileIssue'], { by: 'guest', reaches: 'mcp.github:create_issue' }))).toBe('denied');
  // A call the app's server makes on the guest's way meets the guest's scope, whatever the share grants its visitors.
  expect(await cameTo(call(['fs', 'write'], { by: 'on-guest-way', args: [{ path: '/slates/board/notes.md', text: 'x' }] }))).toBe('denied');
  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'on-guest-way', args: [{ title: 'x' }] }))).toBe('denied');
  expect(ran).toEqual([]);
  expect(asked()).toEqual([]);
});

test('a visitor talks to their guest once they say who they are, and the share must lend its chat', async () => {
  const { call, routes, asked, live } = world();

  expect(await call(['agent', 'ask'], { by: 'visitor', subject: 'source:203.0.113.7', args: [{ text: 'Which issues are open?' }] })).toMatchObject({ ok: false, needs: 'identity' });

  expect(await cameTo(call(['agent', 'ask'], { by: 'visitor', subject: 'anon:ana', args: [{ text: 'Which issues are open?' }] }))).toBe('ran');
  // Routed to the visitor's own guest, and asking the owner nothing: the guest's own calls are what ask.
  expect(routes).toEqual([{ kind: 'agent', slate: 'board', text: 'Which issues are open?', ask: true, viewer: { share: 's1', subject: 'anon:ana' } }]);
  expect(asked()).toEqual([]);

  // Unticked, the app's chat is refused.
  live.setAuthority('s1', { mode: 'owner', grantRevision: 'rev-1' }, { ...grant, members: grant.members.filter((member) => member.namespace !== 'agent') });
  expect(await cameTo(call(['agent', 'ask'], { by: 'visitor', subject: 'anon:ana', args: [{ text: 'Hello?' }] }))).toBe('denied');
});

test("on each visitor's own access, a guest reaches its app's own scope and nothing of the owner's, asked or not", async () => {
  const { call, ran, asked } = world('own');

  expect(await cameTo(call(['slates', 'digest', 'latest']))).toBe('ran');
  expect(await cameTo(call(['mcp', 'github', 'create_issue'], { by: 'guest', args: [{ title: 'x' }] }))).toBe('denied');
  expect(ran).toEqual(['slates.digest.latest']);
  expect(asked()).toEqual([]);
});

test("a visitor has one live guest at a time: a retired guest is no one's, and their next is a new hire", () => {
  const { guests, guest, actors, guestActor } = world();

  expect(guests.of('s1', 'anon:ana')).toEqual(guest);
  expect(guests.of('s1', 'anon:bo')).toBeNull();
  expect(guests.hired('s1', 'anon:ana')).toBe(1);

  actors.directory.apply(actorReferenceOf(actors.main), actors.directory.storagePath(actorReferenceOf(actors.main)), {
    action: 'retire', name: 'guest-board-ana', reference: actorReferenceOf(guestActor),
  });

  expect(guests.of('s1', 'anon:ana')).toBeNull();
  // Still a guest: a retired guest never reads as an ordinary hire.
  expect(guests.principalOf(guest.actorId)).toEqual(guest);

  const next = actors.sibling('guest-board-ana-2');

  guests.record({ ...guest, actorId: next.actorId });
  expect(guests.of('s1', 'anon:ana')?.actorId).toBe(next.actorId);
  expect(guests.hired('s1', 'anon:ana')).toBe(2);
});
