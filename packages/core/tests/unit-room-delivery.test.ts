/**
 * What a room delivers, and to whom: a run's output kept with the run's own label whoever runs the part after it, a
 * failure hidden as its value would be, page code given only what anyone may see, a change of the slate only from a
 * signed-in person's current call, and a grant's terms fixed by what each of its tools is.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateRoomTables, RoomCaretaker, type Session } from '../src/slates/room/caretaker';
import { codecAdmits, codecIsFree, UNDECLARED } from '../src/slates/codec';
import { joinTerms, toolTerms } from '../src/slates/room/terms';
import { partDecision } from '../src/slates/room/views';
import { makeExecRaw, makeSqlExec } from './helpers';

const SAM = 'sam@acme.dev';

const ALICE = 'alice@acme.dev';

const BOB = 'bob@acme.dev';

const GITHUB = 'mcp.GitHub';

const REPO = { owner: 'acme', repo: 'secret' };

function newRoom(): RoomCaretaker {
  const db = new Database(':memory:');

  initSlateRoomTables(makeExecRaw(db));
  const room = new RoomCaretaker({ db: makeSqlExec(db) });

  room.create({ workspace: 'sam', slate: 'board', title: 'Board', owner: SAM, parent: null });
  room.publish(SAM, { image: 'img-1', modules: {}, title: 'Board', secret: null });
  room.invite(SAM, ALICE, 'edit');
  room.invite(SAM, BOB, 'use');

  return room;
}

function enter(room: RoomCaretaker, email: string | null, link = false): Session {
  const access = room.open(email, link);

  if (access === null) throw new Error(`${email ?? 'a visitor'} may not open the slate`);

  return { email, access };
}

function aliceGrant(room: RoomCaretaker) {
  return room.mint(ALICE, { personal: true, server: GITHUB, root: REPO, tools: ['list_pull_requests'], fn: 'prs', domain: UNDECLARED, effect: false, sink: [] });
}

const live = { need: undefined, computing: false, again: undefined };

test('a part\'s output is each run\'s own: a later run of the part never relabels what an earlier one writes', () => {
  const room = newRoom();
  const alice = enter(room, ALICE);
  const bob = enter(room, BOB);
  const grant = aliceGrant(room);
  const secret = room.admit({ requester: alice, fn: 'prs', input: [], grants: [grant.id], inputs: [], out: 'prs.part' });
  const plain = room.admit({ requester: bob, fn: 'prs', input: [], grants: [], inputs: [], out: 'prs.part' });

  room.write(plain.id, 'nothing yet');
  room.write(secret.id, 'the-secret');

  // The part shows its newest run's output, and Alice's late write stays in her run's own row, under her label.
  expect(room.render('prs.part', bob)).toEqual({ shown: true, value: 'nothing yet' });
  expect(room.output('prs.part')?.run).toBe(plain.id);
});

test('a part whose run failed shows its failure only to whoever may see its label', () => {
  const room = newRoom();
  const alice = enter(room, ALICE);
  const bob = enter(room, BOB);
  const run = room.admit({ requester: alice, fn: 'prs', input: [], grants: [aliceGrant(room).id], inputs: [], out: 'prs.alice' });

  room.write(run.id, { failed: 'the-secret' });

  expect(partDecision(room, 'prs.alice', bob, live)).toMatchObject({ kind: 'placeholder' });
  expect(partDecision(room, 'prs.alice', alice, live)).toEqual({ kind: 'failed', message: 'the-secret' });
});

test('page code is given a value only when anyone may see it: not for being the owner\'s, nor for every member seeing it', () => {
  const room = newRoom();
  const sam = enter(room, SAM);
  const own = room.mint(SAM, { personal: true, server: GITHUB, root: REPO, tools: ['list_pull_requests'], fn: 'prs', domain: UNDECLARED, effect: false, sink: [] });
  const run = room.admit({ requester: sam, fn: 'prs', input: [], grants: [own.id], inputs: [], out: 'prs.sam' });

  // An owner-only room, everyone in it Sam: still not anyone's.
  expect(room.releaseToPage(run.id, sam)).toBe(false);
  room.show(SAM, { holder: SAM, server: GITHUB, root: own.root }, 'prs', [SAM, ALICE, BOB]);
  expect(room.releaseToPage(run.id, sam)).toBe(false);
  room.show(SAM, { holder: SAM, server: GITHUB, root: own.root }, 'prs', 'anyone');
  expect(room.releaseToPage(run.id, sam)).toBe(true);

  const plain = room.admit({ requester: sam, fn: 'count', input: [], grants: [], inputs: [], out: null });

  expect(room.releaseToPage(plain.id, sam)).toBe(true);
});

test('the slate changes only in a current call of someone signed in: never a visitor\'s, never after access ended', () => {
  const room = newRoom();

  room.setLink(SAM, true);
  const visitor = enter(room, null, true);
  const bob = enter(room, BOB);
  const visitorRun = room.admit({ requester: visitor, fn: 'count', input: [], grants: [], inputs: [], out: null });
  const bobRun = room.admit({ requester: bob, fn: 'count', input: [], grants: [], inputs: [], out: null });

  expect(room.mayPost(visitorRun.id)).toBe(false);
  expect(() => room.post(visitorRun.id, 'board', 'graffiti')).toThrow(/Sign in/);
  expect(room.mayPost(bobRun.id)).toBe(true);
  room.post(bobRun.id, 'board', 'hello');
  room.remove(SAM, BOB);
  expect(room.mayPost(bobRun.id)).toBe(false);
  expect(() => room.post(bobRun.id, 'board', 'still here')).toThrow(/revoked/);
  expect(room.cell('board')?.value).toBe('hello');
});

test('a grant\'s id is its generation: taken back and granted again, a run that held the old one stops', () => {
  const room = newRoom();
  const alice = enter(room, ALICE);
  const first = aliceGrant(room);
  const run = room.admit({ requester: alice, fn: 'prs', input: [], grants: [first.id], inputs: [], out: 'prs.alice' });

  room.revoke(ALICE, first.id);
  const again = aliceGrant(room);

  expect(again.id).not.toBe(first.id);
  expect(room.runOk(run)).toBe(false);
});

test('a grant\'s terms are what each of its tools is, and a grant holding several takes the strictest of each', () => {
  expect(toolTerms('mcp.GitHub', 'list_pull_requests', true)).toEqual({ effect: false, sink: [] });
  expect(toolTerms('mcp.GitHub', 'create_issue', false)).toEqual({ effect: true, sink: 'anyone' });
  expect(toolTerms('ai', 'complete', false)).toEqual({ effect: false, sink: [] });
  expect(toolTerms('nowhere', 'nothing', false)).toBeNull();

  const read = toolTerms('mcp.GitHub', 'list_pull_requests', true);
  const write = toolTerms('mcp.GitHub', 'create_issue', false);

  if (read === null || write === null) throw new Error('both are MCP tools');
  expect(joinTerms(read, write)).toEqual({ effect: true, sink: 'anyone' });
  expect(joinTerms(write, read)).toEqual({ effect: true, sink: 'anyone' });
  expect(joinTerms({ effect: false, sink: [ALICE] }, { effect: false, sink: [BOB] })).toEqual({ effect: false, sink: [ALICE, BOB] });
});

test('a function that declares no contract takes whatever its call carries, and says it takes free input', () => {
  expect(codecIsFree(UNDECLARED)).toBe(true);
  expect(codecAdmits(UNDECLARED, { anything: ['at', 'all'] })).toBe(true);
});
