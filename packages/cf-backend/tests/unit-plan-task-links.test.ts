import { expect, test } from 'bun:test';
import { createTestRuntime } from '../../core/tests/helpers';
import { PlanReviewStore, TaskListStore, withTaskPlan, bindTaskPlan, initPlanReviewTable } from '@kinu.run/core';
import { readPlanTasks } from '../../core/src/tasks/store';
import { createTasksDispatcher } from '../../core/src/tools/tasks-tool';
import { createTasksCodemodeProvider } from '../../core/src/tools/tasks-codemode';
import { jsonSchema, tool } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { orchestratorHarness } from './helpers/actor-harness';
import { createSandboxedExecutor } from '../../cli-backend/src/executor';

function fixture() {
  const { rt, db } = createTestRuntime();
  initPlanReviewTable(rt.storage.execRaw);
  const plans = new PlanReviewStore(rt.storage.sql, rt.actor);
  const first = plans.submit('default', [{ start: 1, content: '# Approved work' }]);

  if (!first.ok) throw new Error(first.error);
  const decided = plans.decide(first.plan.id, first.plan.revision, 'approve');

  if (!decided.ok) throw new Error(decided.error);

  return { rt, db, plans, plan: decided.plan, taskList: new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync) };
}

test('native and asynchronous codemode tasks retain their approved revision without attributing other actors or old tasks', async () => {
  const f = fixture(); const other = fixture();

  try {
    f.taskList.add(['old standalone'], null, 1);
    const native = createTasksDispatcher(f.taskList, f.rt.actor.config);
    const codemode = createTasksCodemodeProvider(f.taskList, f.rt.actor.config);
    let resumed: (() => Promise<void>) | undefined;

    const entry = withTaskPlan({ tasks: tool({ inputSchema: jsonSchema<object>({ type: 'object' }), execute: async () => {
      native({ action: 'add', titles: ['native task'] });
      resumed = bindTaskPlan(async () => { await codemode.tools.add.execute(['codemode task']); });
      other.taskList.add(['other actor'], null, 2);

      return 'done';
    } }) }, { sql: [f.rt.storage.sql], plan: f.plan });

    await entry.tasks.execute?.({}, { toolCallId: 'tasks', messages: [] });
    await resumed?.();
    const linked = readPlanTasks(f.rt.storage.sql, f.rt.actor, f.plan);
    expect(linked.map(item => item.title)).toEqual(['native task', 'codemode task']);
    expect(readPlanTasks(other.rt.storage.sql, other.rt.actor, f.plan)).toEqual([]);
    const first = linked[0];

    if (!first) throw new Error('missing native task');
    f.taskList.setStatus(first.id, 'done', 3);
    expect(readPlanTasks(f.rt.storage.sql, f.rt.actor, f.plan)[0]?.status).toBe('done');
    const next = f.plans.submit('default', [{ start: 1, end: 1, content: '# Different work' }]);

    if (!next.ok) throw new Error(next.error);
    expect(readPlanTasks(f.rt.storage.sql, f.rt.actor, next.plan)).toEqual([]);
    expect(readPlanTasks(f.rt.storage.sql, f.rt.actor, f.plan).map(item => item.title)).toEqual(['native task', 'codemode task']);
    expect(f.taskList.list().map(item => item.title)).toContain('old standalone');
  } finally { f.db.close(); other.db.close(); }
});

test('task/link writes roll back together INCLUDING parent inheritance outside a turn scope', async () => {
  const f = fixture();

  try {
    const entry = withTaskPlan({ add: tool({ inputSchema: jsonSchema<object>({ type: 'object' }), execute: () => f.taskList.add(['parent'], null, 3) }) }, { sql: [f.rt.storage.sql], plan: f.plan });
    const refuse = () => f.db.exec("CREATE TRIGGER refuse_link BEFORE INSERT ON plan_task_links BEGIN SELECT RAISE(ABORT, 'link refused'); END");
    refuse();
    await expect(Promise.resolve().then(() => entry.add.execute?.({}, { toolCallId: 'failed', messages: [] }))).rejects.toThrow('link refused');
    expect(f.taskList.list()).toEqual([]);
    f.db.exec('DROP TRIGGER refuse_link');
    await entry.add.execute?.({}, { toolCallId: 'parent', messages: [] });
    const parent = readPlanTasks(f.rt.storage.sql, f.rt.actor, f.plan)[0];

    if (!parent) throw new Error('parent missing');
    refuse();
    expect(() => f.taskList.add(['orphan'], parent.id, 4)).toThrow('link refused');
    expect(f.taskList.list().map(task => [task.title, task.subtasks])).toEqual([['parent', []]]);
    f.db.exec('DROP TRIGGER refuse_link');
    f.taskList.add(['subtask'], parent.id, 5);
    expect(readPlanTasks(f.rt.storage.sql, f.rt.actor, f.plan)[0]?.subtasks.map(task => task.title)).toEqual(['subtask']);
  } finally { f.db.close(); }
});

test('actual owner approval admits the real Think program and attributes its native host tasks', async () => {
  const { agent, db } = orchestratorHarness();
  agent.modelFactory = () => scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text: 'unused default inference' }], finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });
  await agent.onStart();
  const rt = agent.observeRuntime();
  rt.executor = createSandboxedExecutor();
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  const source = "async function run() { await host.callTool(\"tasks\", { action: \"add\", titles: [\"host task\"] }); }";
  await files.writeFile(rt.identity.scaffold.path, source);
  await files.writeFile(rt.identity.scaffold.path + '.v1', source);
  db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'")
    .run(rt.actor.actorId);
  db.query("INSERT INTO scaffold_versions(actor_id,version,written_at,rationale,status) VALUES(?,1,1,'plan scope regression','current')")
    .run(rt.actor.actorId);
  const plans = new PlanReviewStore(rt.storage.sql, rt.actor);
  const submitted = plans.submit('default', [{ start: 1, content: '# Implement the two tasks' }]);

  if (!submitted.ok) throw new Error(submitted.error);

  const planTasks = async () => {
    const result = await agent.inspectSubordinate({ path: [], view: 'planTasks', id: submitted.plan.id, revision: submitted.plan.revision });

    if (result.view !== 'planTasks') throw new Error('Owner plan progress was unavailable');

    return result.tasks;
  };

  const approval = await agent.decidePlanReview(submitted.plan.id, submitted.plan.revision, 'approve');
  expect(approval).toMatchObject({ ok: true, queued: true });
  // The Bun harness records alarms; invoke the SAME public callback the real scheduled alarm calls.
  await agent._drainThinkSubmissions();
  expect((await planTasks()).map(task => task.title)).toEqual(['host task']);
  await agent.runTurn({ input: 'This unrelated turn is not an approved-plan submission.' });
  expect((await planTasks()).map(task => task.id)).toEqual(['t1']);
  expect((await agent.listAgentTasks()).map(task => task.id)).toEqual(['t1', 't2']);
  const metadata = { kinuEvent: 'plan_approved', planId: submitted.plan.id, revision: submitted.plan.revision, decision: 'approve' };
  await agent.submitMessages([{ id: 'unkeyed-approval-metadata', role: 'user', parts: [{ type: 'text', text: 'Metadata is not approval authority.' }], metadata }], { metadata });
  await agent._drainThinkSubmissions();
  expect((await agent.listAgentTasks()).map(task => task.id)).toEqual(['t1', 't2', 't3']);
  const page = await agent.inspectSubordinate({ path: [], view: 'plans', page: { limit: 1 } });
  expect(page).toMatchObject({ view: 'plans', page: { status: 'end', items: [{ id: submitted.plan.id }] } });
  const progress = await agent.inspectSubordinate({ path: [], view: 'planTasks', id: submitted.plan.id, revision: submitted.plan.revision });
  expect(progress).toMatchObject({ view: 'planTasks', tasks: [{ id: 't1' }] });
  const foreign = plans.submit('foreign', [{ start: 1, content: '# Foreign session' }]);

  if (!foreign.ok) throw new Error(foreign.error);
  expect(await agent.inspectSubordinate({ path: [], view: 'planTasks', id: foreign.plan.id, revision: foreign.plan.revision })).toMatchObject({ view: 'missing' });
  expect((await planTasks()).map(task => task.id)).toEqual(['t1']);
}, 15000);
