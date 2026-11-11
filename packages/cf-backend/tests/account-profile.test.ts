/**
 * The account owner's profile (owner, 2026-11-11). Every agent of the account reads the account's facts in its prompt on
 * every turn, with this workspace's own value of a key it holds too, so it knows where its owner lives with no memory
 * call, whatever else the account or its memory holds and whatever the turn asks. An import reads a document into notes and one batch of short
 * facts, which the owner keeps in one act, in place of the facts it was read from.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { catalogTurn, GATEWAY_CATALOG, gatewayWorkspace } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { kvOf } from './helpers/platform-context';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun, type StubbedAiBinding } from './helpers/platform-gateway';
import { readExport } from '@kinu.run/core';

const OWNER = 'abcdef0123456789abcdef0123456789';

/** An ask whose answer turns on where the owner lives, in words that name neither home nor living, as the trip the
 *  assistant planned from the wrong city did (2026-11-11): nothing the turn's words recall finds it. */
const QUESTION = 'Book my Thanksgiving flights.';

/** Where the owner lives, as a fact longer than the lines around it, so no gap the memory block leaves can hold it. */
const HOME = 'Austin, Texas, since the move in May 2025 for the job downtown';

/** Everything one request carried: its system prompt and every message. */
function carried(run: RecordedGatewayRun): string {
  return requestOf(run).messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
}

/** The model's answer to QUESTION: the home its request last states, as a later block's row replaces an earlier one's;
 *  no answer where it states none. */
function homeFrom(run: RecordedGatewayRun): string {
  return [...carried(run).matchAll(/^- home\.city: ([^\n#]+)/gmu)].at(-1)?.[1]?.trim() ?? 'I do not know.';
}

/** The agent's own requests answering QUESTION: those offering it tools, which a title or a background pass does not. */
function answering(gateway: StubbedAiBinding): RecordedGatewayRun[] {
  return gateway.runs.filter((run) => requestOf(run).tools.length > 0 && carried(run).includes(QUESTION));
}

/** A whole document section kept as one fact, as an import left the owner's before it was its own step. */
function section(at: number) {
  const content = `Day ${String(at)} of the spring conference trip: flights out of RDU, the hotel booking reference, the talk schedule, `
    + 'the dinner reservations, the visa paperwork checklist, and the follow-ups owed to each person met. '.repeat(18);

  return { title: `Trip notes, part ${String(at)}`, source: 'travel notebook', provenance: 'pasted 2026-10-17', content };
}

async function account(gateway: StubbedAiBinding) {
  const user = createTestUserDO({ durableObjectId: OWNER, aiGateway: gateway });
  const owner = await testOwner();
  const { version } = await user.userDO.getProfileCatalog(owner);

  await user.userDO.putProfileCatalog(owner, GATEWAY_CATALOG, version);
  await provisionTestWorkspace(user, 'research', 'Research');

  return { user, owner };
}

/** A fresh turn asking QUESTION in the account's workspace `name`, on `gateway`. */
async function askIn(user: TestUserDO, gateway: StubbedAiBinding, name: string, asks: readonly string[] = [QUESTION]) {
  const token = await provisionTestWorkspace(user, name, name);
  const workspace = gatewayWorkspace(gateway, { userDO: user.userDO, workspace: name, ownerUserId: OWNER });

  workspace.agent.harnessHoldsCapability(token);

  for (const ask of asks) await catalogTurn(workspace.agent, ask);
  await workspace.agent.harnessJoinDetachedFibers();
}

/** What an owner's account holds once a long document is read into short facts: people, places, habits, projects. Each
 *  key sorts before `home.city`, so a block that orders facts of one weight and age by key shows them first. */
const SHORT_FACTS = ['apps', 'books', 'calendar', 'diet', 'family', 'finance'].flatMap((topic) => Array.from({ length: 15 }, (_, at) => [
  `${topic}.fact_${String(at).padStart(2, '0')}`, `a stated preference or plan of the owner's about ${topic}, number ${String(at)}`,
] as const));

test("a fresh turn in a second workspace carries the account's home among many facts, and answers with no memory call", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, homeFrom(run)));
  const { user, owner } = await account(gateway);

  await user.userDO.accountMemory_put(owner, 'home.city', HOME);

  for (const [key, value] of SHORT_FACTS) await user.userDO.accountMemory_put(owner, key, value);

  for (let at = 1; at <= 26; at += 1) await user.userDO.accountMemory_put(owner, `profile.section-${String(at).padStart(2, '0')}`, section(at));

  await askIn(user, gateway, 'trips');

  const asked = answering(gateway);

  expect(asked.length).toBeGreaterThan(0);
  expect(asked.map(homeFrom)).toEqual(asked.map(() => HOME));
  expect(asked.flatMap((run) => requestOf(run).messages.filter((message) => message.role === 'tool'))).toEqual([]);
  await user.joinFibers();
  user.close();
});

/** Notes the agent keeps that match QUESTION's words, each long enough that four fill the turn's memory block. */
const MATCHING_NOTES = ['airlines', 'fares', 'seats', 'bags'].map((topic) => ({
  tool: 'memory', args: { op: 'note', content: `Thanksgiving weekend flights, ${topic}. ${'Flights for the Thanksgiving weekend: which airline, which weekend, which fare. '.repeat(8)}` },
}));

/** Notes that match nothing asked, which push the matching ones out of MEMORY.md's newest lines. */
const OTHER_NOTES = ['deploys', 'reviews', 'releases', 'logs'].map((topic) => ({
  tool: 'memory', args: { op: 'note', content: `Release habits: ${topic}. ${'Staging first, production after a green verdict, logs read before calling it done. '.repeat(8)}` },
}));

const KEEP_HOME = [...MATCHING_NOTES, ...OTHER_NOTES, { tool: 'memory', args: { op: 'remember', key: 'home.city', value: HOME } }];

test("this workspace's value of a key the account holds too is what its profile shows, even when recalled notes fill the block", async () => {
  const gateway = stubAiBinding((run) => {
    if (carried(run).includes(QUESTION)) return chatCompletion(run, homeFrom(run));
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;
    const call = requestOf(run).tools.length === 0 ? undefined : KEEP_HOME[step];

    return call === undefined ? chatCompletion(run, 'Noted.') : toolCallCompletion(run, call, `call_${String(step)}`);
  });

  const { user, owner } = await account(gateway);

  await user.userDO.accountMemory_put(owner, 'home.city', 'Raleigh');
  await askIn(user, gateway, 'trips', ['I moved to Austin; keep my travel notes.', QUESTION]);

  const asked = answering(gateway);

  expect(asked.length).toBeGreaterThan(0);
  expect(asked.map(homeFrom)).toEqual(asked.map(() => HOME));
  await user.joinFibers();
  user.close();
});

/** The owner's document: two parts the extractor reads one at a time, each past its owner-words window together. */
const DOCUMENT = [
  `About me\n\nI moved from Raleigh to Austin, Texas in 2024, and Austin is home now. ${'I fly out of AUS for work trips. '.repeat(60)}`,
  `People\n\nMy partner is Priya. ${'She plans the trips; I book the flights. '.repeat(60)}`,
].join('\n\n');

const ExtractorPromptSchema = v.object({ messages: v.array(v.object({ content: v.unknown() })) });

/** The extractor's answer for one piece: what it states about the owner, as JSON. */
function extracted(run: RecordedGatewayRun): string {
  const prompt = JSON.stringify(v.parse(ExtractorPromptSchema, run.query).messages);

  const owners = [
    ...(prompt.includes('Austin, Texas') ? [{ key: 'home.city', value: 'Austin', importance: 0.9, rationale: 'stated' }] : []),
    ...(prompt.includes('partner is Priya') ? [{ key: 'partner.name', value: 'Priya', importance: 0.7, rationale: 'stated' }] : []),
  ];

  return JSON.stringify({ upserts: [], decay: [], account: owners });
}

/** Each import is read as its jobs come due, piece by piece. */
async function readImports(user: TestUserDO): Promise<void> {
  for (let lap = 0; lap < 10 && (await user.userDO.accountMemory_view(await testOwner())).imports.length > 0; lap += 1) await user.userDO.alarm();
}

const modelAnswer = (run: RecordedGatewayRun) => chatCompletion(run, requestOf(run).tools.length === 0 && carried(run).includes('persistent state') ? extracted(run) : homeFrom(run));

test('an imported document becomes notes and one batch of short facts, and keeping it once puts them in every profile', async () => {
  const gateway = stubAiBinding(modelAnswer);
  const { user, owner } = await account(gateway);
  const id = await user.userDO.accountMemory_import(owner, { document: DOCUMENT });

  await readImports(user);
  const read = await user.userDO.accountMemory_view(owner);

  expect(read.imports).toEqual([]);
  expect(read.notes).toEqual([]);
  expect(read.pending.map((each) => each.id)).toEqual([id]);
  expect(read.pending[0]?.proposal).toMatchObject({
    kind: 'import', replaces: [],
    facts: expect.arrayContaining([expect.objectContaining({ key: 'home.city', value: 'Austin' }), expect.objectContaining({ key: 'partner.name', value: 'Priya' })]),
  });

  expect(await user.userDO.accountMemory_decide(owner, id, 'accept')).toBe(true);
  const kept = await user.userDO.accountMemory_view(owner);

  expect(kept.pending).toEqual([]);
  // The document is kept whole, as notes the memory tool searches.
  expect(kept.notes.length).toBeGreaterThan(1);
  expect(kept.notes.filter((note) => !DOCUMENT.includes(note.content))).toEqual([]);
  expect(kept.notes.map((note) => note.content).join('').length).toBeGreaterThanOrEqual(DOCUMENT.replace(/\n\n/gu, '').length);
  expect(kept.facts.map((fact) => [fact.key, fact.value])).toEqual(expect.arrayContaining([['home.city', 'Austin'], ['partner.name', 'Priya']]));

  await askIn(user, gateway, 'trips');
  expect(answering(gateway).map(homeFrom)).toEqual(answering(gateway).map(() => 'Austin'));
  await user.joinFibers();
  user.close();
});

test('facts the owner imports again are replaced by the batch in the act that keeps it', async () => {
  const gateway = stubAiBinding(modelAnswer);
  const { user, owner } = await account(gateway);
  const sections = ['profile.section-01', 'profile.section-02'];

  await user.userDO.accountMemory_put(owner, sections[0] ?? '', { title: 'About me', content: DOCUMENT.split('\n\nPeople')[0] ?? '' });
  await user.userDO.accountMemory_put(owner, sections[1] ?? '', { title: 'People', content: `People${DOCUMENT.split('\n\nPeople')[1] ?? ''}` });
  await user.userDO.accountMemory_put(owner, 'reply.language', 'English');

  const id = await user.userDO.accountMemory_import(owner, { facts: sections });

  await readImports(user);
  expect((await user.userDO.accountMemory_view(owner)).imports).toEqual([]);
  expect((await user.userDO.accountMemory_view(owner)).facts.map((fact) => fact.key).sort()).toEqual(['profile.section-01', 'profile.section-02', 'reply.language']);
  expect(await user.userDO.accountMemory_decide(owner, id, 'accept')).toBe(true);

  const kept = await user.userDO.accountMemory_view(owner);

  expect(kept.facts.map((fact) => fact.key).sort()).toEqual(['home.city', 'partner.name', 'reply.language']);
  expect(kept.notes.some((note) => note.content.includes('partner is Priya'))).toBe(true);
  await user.joinFibers();
  user.close();
});

/** The rest of a long conversation, so each of the two sits in a piece of its own. */
const CHORES = ' And a long list of other weekend errands, groceries and chores to sort out.'.repeat(30);

/** A ChatGPT export's conversations, newest first as an export may list them: the person lived in Raleigh in one, and
 *  moved to Austin in a later one. */
const CHATGPT_EXPORT = JSON.stringify([
  ['Moving checklist', '2025-05-02T10:00:00Z', `I moved to Austin last week, so update everything to Austin, Texas.${CHORES}`],
  ['Weekend plans', '2023-08-12T09:00:00Z', `I live in Raleigh, North Carolina. What can I do this weekend?${CHORES}`],
].map(([title, at, said]) => ({
  title, create_time: Date.parse(at ?? '') / 1000, current_node: 'answer',
  mapping: {
    ask: { parent: null, message: { author: { role: 'user' }, create_time: Date.parse(at ?? '') / 1000, content: { parts: [said] } } },
    answer: { parent: 'ask', message: { author: { role: 'assistant' }, create_time: Date.parse(at ?? '') / 1000 + 5, content: { parts: ['Noted.'] } } },
  },
})));

/** The extractor on one piece: what that piece's own words state, as a careful model would read them, never a fact
 *  from another piece. Which of two statements wins is the import's order alone. */
function extractedPerPiece(run: RecordedGatewayRun): string {
  const prompt = JSON.stringify(v.parse(ExtractorPromptSchema, run.query).messages);

  const said = (key: string, value: string, importance: number) => ({ key, value, importance, rationale: 'stated' });

  const owners = [
    ...(prompt.includes('moved to Austin') ? [said('home.city', 'Austin, Texas', 0.9), said('home.previous_city', 'Raleigh', 0.5)] : []),
    ...(prompt.includes('I live in Raleigh') ? [said('home.city', 'Raleigh, North Carolina', 0.9)] : []),
  ];

  return JSON.stringify({ upserts: [], decay: [], account: owners });
}

test("an AI export is read oldest first, so its newest statement is the home a first chat knows, with no memory call", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, requestOf(run).tools.length === 0 && carried(run).includes('persistent state') ? extractedPerPiece(run) : homeFrom(run)));
  const { user, owner } = await account(gateway);
  const bytes = new TextEncoder().encode(CHATGPT_EXPORT);
  const read = await readExport({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, false);

  // Raleigh and Austin in pieces of their own, the oldest first.
  expect({ conversations: read.conversations, read: read.read, said: read.pieces.map((piece) => ['Raleigh', 'Austin'].filter((city) => piece.includes(city))) })
    .toEqual({ conversations: 2, read: 2, said: [['Raleigh'], ['Austin']] });
  const id = await user.userDO.accountMemory_import(owner, { conversations: [...read.pieces] });

  await readImports(user);
  const batch = (await user.userDO.accountMemory_view(owner)).pending.find((each) => each.id === id)?.proposal;

  expect(batch).toMatchObject({ kind: 'import', keepNotes: false });
  expect(batch?.kind === 'import' ? Object.fromEntries(batch.facts.map((fact) => [fact.key, fact.value])) : null)
    .toEqual({ 'home.city': 'Austin, Texas', 'home.previous_city': 'Raleigh' });
  expect(await user.userDO.accountMemory_decide(owner, id, 'accept')).toBe(true);
  // An export's conversations are never kept: only what was read from them.
  expect((await user.userDO.accountMemory_view(owner)).notes).toEqual([]);

  await askIn(user, gateway, 'first-chat');
  const asked = answering(gateway);

  expect(asked.map(homeFrom)).toEqual(asked.map(() => 'Austin, Texas'));
  expect(asked.flatMap((run) => requestOf(run).messages.filter((message) => message.role === 'tool'))).toEqual([]);
  await user.joinFibers();
  user.close();
});

/** An import row as builds e68901c09 to ab0fff2ca wrote it: its pieces inside the row. */
function legacyImport(status: 'pending' | 'importing' | 'failed' | 'declined', notes: readonly string[], read: number, failure?: string) {
  return {
    status,
    json: JSON.stringify({
      kind: 'import', notes, read, facts: read === 0 ? [] : [{ key: 'home.city', value: 'Austin, Texas' }], replaces: [],
      ...(failure !== undefined && { failure }),
    }),
  };
}

test('import rows an earlier build wrote are kept as this one reads them, once, when the account starts', async () => {
  const storage = new Database(':memory:');
  const made = createTestUserDO({ storage, durableObjectId: OWNER });
  const owner = await testOwner();

  await made.userDO.accountMemory_view(owner);
  made.close();

  const rows = {
    amp_pending: legacyImport('pending', ['I live in Austin, Texas.', 'My partner is Meera.'], 2),
    amp_reading: legacyImport('importing', ['I fly out of AUS.', 'I keep a window seat.'], 1),
    amp_stopped: legacyImport('failed', ['I work on Kinu.'], 0, 'workers-ai: daily allocation used (4006)'),
    amp_declined: legacyImport('declined', ['A document the owner declined.'], 1),
  };

  for (const [id, row] of Object.entries(rows)) {
    storage.run('INSERT INTO account_memory_proposals (id, proposal_json, origin_json, delivery, status, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
      [id, row.json, JSON.stringify({ by: 'import' }), row.status, 1]);
  }

  const started = createTestUserDO({ storage, durableObjectId: OWNER });
  const view = await started.userDO.accountMemory_view(owner);

  // What a decided import held is not kept apart: nothing would ever read or drop it.
  expect([...kvOf(storage).keys()].filter((key) => key.startsWith('memory-import:amp_declined:'))).toEqual([]);
  expect([...kvOf(storage).keys()].filter((key) => key.startsWith('memory-import:amp_reading:'))).toHaveLength(2);

  expect(view.pending.map((each) => [each.id, each.proposal])).toEqual([
    ['amp_pending', { kind: 'import', pieces: 2, keepNotes: true, read: 2, facts: [{ key: 'home.city', value: 'Austin, Texas' }], replaces: [] }],
  ]);
  expect(view.imports.map(({ id, pieces, read, parked, failure }) => ({ id, pieces, read, parked, failure }))).toEqual([
    { id: 'amp_reading', pieces: 2, read: 1, parked: false, failure: null },
    { id: 'amp_stopped', pieces: 1, read: 0, parked: true, failure: 'workers-ai: daily allocation used (4006)' },
  ]);
  // Kept as it was: accepting writes the pieces the row held as notes.
  expect(await started.userDO.accountMemory_decide(owner, 'amp_pending', 'accept')).toBe(true);
  expect((await started.userDO.accountMemory_view(owner)).notes.map((note) => note.content).sort()).toEqual(['I live in Austin, Texas.', 'My partner is Meera.']);
  started.close();

  // A second start finds nothing left to convert, and changes nothing.
  const again = createTestUserDO({ storage, durableObjectId: OWNER });

  expect((await again.userDO.accountMemory_view(owner)).imports.map((each) => each.id)).toEqual(['amp_reading', 'amp_stopped']);
  again.close();
});

test('an export cut short, or holding anything but conversations, is refused before anything is offered to import', async () => {
  const conversation = JSON.stringify(JSON.parse(CHATGPT_EXPORT)[0]);

  const refusedFor = async (text: string) => {
    const bytes = new TextEncoder().encode(text);

    try {
      await readExport({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, false);

      return null;
    } catch (failure) {
      return failure;
    }
  };

  for (const text of [`[${conversation}, ${conversation.slice(0, 200)}`, `[null, ${conversation}]`, `{"conversations": [${conversation}]}`, `[${conversation}`]) {
    expect(await refusedFor(text)).toMatchObject({ code: 'bad_input' });
  }

  expect(await refusedFor(`[${conversation}, ${conversation}]`)).toBeNull();
});
