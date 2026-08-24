import { describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import {
  decodeJsonValue,
  type BackendHost,
  type BroadcastEvent,
  type JsonObject,
  type JsonValue,
  type PlanReviewAnnotation,
  type ProgrammaticTurn,
} from '@kinu.run/core';
import {
  orchestratorHarness,
  subordinateHarness,
  type HarnessOrchestratorAgent,
  type HarnessSubordinateAgent,
} from './helpers/actor-harness';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';

type HarnessAgent = HarnessOrchestratorAgent | HarnessSubordinateAgent;

const WorkModeSchema = v.picklist(['plan', 'build']);
const PlanStoreProbeSchema = v.object({ markHandoffAccepted: v.function() });

function prototypeMethod(agent: HarnessAgent, name: string) {
  let owner: object | null = agent;
  while (owner) {
    const callable = v.safeParse(
      v.function(),
      Object.getOwnPropertyDescriptor(owner, name)?.value,
    );
    if (callable.success) return callable.output;
    owner = Object.getPrototypeOf(owner);
  }
  throw new Error(`${name} is missing from the actor prototype`);
}

function rawTools(agent: HarnessAgent): ToolSet {
  return agent.observeRawTools();
}

function turnWorkMode(agent: HarnessAgent) {
  return v.parse(WorkModeSchema, prototypeMethod(agent, 'turnWorkMode').call(agent));
}

async function executeTool(
  tools: ToolSet,
  name: string,
  input: JsonValue,
) {
  const entry = tools[name];
  if (!entry) throw new Error(`${name} is not executable`);
  return decodeJsonValue({ value: await toolExecute<JsonValue, JsonValue>(entry)(input) });
}

function setActorField(agent: HarnessAgent, name: string, value: JsonValue | BackendHost): void {
  if (!Reflect.set(agent, name, value)) throw new Error(`failed to set actor field ${name}`);
}

function setMode(agent: HarnessAgent, mode: 'plan' | 'build'): void {
  setActorField(agent, '_cachedMessages', [{
    id: `user-${mode}`,
    role: 'user',
    parts: [{ type: 'text', text: `${mode} this change` }],
    metadata: { kinuMode: mode },
  }]);
}

function setSubordinateTurn(
  agent: HarnessSubordinateAgent,
  mode: 'plan' | 'build',
  programmatic: boolean,
): void {
  const metadata: JsonObject = { kinuMode: mode };
  if (programmatic) metadata.kinuEvent = 'subordinate_task';
  const message = {
    id: `subordinate-${programmatic ? 'assigned' : 'owner'}-${mode}`,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: `${mode} this change` }],
    metadata,
  };
  Object.defineProperty(agent, 'messages', { value: [message], configurable: true });
  setActorField(agent, '_cachedMessages', [message]);
  setActorField(agent, '_activeProgrammaticUserMessage', programmatic ? message : null);
}

describe('Plan mode tool lifecycle', () => {
  test('mechanically refuses a mutating branch while a Plan turn is running', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    setMode(agent, 'plan');
    setActorField(agent, '_inFlight', true);

    await expect(agent.branchTurn('implement this in parallel')).resolves.toEqual({
      accepted: false,
      reason: 'Plan turns cannot start mutating branches. Review or finish the plan first.',
    });
  });

  test('adds submit_plan and mechanically removes release.* without losing ordinary tools', () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    setMode(agent, 'plan');

    const planTools = rawTools(agent);
    expect(Object.keys(planTools)).toEqual(expect.arrayContaining([
      'execute_tools', 'run', 'file', 'agents', 'memory', 'tasks', 'web', 'submit_plan',
    ]));
    expect(planTools.execute_tools?.description).not.toContain('export declare const release:');

    setMode(agent, 'build');
    const buildTools = rawTools(agent);
    expect(buildTools.submit_plan).toBeUndefined();
    expect(buildTools.execute_tools?.description).toContain('export declare const release:');
    expect(buildTools.execute_tools).not.toBe(planTools.execute_tools);

    setMode(agent, 'plan');
    setActorField(agent, '_activeProgrammaticUserMessage', {});
    const unlabelledProgrammaticTools = rawTools(agent);
    expect(unlabelledProgrammaticTools.submit_plan).toBeUndefined();
    expect(unlabelledProgrammaticTools.execute_tools?.description)
      .toContain('export declare const release:');
  });

  test('an owner Plan turn on an additional agent has its own review, while assigned Plan work reports to its parent', async () => {
    const ownerHarness = subordinateHarness();
    const owner = ownerHarness.agent;
    const broadcasts: BroadcastEvent[] = [];
    const queued: ProgrammaticTurn[] = [];
    setActorField(owner, '_host', {
      broadcast: (event) => broadcasts.push(event),
      enqueueTurn: async (turn) => {
        queued.push(turn);
        return { status: 'queued' };
      },
      turnInFlight: () => false,
      setTimer: () => {},
    });
    setSubordinateTurn(owner, 'plan', false);

    const ownerTools = rawTools(owner);
    expect(ownerTools.submit_plan).toBeDefined();
    expect(ownerTools.report).toBeUndefined();
    const ownerTurn = await owner.beforeTurn({
      system: 'base',
      messages: [{ role: 'user', content: 'plan this change' }],
      tools: ownerTools,
      model: 'harness-model',
      continuation: false,
      body: {},
    });
    expect(ownerTurn?.system).toContain('submit a concrete Markdown plan');
    expect(ownerTurn?.system).not.toContain('report concrete findings to the parent Plan turn');

    expect(await executeTool(ownerTools, 'submit_plan', {
      edits: [{ start: 1, content: '# Agent plan\n\nInspect\nChange\nVerify' }],
    })).toMatchObject({ ok: true, revision: 1, status: 'pending' });
    const plan = await owner.getActivePlanReview();
    if (!plan) throw new Error('additional-agent plan was not persisted');
    expect(await owner.savePlanReviewAnnotations(plan.id, plan.revision, [{
      id: 'agent-note',
      blockId: 'paragraph-1',
      startOffset: 0,
      endOffset: 6,
      type: 'COMMENT',
      text: 'Name the verification command',
      originalText: 'Verify',
      createdA: 1,
    }])).toMatchObject({ ok: true, plan: { annotations: [{ id: 'agent-note' }] } });
    expect(await owner.decidePlanReview(plan.id, plan.revision, 'approve')).toMatchObject({
      ok: true,
      queued: true,
      plan: { status: 'approved', handoffAccepted: true },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      metadata: { kinuEvent: 'plan_approved', kinuMode: 'build' },
    });
    expect(broadcasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ status: 'pending' }) }),
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ status: 'approved' }) }),
    ]));

    const assignedHarness = subordinateHarness();
    const assigned = assignedHarness.agent;
    setSubordinateTurn(assigned, 'plan', true);
    const assignedTools = rawTools(assigned);
    expect(assignedTools.submit_plan).toBeUndefined();
    expect(assignedTools.report).toBeDefined();
    const assignedTurn = await assigned.beforeTurn({
      system: 'base',
      messages: [{ role: 'user', content: 'research the delegated task' }],
      tools: assignedTools,
      model: 'harness-model',
      continuation: false,
      body: {},
    });
    expect(assignedTurn?.system).toContain('report concrete findings to the parent Plan turn');
    expect(assignedTurn?.system).not.toContain('submit a concrete Markdown plan');
  });

  test('submit, annotations, feedback, revision, and approval survive through the public RPCs', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const broadcasts: BroadcastEvent[] = [];
    const queued: ProgrammaticTurn[] = [];
    const host: BackendHost = {
      broadcast: (event) => broadcasts.push(event),
      enqueueTurn: async (turn) => {
        const status = v.parse(
          v.object({ status: v.string() }),
          harness.db.query('SELECT status FROM plan_reviews WHERE id = ? AND revision = ?')
            .get(String(turn.metadata?.planId), Number(turn.metadata?.revision)),
        );
        expect(['changes_requested', 'approved']).toContain(status.status);
        queued.push(turn);
        return { status: 'queued' };
      },
      turnInFlight: () => false,
      setTimer: () => {},
    };
    setActorField(agent, '_host', host);
    setMode(agent, 'plan');

    const submitted = await executeTool(rawTools(agent), 'submit_plan', {
      edits: [{ start: 1, content: '# Plan\n\nFirst\nSecond' }],
    });
    expect(submitted).toMatchObject({ ok: true, revision: 1, status: 'pending' });
    const first = await agent.getActivePlanReview();
    if (!first) throw new Error('submitted plan was not persisted');
    expect(first).toMatchObject({ revision: 1, content: '# Plan\n\nFirst\nSecond', status: 'pending' });

    const annotations: PlanReviewAnnotation[] = [
      {
        id: 'annotation-1', blockId: 'paragraph-1', startOffset: 0, endOffset: 6,
        type: 'COMMENT', text: 'Make this measurable', originalText: 'Second', createdA: 1,
      },
    ];
    const annotated = await agent.savePlanReviewAnnotations(first.id, 1, annotations);
    expect(annotated).toMatchObject({ ok: true, plan: { annotations: [{ id: 'annotation-1' }] } });

    const changes = await agent.decidePlanReview(first.id, 1, 'request_changes', 'Replace the last step');
    expect(changes).toMatchObject({ ok: true, queued: true, plan: { status: 'changes_requested' } });
    expect(queued[0]).toMatchObject({
      metadata: { kinuEvent: 'plan_feedback', kinuMode: 'plan', decision: 'request_changes' },
      idempotencyKey: `plan:${first.id}:1:request_changes:1`,
    });
    const changeTurn = queued[0];
    if (!changeTurn) throw new Error('plan feedback turn was not queued');
    expect(changeTurn.text).toContain('Replace the last step');
    expect(changeTurn.text).toContain('4| Second');

    const revised = await executeTool(rawTools(agent), 'submit_plan', {
      edits: [{ start: 4, end: 4, content: 'Second, with tests' }],
    });
    expect(revised).toMatchObject({ ok: true, revision: 2 });
    const current = await agent.getActivePlanReview();
    expect(current).toMatchObject({ revision: 2, content: '# Plan\n\nFirst\nSecond, with tests' });

    const approval = await agent.decidePlanReview(first.id, 2, 'approve');
    expect(approval).toMatchObject({ ok: true, queued: true, plan: { status: 'approved' } });
    expect(queued[1]).toMatchObject({
      metadata: { kinuEvent: 'plan_approved', kinuMode: 'build', decision: 'approve' },
      idempotencyKey: `plan:${first.id}:2:approve:1`,
    });
    const approvalTurn = queued[1];
    if (!approvalTurn) throw new Error('plan approval turn was not queued');
    expect(approvalTurn.text).toContain('Implement the exact approved plan');
    expect(approvalTurn.text).toContain('Second, with tests');

    expect(broadcasts).toHaveLength(7);
    expect(broadcasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ revision: 1 }) }),
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ revision: 2, status: 'approved' }) }),
    ]));
  });

  test('a failed handoff remains retryable and a successful retry cannot enqueue twice', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const attempts: ProgrammaticTurn[] = [];
    const host: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async (turn) => {
        attempts.push(turn);
        if (attempts.length === 1) throw new Error('temporary admission failure');
        return { status: 'queued' };
      },
      turnInFlight: () => false,
      setTimer: () => {},
    };
    setActorField(agent, '_host', host);
    setMode(agent, 'plan');
    await executeTool(rawTools(agent), 'submit_plan', {
      edits: [{ start: 1, content: '# Plan' }],
    });
    const plan = await agent.getActivePlanReview();
    if (!plan) throw new Error('submitted plan was not persisted');

    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true, queued: false, queueError: 'temporary admission failure',
      plan: { status: 'approved', handoffAccepted: false },
    });
    setMode(agent, 'build');
    expect(turnWorkMode(agent)).toBe('plan');
    setActorField(agent, '_activeProgrammaticUserMessage', {
      metadata: { kinuEvent: 'plan_approved', kinuMode: 'build' },
    });
    expect(turnWorkMode(agent)).toBe('build');
    setActorField(agent, '_activeProgrammaticUserMessage', null);
    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true, queued: true, plan: { status: 'approved', handoffAccepted: true },
    });
    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true, queued: true, plan: { handoffAccepted: true },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey);
  });

  test('recovers when durable acceptance outlives the RPC and the accepted turn later errors', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const attempts: ProgrammaticTurn[] = [];
    const host: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async (turn) => {
        attempts.push(turn);
        if (attempts.length === 1) {
          return {
            status: 'queued',
            durable: { submissionId: 'submission-1', accepted: true, status: 'pending' },
          };
        }
        if (attempts.length === 2) {
          return {
            status: 'skipped',
            durable: { submissionId: 'submission-1', accepted: false, status: 'error' },
          };
        }
        return {
          status: 'queued',
          durable: { submissionId: 'submission-2', accepted: true, status: 'pending' },
        };
      },
      turnInFlight: () => false,
      setTimer: () => {},
    };
    setActorField(agent, '_host', host);
    setMode(agent, 'plan');
    await executeTool(rawTools(agent), 'submit_plan', {
      edits: [{ start: 1, content: '# Plan' }],
    });
    const plan = await agent.getActivePlanReview();
    const reviews = Object.getOwnPropertyDescriptor(agent, '_planReviews')?.value;
    if (!v.is(PlanStoreProbeSchema, reviews) || !plan) {
      throw new Error('plan review store was not initialized');
    }
    const markAccepted = reviews.markHandoffAccepted;
    let interruptOnce = true;
    Object.defineProperty(reviews, 'markHandoffAccepted', { value: (id: string, revision: number) => {
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error('actor interrupted after durable acceptance');
      }
      return decodeJsonValue({ value: markAccepted.call(reviews, id, revision) });
    } });

    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true,
      queued: false,
      queueError: 'actor interrupted after durable acceptance',
      plan: { status: 'approved', handoffAccepted: false },
    });
    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true,
      queued: true,
      plan: { status: 'approved', handoffAccepted: true },
    });
    expect(attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
      `plan:${plan.id}:1:approve:1`,
      `plan:${plan.id}:1:approve:1`,
      `plan:${plan.id}:1:approve:2`,
    ]);
  });
});
