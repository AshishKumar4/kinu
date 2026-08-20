// collectDynamicContext — the ONE binding of each live per-step plane to the
// store that answers it.
//
// `agentDynamicContext` already owned which planes exist; which store feeds each
// plane was stated once per backend in two eight-field literals. This runs once
// against the shared binding, so a plane wired to the wrong store — or silently
// dropped for one backend — fails here rather than in whichever agent noticed
// its context had gone quiet.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from '@kinu/test-utils';
import { collectDynamicContext } from '../src/state/dynamic-context';
import { createAgentStores } from '../src/state/agent-stores';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { makeSqlExec } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { AgentStores } from '../src/state/agent-stores';
import type { DynamicContext, MissingCapability } from '../src/prompting/volatile-context';

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
}

function collect(o: Fixture, over: Overrides = {}): DynamicContext {
  return collectDynamicContext({
    rt: o.rt, stores: o.stores,
    memoryTail: over.memoryTail,
    missingCapabilities: over.missingCapabilities ?? [],
  });
}

describe('collectDynamicContext', () => {
  test('an empty agent reports empty planes, not absent ones', () => {
    const ctx = collect(setup());
    expect(ctx.jobs).toEqual([]);
    expect(ctx.tasks).toEqual([]);
    expect(ctx.delegates).toEqual([]);
    // Omitted rather than rendered empty — the distinction volatile-context owns.
    expect(ctx.factsBlock).toBeUndefined();
    expect(ctx.memoryTail).toBeUndefined();
    expect(ctx.recoveries).toBeUndefined();
    expect(ctx.missingCapabilities).toBeUndefined();
  });

  test('the jobs plane reads the background-job store', () => {
    const o = setup();
    o.stores.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', label: 'ship it', now: 1 });
    expect(collect(o).jobs).toEqual([{ id: 'j1', kind: 'fork', label: 'ship it' }]);
  });

  test('a settled job leaves the plane — it lists running work only', () => {
    const o = setup();
    o.stores.jobs.create({ id: 'j1', kind: 'fork', workMode: 'build', now: 1 });
    o.stores.jobs.settle('j1', 0, 'done', 2);
    expect(collect(o).jobs).toEqual([]);
  });

  test('the tasks plane reads the task list, open items only', () => {
    const o = setup();
    o.stores.taskList.add(['Reproduce the 502', 'Patch the timeout'], null, 1);
    o.stores.taskList.setStatus('t1', 'done', 2);
    expect(collect(o).tasks?.map((t) => t.title)).toEqual(['Patch the timeout']);
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
    expect(collect(o).jobs).toEqual([]);
    o.stores.jobs.create({ id: 'j1', kind: 'run', workMode: 'build', now: 1 });
    expect(collect(o).jobs).toHaveLength(1);
  });
});
