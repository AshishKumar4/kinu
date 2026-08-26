// collectDynamicContext — the ONE binding of each live per-step plane to the
// store that answers it.
//
// `agentDynamicContext` already owned which planes exist; which store feeds each
// plane was stated once per backend in two eight-field literals. This runs once
// against the shared binding, so a plane wired to the wrong store — or silently
// dropped for one backend — fails here rather than in whichever agent noticed
// its context had gone quiet.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { collectDynamicContext } from '../src/state/dynamic-context';
import { createAgentStores } from '../src/state/agent-stores';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { makeSqlExec } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { AgentStores } from '../src/state/agent-stores';
import type {
  DynamicContext, DynamicApproval, DynamicDelegate, MissingCapability,
  ActiveRoster,
} from '../src/prompting/volatile-context';

interface Fixture {
  readonly rt: AgentRuntime;
  readonly stores: AgentStores;
}

function setup(): Fixture {
  const { rt, testSql } = createTestRuntime();
  initWorkspaceSchema({
    execRaw: testSql.execRaw, sql: testSql.sql, exec: makeSqlExec(testSql.db),
  });
  return { rt, stores: createAgentStores(() => testSql.sql) };
}

interface Overrides {
  readonly memoryTail?: string;
  readonly missingCapabilities?: readonly MissingCapability[];
  /** The backend-only planes, as the source callbacks a backend supplies. */
  readonly subordinateDelegates?: () => readonly DynamicDelegate[];
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
}

function collect(o: Fixture, over: Overrides = {}): DynamicContext {
  return collectDynamicContext({
    rt: o.rt, stores: o.stores,
    memoryTail: over.memoryTail,
    missingCapabilities: over.missingCapabilities ?? [],
    subordinateDelegates: over.subordinateDelegates,
    approvals: over.approvals,
  });
}

describe('collectDynamicContext', () => {
  test('an empty agent reports empty planes, not absent ones', () => {
    const ctx = collect(setup());
    expect(ctx.jobs).toEqual({ items: [], total: 0 });
    expect(ctx.tasks).toEqual({ items: [], total: 0 });
    expect(ctx.delegates).toEqual({ items: [], total: 0 });
    // Omitted rather than rendered empty — the distinction volatile-context owns.
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
    o.stores.taskList.setStatus('t1', 'done', 2);
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
    // Load-bearing: this is called once per model STEP, and a job registered
    // mid-turn has to be visible on the very next one.
    const o = setup();
    expect(collect(o).jobs).toEqual({ items: [], total: 0 });
    o.stores.jobs.create({ id: 'j1', kind: 'run', workMode: 'build', now: 1 });
    expect(collect(o).jobs!.items).toHaveLength(1);
  });
});

describe('the backend-only planes ride the typed source callbacks', () => {
  test('a backend without them renders nothing and invents no rows', () => {
    // The CLI wires no consent registry and no roster store; absence must stay
    // absent, not become an empty roster that reads as "no helpers".
    const ctx = collect(setup());
    expect(ctx.approvals).toBeUndefined();
    expect(ctx.delegates).toEqual({ items: [], total: 0 });
  });

  test('subordinates list ahead of the search roster both backends contribute', () => {
    const { rt, stores } = setup();
    const ctx = collect({ rt, stores }, {
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
    const { rt, stores } = setup();
    const ctx = collect({ rt, stores }, {
      approvals: () => {
        parked += 1;
        return { items: [{ id: 'cons-1', kind: 'device consent', detail: 'laptop: git push' }], total: 1 };
      },
      missingCapabilities: [{ source: 'inbox', reason: 'no transport bound' }],
    });
    expect(ctx.approvals).toEqual({
      items: [{ id: 'cons-1', kind: 'device consent', detail: 'laptop: git push' }],
      total: 1,
    });
    expect(ctx.missingCapabilities).toContainEqual({ source: 'inbox', reason: 'no transport bound' });
    // A callback, not a value: the block is re-read per step, so what the
    // backend's store answers NOW is what renders.
    expect(parked).toBe(1);
    collect({ rt, stores }, {
      approvals: () => {
        parked += 1;
        return { items: [], total: 0 };
      },
    });
    expect(parked).toBe(2);
  });
});
