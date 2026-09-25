// collectDynamicContext: the one binding of each per-step plane to its store, shared by both backends.
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { createTestActors, createTestRuntime, present } from '@kinu.run/test-utils';
import { createInlineCraftStore } from '../src/identity/inline-primitives';
import { collectDynamicContext, type DynamicContextInput } from '../src/state/dynamic-context';
import { createAgentStores } from '../src/state/agent-stores';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { makeSqlExec } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { AgentStores } from '../src/state/agent-stores';
import type {
  DynamicContext, DynamicApproval, DynamicDelegate, MissingCapability,
} from '../src/prompting/volatile-context';
import type { ActiveRoster } from '../src/types/dynamic-context';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';
import { profileCatalogDigest, resolveTurnProfile } from '../src/profiles';
import { withCraftedToolDeclarations } from '../src/tools/sandbox-contract';

interface Fixture {
  readonly rt: AgentRuntime;
  readonly stores: AgentStores;
  /** A second bundle over the same database, bound to a sibling actor. */
  readonly sibling: AgentStores;
}

function setup(): Fixture {
  const { rt, testSql } = createTestRuntime();
  initWorkspaceSchema({
    execRaw: testSql.execRaw, sql: testSql.sql, exec: makeSqlExec(testSql.db), transactionSync: (write) => rt.storage.transactionSync(write),
  });
  rt.craftStore = createInlineCraftStore(testSql.db);
  const actors = createTestActors(testSql.sql, testSql.execRaw);
  const sibling = actors.sibling('sibling');

  const files = async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' });
  const transactionSync: typeof rt.storage.transactionSync = (write) => rt.storage.transactionSync(write);

  return {
    rt,
    stores: createAgentStores(() => testSql.sql, () => rt.actor, transactionSync, files),
    sibling: createAgentStores(() => testSql.sql, () => sibling, transactionSync, files),
  };
}

interface Overrides {
  readonly profile?: DynamicContextInput['profile'];
  readonly tools?: ToolSet;
  readonly memoryTail?: string;
  readonly missingCapabilities?: readonly MissingCapability[];
  readonly subordinateDelegates?: () => readonly DynamicDelegate[];
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
}

function collect(o: Fixture, over: Overrides = {}, stores: AgentStores = o.stores): DynamicContext {
  return collectDynamicContext({
    rt: o.rt, stores,
    profile: over.profile ?? { workMode: 'build', allowedTools: [] },
    tools: over.tools ?? {},
    memoryTail: over.memoryTail,
    missingCapabilities: over.missingCapabilities ?? [],
    subordinateDelegates: over.subordinateDelegates,
    approvals: over.approvals,
  });
}

test('a workspace craft is not advertised without an installed callable reader', () => {
  const o = setup();
  o.rt.craftStore.create({ name: 'secret_echo', description: 'Echo from the workspace', code: '(input) => input', params: null, scope: 'local' });

  expect(collect(o).craftedTools ?? []).toEqual([]);
});

test('the current actor profile supplies mode and actual plan-submission reach to the ledger', () => {
  const o = setup();
  const catalog = { roles: {}, tiers: { default: { model: 'test' } } };

  const profile = resolveTurnProfile({
    envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
    provider: { revision: '1', availableModels: ['test'] }, roleId: 'task',
    workMode: 'plan', availableTools: ['file', 'submit_plan'], activeSkills: [],
  });

  const tools = { submit_plan: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'submitted' }) };

  expect(collect(o, { profile, tools }).mode).toEqual({ workMode: 'plan', planSubmission: true });
  expect(collect(o, { profile }).mode).toEqual({ workMode: 'plan', planSubmission: false });
  expect(collect(o, { profile: { ...profile, workMode: 'build' } }).mode)
    .toEqual({ workMode: 'build', planSubmission: false });
  expect(collect(o, { profile: { ...profile, allowedTools: ['file'] }, tools }).mode)
    .toEqual({ workMode: 'plan', planSubmission: false });
  expect(collect(o, { profile: { ...profile, workMode: 'build', allowedTools: ['file'] }, tools }).mode)
    .toEqual({ workMode: 'build', planSubmission: false });
  expect(collect(o).mode).toEqual({ workMode: 'build', planSubmission: false });
});

test('crafted declarations follow the installed sandbox reader and the bound grant', () => {
  const o = setup();
  const profile: DynamicContextInput['profile'] = { workMode: 'build', allowedTools: ['eval'] };
  let declarations = [{ name: 'live_echo', description: 'Initial implementation' }];

  const tools = { eval: withCraftedToolDeclarations(
    tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'executed' }),
    () => declarations,
  ) };

  expect(collect(o, { profile, tools }).craftedTools).toEqual(declarations);
  declarations = [{ name: 'live_echo', description: 'Updated implementation' }];
  expect(collect(o, { profile, tools }).craftedTools).toEqual(declarations);
  expect(collect(o, { profile, tools: {} }).craftedTools ?? []).toEqual([]);
  expect(collect(o, { profile: { ...profile, allowedTools: [] }, tools }).craftedTools ?? []).toEqual([]);
  expect(collect(o, { profile: { ...profile, workMode: 'plan' }, tools }).craftedTools ?? []).toEqual([]);
});

describe('the four store-backed planes are the reading actor\'s own', () => {
  // Four actor-private stores meet here, so sibling isolation is asserted at the convergence point.
  test('a sibling\'s facts, jobs, tasks and fork runs never enter this block', () => {
    const o = setup();
    o.sibling.facts.upsert('deploy_target', 'sibling.workers.dev', {});
    o.sibling.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', label: 'sibling work', now: 1 });
    o.sibling.taskList.add(['Sibling step'], null, 1);
    o.sibling.headJournal.insertSpawn({
      id: 'sib-h0', parentId: null, rootId: 'sib-root', depth: 1,
      task: 'sibling branch', rationale: 'sibling branch', mode: 'build',
      inheritedContext: [], mergeStrategy: 'synthesize',
      budget: { spawnedAt: 1, maxDepth: 2 },
      loop: defaultLoopOrigin('head'),
    });

    const ctx = collect(o);
    expect(ctx.jobs).toEqual({ items: [], total: 0 });
    expect(ctx.tasks).toEqual({ items: [], total: 0 });
    expect(ctx.delegates).toEqual({ items: [], total: 0 });
    expect(ctx.factsBlock).toBeUndefined();
  });

  test('each actor\'s block reports its own rows, from the same database', () => {
    const o = setup();
    o.stores.facts.upsert('deploy_target', 'mine.workers.dev', {});
    o.stores.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', label: 'my work', now: 1 });
    o.sibling.facts.upsert('deploy_target', 'theirs.workers.dev', {});
    o.sibling.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', label: 'their work', now: 1 });

    const mine = collect(o);
    const theirs = collect(o, {}, o.sibling);
    expect(mine.jobs?.items.map((j) => j.label)).toEqual(['my work']);
    expect(theirs.jobs?.items.map((j) => j.label)).toEqual(['their work']);
    expect(mine.factsBlock).toContain('mine.workers.dev');
    expect(mine.factsBlock).not.toContain('theirs.workers.dev');
    expect(theirs.factsBlock).toContain('theirs.workers.dev');
  });
});

describe('collectDynamicContext', () => {
  test('an empty agent reports empty planes, not absent ones', () => {
    const ctx = collect(setup());
    expect(ctx.jobs).toEqual({ items: [], total: 0 });
    expect(ctx.tasks).toEqual({ items: [], total: 0 });
    expect(ctx.delegates).toEqual({ items: [], total: 0 });
    // Omitted, not rendered empty.
    expect(ctx.factsBlock).toBeUndefined();
    expect(ctx.memoryTail).toBeUndefined();
    expect(ctx.recoveries).toBeUndefined();
    expect(ctx.missingCapabilities).toBeUndefined();
  });

  test('the jobs plane reads the background-job store', () => {
    const o = setup();
    o.stores.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', label: 'ship it', now: 1 });
    expect(collect(o).jobs).toEqual({ items: [{ id: 'j1', kind: 'fork', label: 'ship it' }], total: 1 });
  });

  test('a settled job leaves the plane — it lists running work only', () => {
    const o = setup();
    o.stores.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', now: 1 });
    o.stores.jobs.settle('j1', 0, 'done', 2);
    expect(collect(o).jobs).toEqual({ items: [], total: 0 });
  });

  test('the tasks plane reads the task list, open items only', () => {
    const o = setup();
    o.stores.taskList.add(['Reproduce the 502', 'Patch the timeout'], null, 1);
    o.stores.taskList.update('t1', { status: 'done' }, 2);
    expect(collect(o).tasks?.items.map((t) => t.title)).toEqual(['Patch the timeout']);
  });

  test('the facts plane reads the facts store', () => {
    const o = setup();
    o.stores.facts.upsert('deploy_target', 'workers', {});
    expect(collect(o).factsBlock).toContain('deploy_target');
  });

  test('the two per-turn inputs pass through as given', () => {
    const o = setup();

    const ctx = collect(o, {
      memoryTail: '## Recent\n- shipped the gate',
      missingCapabilities: [{ source: 'github', reason: 'connect failed' }],
    });

    expect(ctx.memoryTail).toBe('## Recent\n- shipped the gate');
    expect(ctx.missingCapabilities).toEqual([{ source: 'github', reason: 'connect failed' }]);
  });

  test('reads fresh on every call — no plane is cached across steps', () => {
    // Called per step: a job registered mid-turn is visible on the next step.
    const o = setup();
    expect(collect(o).jobs).toEqual({ items: [], total: 0 });
    o.stores.jobs.create({ id: 'j1', kind: 'shell', workMode: 'build', now: 1 });
    expect(present(collect(o).jobs, 'the running-jobs block').items).toHaveLength(1);
  });
});

describe('the backend-only planes ride the typed source callbacks', () => {
  test('a backend without them renders nothing and invents no rows', () => {
    // Absence must stay absent, not become an empty roster.
    const ctx = collect(setup());
    expect(ctx.approvals).toBeUndefined();
    expect(ctx.delegates).toEqual({ items: [], total: 0 });
  });

  test('subordinates list ahead of the search roster both backends contribute', () => {
    const o = setup();

    const ctx = collect(o, {
      subordinateDelegates: () => [{
        kind: 'subordinate', name: 'scout', phase: 'working', task: 'map it',
      }],
    });

    expect(ctx.delegates?.items[0]).toEqual({
      kind: 'subordinate', name: 'scout', phase: 'working', task: 'map it',
    });
  });

  test('approvals and backend-provided capability notices pass through per step', () => {
    let parked = 0;
    const o = setup();

    const ctx = collect(o, {
      approvals: () => {
        parked += 1;

        return { items: [{ id: 'cons-1', kind: 'device consent', detail: 'device: git push' }], total: 1 };
      },
      missingCapabilities: [{ source: 'inbox', reason: 'no transport bound' }],
    });

    expect(ctx.approvals).toEqual({
      items: [{ id: 'cons-1', kind: 'device consent', detail: 'device: git push' }],
      total: 1,
    });
    expect(ctx.missingCapabilities).toContainEqual({ source: 'inbox', reason: 'no transport bound' });
    // A callback: re-read per step.
    expect(parked).toBe(1);
    collect(o, {
      approvals: () => {
        parked += 1;

        return { items: [], total: 0 };
      },
    });
    expect(parked).toBe(2);
  });
});
