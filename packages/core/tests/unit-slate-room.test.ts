/**
 * The room's caretaker on real SQLite: who may open a slate, what each person's calls hold, what reaches whom, and
 * what a revoke ends. The attacks are `lean/Kinu/Sharing/Attacks.lean`'s, replayed against the code that stops them.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initSlateRoomTables, RoomCaretaker, type Codec, type Session } from '../src/slates/room/caretaker';
import { canonicalRoot, type Elem } from '../src/slates/room/labels';
import { makeExecRaw, makeSqlExec } from './helpers';

const SAM = 'sam@acme.dev';

const ALICE = 'alice@acme.dev';

const BOB = 'bob@acme.dev';

const BEN = 'ben@acme.dev';

const GITHUB = 'https://api.githubcopilot.com/mcp/';

const METRICS = 'https://metrics.acme.dev/mcp';

const ANY: Codec = { kind: 'json', maxBytes: 4096 };

function newRoom() {
  const db = new Database(':memory:');

  initSlateRoomTables(makeExecRaw(db));
  const room = new RoomCaretaker({ db: makeSqlExec(db) });

  room.create({ workspace: 'sam', slate: 'board', owner: SAM, parent: null });
  room.publish(SAM, 'img-1', null);

  return room;
}

function enter(caretaker: RoomCaretaker, email: string | null, link = false): Session {
  const access = caretaker.open(email, link);

  if (access === null) throw new Error(`${email ?? 'a visitor'} may not open the slate`);

  return { email, access };
}

const secretRepo = { holder: ALICE, server: GITHUB, root: canonicalRoot({ owner: 'acme', repo: 'secret' }) };

/** Alice's own part reads her private repository; Bob, who cannot read it, opens the slate. */
function aliceReadsHerRepo() {
  const caretaker = newRoom();
  caretaker.invite(SAM, ALICE, 'edit');
  caretaker.invite(SAM, BOB, 'use');
  const alice = enter(caretaker, ALICE);
  const bob = enter(caretaker, BOB);

  const grant = caretaker.mint(ALICE, {
    personal: true, server: GITHUB, root: { owner: 'acme', repo: 'secret' }, tools: ['list_pull_requests'],
    fn: 'prs', domain: ANY, effect: false, sink: [],
  });

  const run = caretaker.admit({ requester: alice, fn: 'prs', input: null, grants: [grant.id], inputs: [], out: 'part:prs:alice' });

  expect(caretaker.toolStep(run.id, grant.id, 'list_pull_requests', { owner: 'acme', repo: 'secret' })).toEqual({ kind: 'go' });
  caretaker.write(run.id, 'fix the leak');

  return { caretaker, alice, bob, grant, run };
}

test('the owner opens, people added open as members, the link admits only with its key, and visitors without it get nothing', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BOB, 'use');

  expect(caretaker.open(SAM, false)).toEqual({ kind: 'owner' });
  expect(caretaker.open(BOB, false)?.kind).toBe('member');
  expect(caretaker.open(ALICE, true)).toBeNull();
  expect(caretaker.open(null, true)).toBeNull();
  caretaker.setLink(SAM, true);
  expect(caretaker.open(null, true)?.kind).toBe('link');
  expect(caretaker.open(ALICE, false)).toBeNull();
  expect(() => caretaker.setLink(BOB, false)).toThrow(/owner/);
});

test('stopping the link ends every link session for good, even after it is switched back on', () => {
  const caretaker = newRoom();
  caretaker.setLink(SAM, true);
  const visitor = enter(caretaker, null, true);

  expect(caretaker.current(visitor)).toBe(true);
  caretaker.setLink(SAM, false);
  caretaker.setLink(SAM, true);
  expect(caretaker.current(visitor)).toBe(false);
  expect(caretaker.current(enter(caretaker, null, true))).toBe(true);
});

test('removing someone ends their sessions, keeps them off the link, and adding them back opens a new membership', () => {
  const caretaker = newRoom();
  caretaker.setLink(SAM, true);
  caretaker.invite(SAM, BOB, 'use');
  const member = enter(caretaker, BOB);
  const viaLink = { email: BOB, access: { kind: 'link' as const, gen: caretaker.room().linkGen } };
  const other = enter(caretaker, null, true);

  caretaker.remove(SAM, BOB);
  expect(caretaker.current(member)).toBe(false);
  expect(caretaker.current(viaLink)).toBe(false);
  expect(caretaker.open(BOB, true)).toBeNull();
  expect(caretaker.mayFork(BOB)).toBe(false);
  // The link was re-keyed: other link visitors reopen.
  expect(caretaker.current(other)).toBe(false);
  caretaker.invite(SAM, BOB, 'use');
  expect(caretaker.current(enter(caretaker, BOB))).toBe(true);
});

test('leaving ends only the person\'s own membership', () => {
  const caretaker = newRoom();
  caretaker.setLink(SAM, true);
  caretaker.invite(SAM, BOB, 'use');
  const visitor = enter(caretaker, null, true);

  caretaker.remove(BOB, BOB);
  expect(caretaker.current(visitor)).toBe(true);
  expect(caretaker.open(BOB, true)?.kind).toBe('link');
});

test('Alice\'s private data reaches Bob as a placeholder, and Sam owning the slate cannot show it', () => {
  const { caretaker, alice, bob } = aliceReadsHerRepo();

  expect(caretaker.render('part:prs:alice', alice)).toEqual({ shown: true, value: 'fix the leak' });
  const seen = caretaker.render('part:prs:alice', bob);

  expect(seen.shown).toBe(false);
  expect(seen.shown ? [] : seen.hidden.map((elem) => elem.holder)).toEqual([ALICE]);
  expect(() => caretaker.show(SAM, secretRepo, null, 'anyone')).toThrow(/whose data/);
  expect(caretaker.render('part:prs:alice', bob).shown).toBe(false);
  // Alice shows it, for that part, to everyone here: then Bob sees it.
  caretaker.show(ALICE, secretRepo, 'prs', [SAM, BOB, BEN]);
  expect(caretaker.render('part:prs:alice', bob)).toEqual({ shown: true, value: 'fix the leak' });
});

test('a reader check that finds Bob reads the repository shows him the part unasked, and losing access hides it again', () => {
  const { caretaker, bob } = aliceReadsHerRepo();

  caretaker.checked(BOB, secretRepo, true);
  expect(caretaker.render('part:prs:alice', bob).shown).toBe(true);
  caretaker.checked(BOB, secretRepo, false);
  expect(caretaker.render('part:prs:alice', bob).shown).toBe(false);
});

test('a withdrawn show hides the part again at the next render', () => {
  const { caretaker, bob } = aliceReadsHerRepo();
  const show = caretaker.show(ALICE, secretRepo, 'prs', 'anyone');

  expect(caretaker.render('part:prs:alice', bob).shown).toBe(true);
  caretaker.unshow(ALICE, show.id);
  expect(caretaker.render('part:prs:alice', bob).shown).toBe(false);
});

test('a person\'s own connection acts only in their own requests', () => {
  const { caretaker, bob, grant } = aliceReadsHerRepo();

  expect(caretaker.grantsFor(bob, 'prs', null)).toEqual([]);
  expect(() => caretaker.admit({ requester: bob, fn: 'prs', input: null, grants: [grant.id], inputs: [], out: 'part:prs:bob' }))
    .toThrow(/does not admit/);
});

test('a run that read private data posts nothing public, and observes only what lies inside its label', () => {
  const { caretaker, alice, grant } = aliceReadsHerRepo();
  const run = caretaker.admit({ requester: alice, fn: 'prs', input: null, grants: [grant.id], inputs: [], out: 'part:prs:alice2' });

  expect(() => caretaker.post(run.id, 'board', 'leak')).toThrow(/private data/);
  caretaker.post(null, 'board', 'public');
  expect(caretaker.observe(run.id, 'board')).toBe('public');
  const plain = caretaker.admit({ requester: alice, fn: 'count', input: null, grants: [], inputs: [], out: 'part:count:alice' });
  expect(() => caretaker.observe(plain.id, 'part:prs:alice')).toThrow(/cannot read/);
});

test('a tool call reaches only observers who may see the run\'s label: Alice\'s secret never becomes Sam\'s argument', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, ALICE, 'edit');
  const alice = enter(caretaker, ALICE);

  const lend = caretaker.mint(SAM, {
    personal: false, server: METRICS, root: {}, tools: ['record'], fn: 'mix', domain: ANY, effect: false, sink: [],
  });

  const own = caretaker.mint(ALICE, {
    personal: true, server: GITHUB, root: { owner: 'acme', repo: 'secret' }, tools: ['list_pull_requests'], fn: 'mix',
    domain: ANY, effect: false, sink: [],
  });

  const run = caretaker.admit({ requester: alice, fn: 'mix', input: null, grants: [lend.id, own.id], inputs: [], out: 'part:mix' });

  expect(() => caretaker.toolStep(run.id, lend.id, 'record', {})).toThrow(/cannot see it/);
});

test('a person\'s own effect that would send their secret wider waits for them, and their yes is a show to its sink', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, ALICE, 'edit');
  caretaker.invite(SAM, BOB, 'use');
  const alice = enter(caretaker, ALICE);

  const repo = caretaker.mint(ALICE, {
    personal: true, server: GITHUB, root: { owner: 'acme', repo: 'secret' }, tools: ['list_pull_requests'], fn: 'mail',
    domain: ANY, effect: false, sink: [],
  });

  const mail = caretaker.mint(ALICE, {
    personal: true, server: 'https://mail.acme.dev/mcp', root: {}, tools: ['send'], fn: 'mail', domain: ANY, effect: true, sink: 'anyone',
  });

  const run = caretaker.admit({ requester: alice, fn: 'mail', input: null, grants: [repo.id, mail.id], inputs: [], out: 'part:mail' });
  const verdict = caretaker.toolStep(run.id, mail.id, 'send', { to: BOB });

  expect(verdict.kind).toBe('wait');

  if (verdict.kind !== 'wait') return;
  expect(verdict.pending.kind).toBe('outflow');
  expect(caretaker.waiting(ALICE).map((each) => each.id)).toEqual([verdict.pending.id]);
  expect(() => caretaker.decide(BOB, verdict.pending.id, true)).toThrow(/holder decides/);
  caretaker.decide(ALICE, verdict.pending.id, true);
  caretaker.resume(verdict.pending.id);
});

test('an effect someone else asks for waits at its step, and one approval goes ahead once', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BOB, 'use');
  const bob = enter(caretaker, BOB);

  const deploy = caretaker.mint(SAM, {
    personal: false, server: METRICS, root: {}, tools: ['deploy'], fn: 'deploy', domain: { kind: 'integer', min: 1, max: 52 }, effect: true, sink: [],
  });

  caretaker.show(SAM, deploy, 'deploy', 'anyone');
  const run = caretaker.admit({ requester: bob, fn: 'deploy', input: 41, grants: [deploy.id], inputs: [], out: 'part:deploy' });
  const first = caretaker.toolStep(run.id, deploy.id, 'deploy', { week: 41 });

  expect(first.kind).toBe('wait');

  if (first.kind !== 'wait') return;
  caretaker.decide(SAM, first.pending.id, true);
  caretaker.resume(first.pending.id);
  // The run's next step is another step: it waits again.
  expect(caretaker.toolStep(run.id, deploy.id, 'deploy', { week: 41 }).kind).toBe('wait');
  expect(() => caretaker.resume(first.pending.id)).toThrow(/dropped/);
});

test('an input outside a lend\'s codec is never admitted', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BOB, 'use');
  const bob = enter(caretaker, BOB);

  const lend = caretaker.mint(SAM, {
    personal: false, server: METRICS, root: {}, tools: ['deploys'], fn: 'weekly', domain: { kind: 'integer', min: 0, max: 52 }, effect: false, sink: [],
  });

  expect(caretaker.grantsFor(bob, 'weekly', 60)).toEqual([]);
  expect(() => caretaker.admit({ requester: bob, fn: 'weekly', input: 60, grants: [lend.id], inputs: [], out: 'p' })).toThrow(/does not admit/);
  expect(caretaker.grantsFor(bob, 'weekly', 3).map((grant) => grant.id)).toEqual([lend.id]);
});

test('a lend never admits a visitor who has not signed in', () => {
  const caretaker = newRoom();
  caretaker.setLink(SAM, true);
  const visitor = enter(caretaker, null, true);
  caretaker.mint(SAM, { personal: false, server: METRICS, root: {}, tools: ['deploys'], fn: 'weekly', domain: ANY, effect: false, sink: [] });

  expect(caretaker.grantsFor(visitor, 'weekly', null)).toEqual([]);
  expect(caretaker.grantsFor(null, 'weekly', null)).toHaveLength(1);
});

test('a revoked grant stops a run at its next step, and minting again does not revive it', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BOB, 'use');
  const bob = enter(caretaker, BOB);
  const lend = caretaker.mint(SAM, { personal: false, server: METRICS, root: {}, tools: ['deploys'], fn: 'weekly', domain: ANY, effect: false, sink: [] });
  const run = caretaker.admit({ requester: bob, fn: 'weekly', input: null, grants: [lend.id], inputs: [], out: 'p' });

  caretaker.revoke(SAM, lend.id);
  caretaker.mint(SAM, { personal: false, server: METRICS, root: {}, tools: ['deploys'], fn: 'weekly', domain: ANY, effect: false, sink: [] });
  expect(caretaker.runOk(run)).toBe(false);
  expect(() => caretaker.toolStep(run.id, lend.id, 'deploys', {})).toThrow(/revoked/);
  expect(() => caretaker.release(run.id, bob)).toThrow(/revoked/);
});

test('an editor\'s edit suspends the owner\'s lend until the owner lends it again, and re-binds only the editor\'s own', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BEN, 'edit');
  const ben = enter(caretaker, BEN);
  caretaker.mint(SAM, { personal: false, server: METRICS, root: {}, tools: ['deploy'], fn: 'deploy', domain: ANY, effect: true, sink: [] });
  caretaker.mint(BEN, { personal: true, server: GITHUB, root: {}, tools: ['issues'], fn: 'deploy', domain: ANY, effect: false, sink: [] });

  caretaker.publish(BEN, 'img-ben', null);
  expect(caretaker.room().foreign).toBe(true);
  expect(caretaker.grantsFor(enter(caretaker, SAM), 'deploy', null)).toEqual([]);
  expect(caretaker.grantsFor(ben, 'deploy', null).map((grant) => grant.holder)).toEqual([BEN]);
  caretaker.mint(SAM, { personal: false, server: METRICS, root: {}, tools: ['deploy'], fn: 'deploy', domain: ANY, effect: true, sink: [] });
  expect(caretaker.grantsFor(ben, 'deploy', null).map((grant) => grant.holder).sort()).toEqual([BEN, SAM]);
});

test('a Use member cannot change the code or lend, and nobody but the owner manages people', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BOB, 'use');

  expect(() => caretaker.publish(BOB, 'img-bob', null)).toThrow(/cannot change/);
  expect(() => caretaker.mint(BOB, { personal: false, server: METRICS, root: {}, tools: [], fn: 'f', domain: ANY, effect: false, sink: [] }))
    .toThrow(/editor/);
  expect(() => caretaker.invite(BOB, ALICE, 'use')).toThrow(/owner/);
});

test('a secret in the code turns the link off with the image that holds it, and keeps it off until it is gone', () => {
  const caretaker = newRoom();
  caretaker.setLink(SAM, true);
  caretaker.publish(SAM, 'img-2', { file: 'server.ts', line: 4, kind: 'API key' });

  expect(caretaker.room()).toMatchObject({ link: false, image: 'img-2', secret: { file: 'server.ts', line: 4 } });
  expect(() => caretaker.setLink(SAM, true)).toThrow(/secret/);
  caretaker.publish(SAM, 'img-3', null);
  caretaker.setLink(SAM, true);
  expect(caretaker.room().link).toBe(true);
});

test('who used a lend is counted per function and person', () => {
  const caretaker = newRoom();
  caretaker.invite(SAM, BOB, 'use');
  const bob = enter(caretaker, BOB);
  const lend = caretaker.mint(SAM, { personal: false, server: METRICS, root: {}, tools: ['deploys'], fn: 'weekly', domain: ANY, effect: false, sink: [] });

  caretaker.admit({ requester: bob, fn: 'weekly', input: null, grants: [lend.id], inputs: [], out: 'a' });
  caretaker.admit({ requester: bob, fn: 'weekly', input: null, grants: [lend.id], inputs: [], out: 'b' });
  expect(caretaker.lendUses()).toMatchObject([{ fn: 'weekly', email: BOB, calls: 2 }]);
});

test('asks wait for their holder until answered by a show', () => {
  const { caretaker, bob } = aliceReadsHerRepo();
  const seen = caretaker.render('part:prs:alice', bob);
  const hiddenElems: Elem[] = seen.shown ? [] : seen.hidden;

  caretaker.ask(BOB, hiddenElems);
  expect(caretaker.asks(ALICE)).toEqual([{ asker: BOB, tag: secretRepo, fn: 'prs' }]);
  caretaker.show(ALICE, secretRepo, 'prs', [BOB]);
  expect(caretaker.asks(ALICE)).toEqual([]);
});
