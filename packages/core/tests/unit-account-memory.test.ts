/**
 * Facts and notes carry a scope. A workspace's facts stay its own; the account's are read alongside them, labelled, and
 * written only by proposal; a slate's memory never names the account. The facts store keeps importance, veracity and
 * who wrote each value, with every value a key held. Recall ranks with mnemopi's lexical rules (lexical-recall.ts).
 */
import { describe, expect, test } from 'bun:test';
import { createMemoryVfs, createTestFactsStore, createTestRuntime } from '@kinu.run/test-utils';
import {
  accountProposals, actorNamespaces, callOperation, listOperations, renderFactsBlock, searchFacts, sleepTimeWindow, SURFACE_POLICY, TurnContextBudget,
  unifiedFacts, WORKSPACE_ROOT,
  type AccountMemory, type AccountProposal, type ConversationProjection, type Fact, type JsonObject, type SurfaceActor,
} from '../src/index';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { expandedTokenGroups, lexicalGroupRelevance } from '../src/memory/lexical-recall';
import { renderFactsForTurn } from '../src/orchestrator/turn-surface';
import { conversationsFor } from './helpers';

const fact = (key: string, value: Fact['value'], extra: Partial<Fact> = {}): Fact => ({
  key, value, confidence: 1, source: '', lastObservedAt: 1_000, importance: 0.5, veracity: 'stated', origin: null, ...extra,
});

describe('the facts store keeps who wrote each value, and every value a key held', () => {
  test('importance, veracity and origin are kept; a changed value and a forget each add a revision', () => {
    const { facts } = createTestFactsStore();

    facts.upsert('owner_timezone', 'UTC', { importance: 0.9, veracity: 'stated', origin: { by: 'agent', agent: 'main' } });
    facts.upsert('owner_timezone', 'Asia/Kolkata', { origin: { by: 'owner' } });
    // The same value again changes nothing kept.
    facts.upsert('owner_timezone', 'Asia/Kolkata', { origin: { by: 'owner' } });

    expect(facts.recall('owner_timezone')).toMatchObject({ value: 'Asia/Kolkata', importance: 0.9, veracity: 'stated', origin: { by: 'owner' } });
    facts.forget('owner_timezone', { by: 'owner' });

    expect(facts.recall('owner_timezone')).toBeNull();
    expect(facts.history('owner_timezone').map((revision) => [revision.value, revision.origin?.by])).toEqual([
      [null, 'owner'], ['Asia/Kolkata', 'owner'], ['UTC', 'agent'],
    ]);
  });
});

describe("mnemopi's lexical recall", () => {
  test('a query word finds its synonyms, other forms of itself, and an identifier part', () => {
    const relevance = (query: string, text: string) => lexicalGroupRelevance(expandedTokenGroups(query), text);

    expect(relevance('db', 'the database is postgres')).toBeGreaterThan(0.6);
    expect(relevance('deploy', 'deploy_target: staging')).toBeGreaterThan(0.6);
    expect(relevance('backup', 'nightly backups run at 02:00')).toBe(0.35);
    // Too short to be another form: `pass` never finds `password`.
    expect(relevance('pass', 'the password rotates monthly')).toBe(0);
    expect(relevance('timezone', 'the deploy target is staging')).toBe(0);
  });

  test('a key covering the query outranks a value only naming it, and a stated fact a tool-read one', () => {
    const hits = searchFacts([
      fact('notes', 'the staging deploy happens on fridays'),
      fact('deploy_target', 'staging'),
      fact('deploy_window', 'fridays', { veracity: 'tool' }),
    ], 'deploy', 5, 1_000);

    expect(hits.map((hit) => hit.key)).toEqual(['deploy_target', 'deploy_window', 'notes']);
  });
});

describe('both scopes as one list', () => {
  test("a workspace fact wins inside its workspace; the account's are labelled; the block is the same bytes until a fact changes", () => {
    const workspace = [fact('reply_language', 'English for this client', { importance: 0.4 })];
    const account = [fact('reply_language', 'Hindi'), fact('owner_name', 'Ashish', { importance: 0.9 })];
    const unified = unifiedFacts(workspace, account);

    expect(unified.map((each) => [each.key, each.scope])).toEqual([['owner_name', 'account'], ['reply_language', 'workspace']]);

    const block = renderFactsBlock(unified);

    expect(block).toBe('owner_name: Ashish  # account\nreply_language: English for this client');
    expect(renderFactsBlock(unifiedFacts([...workspace], [...account]))).toBe(block);
  });
});

describe("each step's memory block, as the prompt cache sees it", () => {
  test('the same bytes on every step of a turn, with the account read once, until a fact itself changes', () => {
    const { facts } = createTestFactsStore();
    const account = [fact('owner_name', 'Ashish', { importance: 0.9 })];

    facts.upsert('deploy_target', 'staging');
    const steps = [renderFactsForTurn(facts, account), renderFactsForTurn(facts, account), renderFactsForTurn(facts, account)];

    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).toContain('owner_name: Ashish  # account');

    // A fact the step wrote changes the block once, and it holds again after.
    facts.upsert('deploy_target', 'production');
    const after = [renderFactsForTurn(facts, account), renderFactsForTurn(facts, account)];

    expect(after[0]).not.toBe(steps[0]);
    expect(after[1]).toBe(after[0]);
  });
});

/** An account whose facts and notes are fixed, and whose proposals are recorded. */
function recordingAccount(facts: Fact[]): AccountMemory & { readonly proposed: AccountProposal[] } {
  const proposed: AccountProposal[] = [];

  return {
    proposed,
    facts: async () => facts,
    searchNotes: async (query) => (query.includes('invoice') ? [{ id: 'acn_1', text: 'Invoices go to accounts@example.com', score: 0.7 }] : []),
    propose: async (proposal) => {
      proposed.push(proposal);

      return `amp_${String(proposed.length)}`;
    },
  };
}

function actorWith(account: AccountMemory | undefined): SurfaceActor {
  const { rt, stores } = createTestRuntime();
  const unreached = async (): Promise<never> => { throw new Error('not reached by this suite'); };

  return {
    executors: () => [],
    web: { search: { search: unreached, fetch: unreached, render: unreached, screenshot: unreached }, files: { vfs: createMemoryVfs().vfs, home: WORKSPACE_ROOT }, browser: null },
    memory: () => ({
      memory: rt.memory, facts: stores.facts, actor: rt.actor, conversations: conversationsFor(rt, stores.history), vectorStore: null,
      ...(account !== undefined && { account }),
    }),
    files: () => ({ vfs: rt.toolFiles, home: rt.storage.home, planes: rt.planes, memory: rt.memory, ledger: new TurnFileLedger(), budget: new TurnContextBudget() }),
    tasks: () => ({ list: stores.taskList, config: stores.config, roleSwitch: null }),
    db: stores.appData,
    programState: rt.actor.programState,
    agents: () => ({ mode: 'build', swarms: false }),
    self: null,
  };
}

const call = async (actor: SurfaceActor, id: string, input: JsonObject) =>
  (await callOperation(actorNamespaces(actor, SURFACE_POLICY.program), id, input, { callId: crypto.randomUUID(), signal: undefined })).value;

describe("an agent's memory where the account is wired", () => {
  test('an account write is a pending proposal, never kept; a workspace write is kept here', async () => {
    const account = recordingAccount([]);
    const actor = actorWith(account);

    expect(await call(actor, 'memory.remember', { key: 'Owner Name', value: 'Ashish', scope: 'account' })).toEqual({ key: 'owner_name', pending: true, proposal: 'amp_1' });
    expect(await call(actor, 'memory.note', { content: 'Invoices go to accounts@example.com', scope: 'account' })).toEqual({ pending: true, proposal: 'amp_2' });
    expect(await call(actor, 'memory.remember', { key: 'build_cmd', value: 'bun run build' })).toEqual({ key: 'build_cmd' });
    expect(account.proposed).toEqual([{ kind: 'fact', key: 'owner_name', value: 'Ashish' }, { kind: 'note', content: 'Invoices go to accounts@example.com' }]);
    expect(await call(actor, 'memory.recall', { key: 'owner_name' })).toBeNull();
  });

  test("recall reads the workspace's fact first, then the account's, and search labels every hit's scope", async () => {
    const actor = actorWith(recordingAccount([fact('owner_name', 'Ashish'), fact('reply_language', 'Hindi')]));

    await call(actor, 'memory.remember', { key: 'reply_language', value: 'English for this client' });

    expect(await call(actor, 'memory.recall', { key: 'reply_language' })).toMatchObject({ value: 'English for this client', scope: 'workspace' });
    expect(await call(actor, 'memory.recall', { key: 'owner_name' })).toMatchObject({ value: 'Ashish', scope: 'account' });

    const found = await call(actor, 'memory.search', { query: 'invoice owner name' });

    expect(found).toMatchObject({
      hits: expect.arrayContaining([
        expect.objectContaining({ ref: 'account fact: owner_name', scope: 'account' }),
        expect.objectContaining({ ref: 'account note: acn_1', scope: 'account' }),
      ]),
    });
  });

  test("a slate's memory never names the account, and where none is wired no call does", () => {
    const scopeOf = (actor: SurfaceActor, policy: keyof typeof SURFACE_POLICY) => listOperations(actorNamespaces(actor, SURFACE_POLICY[policy]))
      .filter((listing) => listing.id === 'memory.remember' || listing.id === 'memory.note')
      .map((listing) => JSON.stringify(listing.inputSchema).includes('"scope"'));

    const wired = actorWith(recordingAccount([]));

    expect({
      program: scopeOf(wired, 'program'),
      slate: scopeOf(wired, 'slate'),
      ownerSlate: scopeOf(wired, 'ownerSlate'),
      slateToolForViewer: scopeOf(wired, 'slateToolForViewer'),
      unwired: scopeOf(actorWith(undefined), 'program'),
    }).toEqual({ program: [true, true], slate: [false, false], ownerSlate: [false, false], slateToolForViewer: [false, false], unwired: [false, false] });
  });
});

describe('the background pass proposes to the account from the owner\'s own words only', () => {
  const row = (id: string, role: 'user' | 'assistant', content: string, metadata?: Record<string, string>): ConversationProjection => ({
    id, position: 0, role, turnId: null, content, toolCalls: [], recordedAt: 0, ...(metadata !== undefined && { metadata }),
  });

  test("a turn's owner words are the operator-authored rows; a harness turn has none", () => {
    const window = sleepTimeWindow([
      row('a2', 'assistant', 'done'), row('u2', 'user', 'nightly digest', { kinuAuthor: 'harness' }),
      row('a1', 'assistant', 'noted'), row('u1', 'user', 'I am Ashish and I prefer short answers'),
    ], () => false);

    expect(window.turns.map((turn) => turn.ownerWords)).toEqual(['I am Ashish and I prefer short answers', '']);
  });

  test('proposals are dropped when no owner spoke in the window, and keys are normalized', () => {
    const update = { upserts: [], decay: [], account: [{ key: 'Owner Name', value: 'Ashish', rationale: 'said so' }, { key: '  ', value: 'x', rationale: '' }] };
    const spoke = [{ task: 't', output: 'o', toolCalls: [], ownerWords: 'I am Ashish' }];
    const silent = [{ task: 'nightly digest', output: 'o', toolCalls: [], ownerWords: '' }];

    expect(accountProposals(update, spoke)).toEqual([{ kind: 'fact', key: 'owner_name', value: 'Ashish' }]);
    expect(accountProposals(update, silent)).toEqual([]);
  });
});
