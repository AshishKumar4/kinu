import { expect, test } from 'bun:test';
import { createTestRuntime } from '../../core/tests/helpers';
import { PlanReviewStore, TaskListStore, withTaskPlan, bindTaskPlan, initPlanReviewTable, createAgentConfigStore } from '@kinu.run/core';
import { createTasksDispatcher } from '../../core/src/tools/tasks-tool';
import { createTasksCodemodeProvider } from '../../core/src/tools/tasks-codemode';
import { approvedTaskPlan } from '@kinu.run/core';
import { jsonSchema, tool } from 'ai';

function fixture() {
  const { rt, db } = createTestRuntime();
  initPlanReviewTable(rt.storage.execRaw);
  let nextId = 0;
  const plans = new PlanReviewStore(rt.storage.sql, { newId: () => `plan-test-${++nextId}`, now: () => 100 });
  const first = plans.submit('default', [{ start: 1, content: '# Approved work' }]);
  if (!first.ok) throw new Error(first.error);
  const decided = plans.decide(first.plan.id, first.plan.revision, 'approve');
  if (!decided.ok) throw new Error(decided.error);
  db.exec('CREATE TABLE cf_think_submissions(idempotency_key TEXT, metadata_json TEXT, messages_json TEXT, status TEXT)');
  const handoff = { kinuEvent: 'plan_approved', planId: decided.plan.id, revision: decided.plan.revision, decision: 'approve' };
  const admit = (message: string, metadata = handoff) => db.query('INSERT INTO cf_think_submissions VALUES(?,?,?,?)').run(`plan:${metadata.planId}:${metadata.revision}:approve:0`, JSON.stringify(metadata), JSON.stringify([{ id: message }]), 'running');
  return { rt, db, plans, handoff, admit, taskList: new TaskListStore(rt.storage.sql) };
}

test('new native and codemode tasks retain the approved revision across asynchronous calls; other actors and old tasks stay unlinked', async () => {
  const f = fixture(); const other = fixture();
  try {
    f.taskList.add(['old standalone'], null, 1);
    expect(approvedTaskPlan(f.rt.storage.sql, 'forged')).toBeNull();
    f.admit('approved-message');
    const plan = approvedTaskPlan(f.rt.storage.sql, 'approved-message');
    if (!plan) throw new Error('approved handoff missing');
    const native = createTasksDispatcher(f.taskList, createAgentConfigStore(f.rt.storage.sql));
    const codemode = createTasksCodemodeProvider(f.taskList, createAgentConfigStore(f.rt.storage.sql));
    let resumed: (() => Promise<void>) | undefined;
    const entry = withTaskPlan({ tasks: tool({ inputSchema: jsonSchema<object>({ type: 'object' }), execute: async () => {
      native({ action: 'add', titles: ['native task'] });
      resumed = bindTaskPlan(async () => { await codemode.tools.add.execute(['codemode task']); });
      other.taskList.add(['other actor'], null, 2);
      return 'done';
    } }) }, [f.rt.storage.sql], plan, write => f.db.transaction(write)());
    await entry.tasks.execute?.({}, { toolCallId: 'tasks', messages: [] });
    await resumed?.();
    const linked = f.taskList.listForPlan(plan);
    expect(linked.map(item => item.title)).toEqual(['native task', 'codemode task']);
    expect(other.taskList.listForPlan(plan)).toEqual([]);
    const first = linked[0]; if (!first) throw new Error('missing native task');
    f.taskList.setStatus(first.id, 'done', 3);
    expect(f.taskList.listForPlan(plan)[0]?.status).toBe('done');
    expect(f.taskList.list().map(item => item.title)).toContain('old standalone');
  } finally { f.db.close(); other.db.close(); }
});

test('unapproved or foreign-session handoffs cannot attribute tasks and new approval does not rewrite earlier links', async () => {
  const f = fixture();
  try {
    f.admit('first'); const first = approvedTaskPlan(f.rt.storage.sql, 'first'); if (!first) throw new Error('missing approval');
    const add = (plan: typeof first, title: string) => withTaskPlan({ add: tool({ inputSchema: jsonSchema<object>({ type: 'object' }), execute: () => f.taskList.add([title], null, 2) }) }, [f.rt.storage.sql], plan, write => f.db.transaction(write)()).add.execute?.({}, { toolCallId: title, messages: [] });
    await add(first, 'first revision');
    const next = f.plans.submit('default', [{ start: 1, end: 1, content: '# Revised work' }]); if (!next.ok) throw new Error(next.error);
    f.admit('pending', { ...f.handoff, planId: next.plan.id, revision: next.plan.revision });
    expect(approvedTaskPlan(f.rt.storage.sql, 'pending')).toBeNull();
    f.plans.decide(next.plan.id, next.plan.revision, 'approve');
    const second = approvedTaskPlan(f.rt.storage.sql, 'pending'); if (!second) throw new Error('second approval missing');
    await add(second, 'second revision');
    expect(f.taskList.listForPlan(first).map(item => item.title)).toEqual(['first revision']);
    expect(f.taskList.listForPlan(second).map(item => item.title)).toEqual(['second revision']);
    f.db.query('UPDATE plan_reviews SET session_id=? WHERE revision=?').run('foreign', second.revision);
    expect(approvedTaskPlan(f.rt.storage.sql, 'pending')).toBeNull();
  } finally { f.db.close(); }
});


test('task and provenance commit together, and subtasks keep their parent association outside a later plan', async () => {
  const f = fixture();
  try {
    f.admit('approval');
    const plan = approvedTaskPlan(f.rt.storage.sql, 'approval'); if (!plan) throw new Error('missing approval');
    const entry = withTaskPlan({ add: tool({ inputSchema: jsonSchema<object>({ type: 'object' }), execute: () => f.taskList.add(['parent'], null, 3) }) }, [f.rt.storage.sql], plan, write => f.db.transaction(write)());
    f.db.exec("CREATE TRIGGER refuse_link BEFORE INSERT ON plan_task_links BEGIN SELECT RAISE(ABORT, 'link refused'); END");
    await expect(Promise.resolve().then(() => entry.add.execute?.({}, { toolCallId: 'failed', messages: [] }))).rejects.toThrow('link refused');
    expect(f.taskList.list()).toEqual([]);
    f.db.exec('DROP TRIGGER refuse_link');
    await entry.add.execute?.({}, { toolCallId: 'parent', messages: [] });
    const parent = f.taskList.listForPlan(plan)[0]; if (!parent) throw new Error('parent missing');
    f.taskList.add(['subtask'], parent.id, 4);
    expect(f.taskList.listForPlan(plan)[0]?.subtasks.map(task => task.title)).toEqual(['subtask']);
  } finally { f.db.close(); }
});
