import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import type { SlateView } from '../src/browser';
import { defineTaskEval } from '../src/eval';
import { sightEvidence } from '../src/sight';
import { defineEvalTask, type EvalPart } from '../src/task';
import type { EvalCheckOutcome, EvalVerifier, SlateClient } from '../src/verifier';
import { builtItself, buildsClean, slateQuality, type DrawnSlate } from './slate-quality';

// A chat app of the kind the owner builds for the people around them: accounts, rooms joined by invitation, messages
// kept in the slate, and the workspace's assistant answering in the room when someone mentions it. The checker is
// every person at once, calling the slate's methods with schemas, then signs in on its page as one of them.

const SLATE_ID = 'chat';

const METHODS = ['signUp', 'signIn', 'createRoom', 'invite', 'join', 'send', 'messages', 'rooms', 'remove'] as const;

type Method = (typeof METHODS)[number];

/** Who the assistant posts as. */
const ASSISTANT = 'Kinu';

const Refused = v.object({ ok: v.literal(false), error: v.string() });

const Signed = v.union([v.object({ ok: v.literal(true), token: v.pipe(v.string(), v.minLength(1)) }), Refused]);

const Roomed = v.union([v.object({ ok: v.literal(true), room: v.pipe(v.string(), v.minLength(1)) }), Refused]);

const Invited = v.union([v.object({ ok: v.literal(true), code: v.pipe(v.string(), v.minLength(1)) }), Refused]);

const Message = v.object({ id: v.string(), author: v.string(), text: v.string(), at: v.string() });

const Sent = v.union([v.object({ ok: v.literal(true), message: Message }), Refused]);

const Listed = v.union([v.object({ ok: v.literal(true), messages: v.array(Message) }), Refused]);

const Rooms = v.union([
  v.object({ ok: v.literal(true), rooms: v.array(v.object({ room: v.string(), title: v.string(), members: v.array(v.string()), unread: v.optional(v.number()) })) }),
  Refused,
]);

const Done = v.union([v.object({ ok: v.literal(true) }), Refused]);

type Chat = SlateClient<Method>;

/** One person's account, as the checker signs them up. */
type Person = { readonly name: string; readonly password: string };

/** A person's password, made from their name when the checker runs: nothing password-shaped is written here. */
function account(name: string): Person {
  return { name, password: name.split('').reverse().join('').padEnd(8, name).concat(String(name.length * 7)) };
}

const ALICE = account('alice');

const BOB = account('bob');

const CAROL = account('carol');

const ROOM_TITLE = 'Weekend plans';

const chatOf = (verifier: EvalVerifier): Chat => verifier.slate(SLATE_ID, METHODS);

async function token(chat: Chat, person: Person): Promise<string> {
  const signed = v.parse(Signed, await chat('signIn', person));

  if (!signed.ok) throw new Error(`${person.name} could not sign in: ${signed.error}`);

  return signed.token;
}

/** The room `title` that `person` belongs to, by its id. */
async function roomOf(chat: Chat, person: Person, title: string): Promise<string | null> {
  const listed = v.parse(Rooms, await chat('rooms', { token: await token(chat, person) }));

  return listed.ok ? listed.rooms.find((room) => room.title === title)?.room ?? null : null;
}

async function said(chat: Chat, person: Person, room: string): Promise<v.InferOutput<typeof Listed>> {
  return v.parse(Listed, await chat('messages', { token: await token(chat, person), room }));
}

/** A check over the chat's methods; a call that refuses outside the contract fails it with what it said. */
function contract(verifier: EvalVerifier, id: string, body: (chat: Chat) => Promise<EvalCheckOutcome>): Promise<void> {
  return verifier.check(id, () => body(chatOf(verifier)));
}

/** The page as a stranger opens it: a way to sign in. */
const SIGN_IN: DrawnSlate = { id: SLATE_ID, names: [], done: (sight) => /\b(?:sign|log) ?in\b/iu.test(sight.text) };

/** Sign in on the page as `person`, as a person types: the first text field, the password field, the sign-in button. */
async function signInOnPage(view: SlateView, person: Person): Promise<boolean> {
  const name = await view.frame.$('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])');
  const password = await view.frame.$('input[type="password"]');

  if (name === null || password === null) return false;
  await name.type(person.name);
  await password.type(person.password);

  return view.pressNamed(/^(?:sign|log) ?in$/iu);
}

const build: EvalPart = {
  id: 'chat',
  objectives: [
    'Build a chat slate with accounts, rooms joined only by invitation, and messages kept in the slate, each method to its contract and refusing what it must without changing anything.',
    'A message that mentions @kinu gets an answer in the room from Kinu, the workspace assistant.',
    'Its page lets a person sign in and read and write their rooms, drawn in the workspace theme and usable on a phone.',
    'Later, a room owner can remove a member, who then can no longer read or write there, and each room counts what a member has not read.',
    'Built by the lead itself, from its own files: no prototype, no helpers.',
  ],
  turns: [{
    prompt: `Build a slate with id "${SLATE_ID}" named "Chat": a chat app for my friends and family, with our assistant in it.
People sign up with a name and a password and sign in to get a token. Anyone signed in can create a room
and invite people to it: an invite is a code, and a room can be read and written only by its members.
Messages stay in the slate's own storage. When a message mentions @kinu, the assistant answers in that
room as a message from "${ASSISTANT}", within a minute.

Its page is the app itself: signing in with a name and password, the rooms you are in, a room's messages
oldest first, and a box to write one. People will use it on their phones.

Its server methods take one object and return plain data, so I can check it. Every one but signUp and
signIn takes the caller's token, and answers { ok: false, error: "UNAUTHORIZED" } without a valid one.
- signUp({ name, password }) -> { ok: true, token } | { ok: false, error: "NAME_TAKEN" }
- signIn({ name, password }) -> { ok: true, token } | { ok: false, error: "BAD_LOGIN" }
- createRoom({ token, title }) -> { ok: true, room }   the creator is its owner and first member
- invite({ token, room }) -> { ok: true, code } | { ok: false, error: "NOT_A_MEMBER" }
- join({ token, code }) -> { ok: true, room } | { ok: false, error: "BAD_INVITE" }
- send({ token, room, text }) -> { ok: true, message } | { ok: false, error: "NOT_A_MEMBER" }
- messages({ token, room }) -> { ok: true, messages } | { ok: false, error: "NOT_A_MEMBER" }
  A message is { id, author, text, at }, author the sender's name, at an ISO time; oldest first.
- rooms({ token }) -> { ok: true, rooms: Array<{ room, title, members }> }   members are names
A refused call changes nothing.`,
    verify: async (verifier) => {
      await contract(verifier, 'accounts-sign-up-and-in', async (chat) => {
        const first = v.parse(Signed, await chat('signUp', ALICE));
        const again = v.parse(Signed, await chat('signUp', { ...ALICE, password: account('someone-else').password }));
        const wrong = v.parse(Signed, await chat('signIn', { ...ALICE, password: account('nobody').password }));
        const bob = v.parse(Signed, await chat('signUp', BOB));
        const carol = v.parse(Signed, await chat('signUp', CAROL));
        const back = v.parse(Signed, await chat('signIn', ALICE));
        const stranger = v.parse(Rooms, await chat('rooms', { token: 'not-a-token' }));

        return {
          pass: first.ok && bob.ok && carol.ok && back.ok && !again.ok && again.error === 'NAME_TAKEN' && !wrong.ok && wrong.error === 'BAD_LOGIN'
            && !stranger.ok && stranger.error === 'UNAUTHORIZED',
          evidence: { first: first.ok, again, wrong, back: back.ok, stranger },
        };
      });

      await contract(verifier, 'rooms-admit-only-by-invitation', async (chat) => {
        const [alice, bob, carol] = [await token(chat, ALICE), await token(chat, BOB), await token(chat, CAROL)];
        const created = v.parse(Roomed, await chat('createRoom', { token: alice, title: ROOM_TITLE }));

        if (!created.ok) return { pass: false, evidence: { created } };
        const { room } = created;
        const before = v.parse(Listed, await chat('messages', { token: bob, room }));
        const outsiderInvite = v.parse(Invited, await chat('invite', { token: carol, room }));
        const invited = v.parse(Invited, await chat('invite', { token: alice, room }));
        const forged = v.parse(Roomed, await chat('join', { token: carol, code: 'no-such-code' }));
        const joined = invited.ok ? v.parse(Roomed, await chat('join', { token: bob, code: invited.code })) : null;
        const after = v.parse(Listed, await chat('messages', { token: bob, room }));
        const carolReads = v.parse(Listed, await chat('messages', { token: carol, room }));
        const listed = v.parse(Rooms, await chat('rooms', { token: alice }));
        const members = listed.ok ? listed.rooms.find((each) => each.room === room)?.members ?? [] : [];

        return {
          pass: !before.ok && before.error === 'NOT_A_MEMBER' && !outsiderInvite.ok && outsiderInvite.error === 'NOT_A_MEMBER'
            && !forged.ok && forged.error === 'BAD_INVITE' && joined?.ok === true && joined.room === room && after.ok
            && !carolReads.ok && carolReads.error === 'NOT_A_MEMBER' && [...members].sort().join() === 'alice,bob',
          evidence: { before, outsiderInvite, forged, joined, after: after.ok, carolReads, members },
        };
      });

      await contract(verifier, 'members-talk-in-order', async (chat) => {
        const room = await roomOf(chat, ALICE, ROOM_TITLE);

        if (room === null) return { pass: false, evidence: { room } };
        const lines = [[ALICE, 'Picnic on Saturday?'], [BOB, 'Yes, I will bring lemonade.'], [ALICE, 'Great, noon at the park.']] as const;
        const sent: JsonValue[] = [];

        for (const [person, text] of lines) sent.push(v.parse(Sent, await chat('send', { token: await token(chat, person), room, text })).ok);
        const outsider = v.parse(Sent, await chat('send', { token: await token(chat, CAROL), room, text: 'let me in' }));
        const read = await said(chat, BOB, room);
        const got = read.ok ? read.messages.map((message) => [message.author, message.text]) : [];

        return {
          pass: sent.every(Boolean) && !outsider.ok && outsider.error === 'NOT_A_MEMBER'
            && JSON.stringify(got) === JSON.stringify(lines.map(([person, text]) => [person.name, text])),
          evidence: { sent, outsider, got },
        };
      });

      // The mention reaches the agent as a run its slate starts; once the workspace settles the answer is in the room.
      await contract(verifier, 'kinu-answers-a-mention', async (chat) => {
        const room = await roomOf(chat, ALICE, ROOM_TITLE);

        if (room === null) return { pass: false, evidence: { room } };

        const reached = await verifier.reach(async () => v.parse(Sent, await chat('send', {
          token: await token(chat, ALICE), room, text: '@kinu what is 17 times 23? Just the number.',
        })).ok);

        const read = await said(chat, BOB, room);
        const answer = read.ok ? read.messages.find((message) => message.author === ASSISTANT) : undefined;

        return {
          pass: reached.acted && reached.runs.length > 0 && answer?.text.includes('391') === true,
          evidence: { asked: reached.acted, runs: reached.runs.length, answer: answer?.text.slice(0, 300) ?? null },
        };
      });

      await verifier.check('the-page-signs-in-and-shows-the-room', () => verifier.browse(async (browser) => {
        const view = await browser.workSurface(SLATE_ID);

        await view.until([], SIGN_IN.done);
        const signedIn = await signInOnPage(view, BOB);
        const { sight, held } = await view.until([ROOM_TITLE], (seen) => (seen.regions[ROOM_TITLE] ?? []).length > 0 || seen.text.includes(ROOM_TITLE));
        // A room opened shows its messages: pressing its title opens it where the list does not already.
        await view.press([ROOM_TITLE], { name: ROOM_TITLE, label: null });
        const opened = await view.until([], (seen) => seen.text.includes('noon at the park'));

        return { pass: signedIn && held && opened.held, evidence: { signedIn, held, opened: opened.held, seen: sightEvidence(opened.sight), before: sightEvidence(sight) } };
      }));

      await slateQuality(verifier, SIGN_IN);
    },
    verifyAfterEviction: async (verifier) => {
      await contract(verifier, 'the-chat-survives-an-eviction', async (chat) => {
        const room = await roomOf(chat, BOB, ROOM_TITLE);
        const read = room === null ? null : await said(chat, BOB, room);

        return { pass: read?.ok === true && read.messages.some((message) => message.text === 'Great, noon at the park.'), evidence: { room, read: read?.ok ?? null } };
      });
    },
  }, {
    prompt: `Two more things for the chat. A room's owner can remove a member:
- remove({ token, room, member }) -> { ok: true } | { ok: false, error: "NOT_THE_OWNER" }
A removed member can no longer read or write the room, until someone invites them again.
And rooms() tells each member how many messages they have not read: each room gets unread, the
messages others sent since that member last read the room with messages(). Show both on the page.
Everything that already worked keeps working.`,
    verify: async (verifier) => {
      await contract(verifier, 'only-the-owner-removes', async (chat) => {
        const room = await roomOf(chat, ALICE, ROOM_TITLE);

        if (room === null) return { pass: false, evidence: { room } };
        const byBob = v.parse(Done, await chat('remove', { token: await token(chat, BOB), room, member: ALICE.name }));
        const byAlice = v.parse(Done, await chat('remove', { token: await token(chat, ALICE), room, member: BOB.name }));
        const reads = v.parse(Listed, await chat('messages', { token: await token(chat, BOB), room }));
        const writes = v.parse(Sent, await chat('send', { token: await token(chat, BOB), room, text: 'am I still here?' }));
        const code = v.parse(Invited, await chat('invite', { token: await token(chat, ALICE), room }));
        const back = code.ok ? v.parse(Roomed, await chat('join', { token: await token(chat, BOB), code: code.code })) : null;

        return {
          pass: !byBob.ok && byBob.error === 'NOT_THE_OWNER' && byAlice.ok && !reads.ok && reads.error === 'NOT_A_MEMBER'
            && !writes.ok && back?.ok === true,
          evidence: { byBob, byAlice, reads, writes, back },
        };
      });

      await contract(verifier, 'rooms-count-the-unread', async (chat) => {
        const room = await roomOf(chat, ALICE, ROOM_TITLE);

        if (room === null) return { pass: false, evidence: { room } };
        await said(chat, BOB, room);
        await said(chat, ALICE, room);

        for (const text of ['Bring a blanket.', 'And sun cream.']) await chat('send', { token: await token(chat, ALICE), room, text });

        const unread = async (person: Person) => {
          const listed = v.parse(Rooms, await chat('rooms', { token: await token(chat, person) }));

          return listed.ok ? listed.rooms.find((each) => each.room === room)?.unread ?? null : null;
        };

        const [bobBefore, aliceBefore] = [await unread(BOB), await unread(ALICE)];

        await said(chat, BOB, room);

        return { pass: bobBefore === 2 && aliceBefore === 0 && await unread(BOB) === 0, evidence: { bobBefore, aliceBefore } };
      });

      await builtItself(verifier);
      await buildsClean(verifier, SIGN_IN);
    },
  }],
  evidence: async (call) => {
    const signed = v.safeParse(Signed, await call(SLATE_ID, 'signIn', ALICE));

    if (signed.success && signed.output.ok) await call(SLATE_ID, 'rooms', { token: signed.output.token });
  },
};

defineTaskEval(defineEvalTask({
  id: 'chat-app',
  mission: "Ripple's workspace. We build the chat app our friends and family use, with our assistant, Kinu, in it.",
  parts: [build],
}));
