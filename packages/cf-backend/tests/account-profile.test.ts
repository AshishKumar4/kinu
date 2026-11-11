/**
 * The account owner's profile (owner, 2026-11-11). Every agent of the account reads the account's facts in its prompt on
 * every turn, with this workspace's own value of a key it holds too, so it knows where its owner lives with no memory
 * call, whatever else the account or its memory holds and whatever the turn asks. An import reads a document into notes and one batch of short
 * facts, which the owner keeps in one act, in place of the facts it was read from.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { catalogTurn, GATEWAY_CATALOG, gatewayWorkspace } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun, type StubbedAiBinding } from './helpers/platform-gateway';

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
