import { describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import {
  actorReferenceOf,
  decodeJsonValue,
  type JsonValue,
  type PlanReviewAnnotation,
  PlanReviewStore,
  type ProgrammaticTurn,
} from '@kinu.run/core';
import {
  hostedSubordinateHarness,
  orchestratorHarness,
  chatSessionTurns,
  type ActorHarness,
  type HarnessOrchestratorAgent,
  type HostedActorHarness,
} from './helpers/actor-harness';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';

/** Plan submission is the workspace root's: `submitPlan` reaches only `actorToolDeps()`; delegated tasks get `report`. */
type HarnessAgent = HarnessOrchestratorAgent;

const WorkModeSchema = v.picklist(['plan', 'build']);

/** A frame type with no reachable producer; the forged-content test replays it as plan text. */
const REFERENCE_EVENT = 'workspace_plan_updated';

const PlanUpdateSchema = v.object({ type: v.literal('plan_updated') });

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

async function codemodeTool(
  tools: ToolSet,
  name: string,
  input: JsonValue,
) {
  const entry = tools[name];

  if (!entry) throw new Error(`${name} is not executable`);

  return decodeJsonValue({ value: await toolExecute<JsonValue, JsonValue>(entry)(input) });
}

function planStatus(harness: ActorHarness<HarnessOrchestratorAgent>, id: string, revision: number): string {
  return v.parse(
    v.object({ status: v.string() }),
    harness.db.query('SELECT status FROM plan_reviews WHERE id = ? AND revision = ?').get(id, revision),
  ).status;
}

/** The mode rides the driving message, which is where production reads it. */
function setMode(agent: HarnessAgent, mode: 'plan' | 'build'): void {
  agent.harnessDrivingUserMessage(`${mode} this change`, { kinuMode: mode });
}

function recordAdmissions(agent: HarnessAgent): ProgrammaticTurn[] {
  agent.harnessScriptAdmissions([]);

  return agent.harnessAdmissionsAsked;
}

/** Records the root's broadcast frames while delegating to the real `broadcast`, so fan-out still runs. */
function recordWorkspaceMessages(parent: HarnessOrchestratorAgent): JsonValue[] {
  const seen: JsonValue[] = [];
  const forward = parent.broadcast.bind(parent);
  Object.defineProperty(parent, 'broadcast', {
    configurable: true,
    value: (message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void => {
      const text = v.safeParse(v.string(), message);

      if (text.success) seen.push(decodeJsonValue({ value: JSON.parse(text.output) }));
      forward(message, without);
    },
  });

  return seen;
}

/** The owner's completed-birth roster row for a hire; `hostedSubordinateHarness` leaves it to the
 *  caller because `create` is a plain INSERT. */
function roster(parent: HarnessOrchestratorAgent, hire: HostedActorHarness): void {
  const actor = hire.actor.handle;
  parent.harnessRoster().create({
    name: hire.actor.record.name,
    actorReference: actorReferenceOf(actor),
    birth: null,
    deleteRequested: false,
    createdBy: 'user',
    status: 'idle',
    currentTask: null,
    createdAt: 1,
    dismissedAt: null,
    lifetime: 'durable',
    taskEventId: null,
  });
}

async function hiredPlanner(
  parent: ActorHarness<HarnessOrchestratorAgent>,
  name: string,
): Promise<HostedActorHarness> {
  return await hostedSubordinateHarness(parent, {
    name,
    displayName: 'Plan Owner',
    nameOrigin: 'user',
    mission: 'own the plan its owner reads',
  });
}

describe('Plan mode tool lifecycle', () => {
  test('mechanically refuses a mutating branch while a Plan turn is running', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    setMode(agent, 'plan');
    const turns = chatSessionTurns(agent);
    await turns.prepare({ messages: [{ role: 'user', content: 'plan this change' }] });

    await expect(agent.branchTurn('implement this in parallel')).resolves.toEqual({
      accepted: false,
      reason: 'Plan turns cannot start mutating branches. Review or finish the plan first.',
    });
    await turns.settle({ messageId: 'a-plan', text: 'planned' });
  });

  /**
   * Defends: a second-turn Plan press offered the previous turn's build tools. Measured against the
   * live product on 2026-09-18: the provider got `tools=eval,shell,file,memory,tasks,web,agents`, no `submit_plan`.
   */
  test('offers submit_plan on a Plan turn that follows another turn', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const turns = chatSessionTurns(agent);

    setMode(agent, 'build');
    await turns.prepare({ messages: [{ role: 'user', content: 'build this change' }] });
    await turns.settle({ messageId: 'a-build', text: 'built' });

    setMode(agent, 'plan');
    const planned = await turns.prepare({ messages: [{ role: 'user', content: 'plan this change' }] });

    expect(planned.activeTools).toContain('submit_plan');
    expect(Object.keys(planned.tools)).toContain('submit_plan');
    await turns.settle({ messageId: 'a-plan', text: 'planned' });
  });

  test('adds submit_plan and mechanically removes release.* without losing ordinary tools', () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    setMode(agent, 'plan');

    const planTools = rawTools(agent);
    expect(Object.keys(planTools)).toEqual(expect.arrayContaining([
      'eval', 'shell', 'file', 'agents', 'memory', 'tasks', 'web', 'submit_plan',
    ]));
    expect(planTools.eval?.description).not.toContain('export declare const release:');

    setMode(agent, 'build');
    const buildTools = rawTools(agent);
    expect(buildTools.submit_plan).toBeUndefined();
    expect(buildTools.eval?.description).toContain('export declare const release:');
    expect(buildTools.eval).not.toBe(planTools.eval);

    // A programmatic turn with no mode of its own runs in build.
    agent.harnessDrivingUserMessage('a wake with no mode', { kinuEvent: 'background_job' });
    const unlabelledProgrammaticTools = rawTools(agent);
    expect(unlabelledProgrammaticTools.submit_plan).toBeUndefined();
    expect(unlabelledProgrammaticTools.eval?.description)
      .toContain('export declare const release:');
  });

  // No additional-agent Plan surface exists (`submitPlan` is root-only; `announceSubordinatePlan` has no
  // caller), so nothing here asserts one.

  test('submit, annotations, feedback, revision, and approval survive through the public RPCs', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const broadcasts: Array<{ type: string; plan?: { revision: number; status: string } }> = [];
    Reflect.set(agent, 'broadcast', (payload: string) => {
      broadcasts.push(v.parse(v.looseObject({ type: v.string(), plan: v.optional(v.looseObject({ revision: v.number(), status: v.string() })) }), JSON.parse(payload)));
    });
    const queued = recordAdmissions(agent);
    setMode(agent, 'plan');

    const submitted = await codemodeTool(rawTools(agent), 'submit_plan', {
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
    expect(planStatus(harness, first.id, 1)).toBe('changes_requested');
    const changeTurn = queued[0];

    if (!changeTurn) throw new Error('plan feedback turn was not queued');
    expect(changeTurn.text).toContain('Replace the last step');
    expect(changeTurn.text).toContain('4| Second');

    const revised = await codemodeTool(rawTools(agent), 'submit_plan', {
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
    expect(planStatus(harness, first.id, 2)).toBe('approved');
    const approvalTurn = queued[1];

    if (!approvalTurn) throw new Error('plan approval turn was not queued');
    expect(approvalTurn.text).toContain('Implement the exact approved plan');
    expect(approvalTurn.text).toContain('Second, with tests');

    // Plane frames: submit, annotate, request changes, handoff accepted, revise, approve, handoff accepted.
    const planFrames = broadcasts.filter((frame) => frame.type === 'plan_updated');
    expect(planFrames).toHaveLength(7);
    expect(planFrames).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ revision: 1 }) }),
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ revision: 2, status: 'approved' }) }),
    ]));
  });

  test('a failed handoff remains retryable and a successful retry cannot enqueue twice', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    agent.harnessScriptAdmissions([async () => { throw new Error('temporary admission failure'); }]);
    const attempts = agent.harnessAdmissionsAsked;
    setMode(agent, 'plan');
    await codemodeTool(rawTools(agent), 'submit_plan', {
      edits: [{ start: 1, content: '# Plan' }],
    });
    const plan = await agent.getActivePlanReview();

    if (!plan) throw new Error('submitted plan was not persisted');

    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true, queued: false, queueError: 'temporary admission failure',
      plan: { status: 'approved', handoffAccepted: false },
    });
    // The mode is the next turn's driving message, not the approval's handoff.
    expect(turnWorkMode(agent)).toBe('plan');
    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true, queued: true, plan: { status: 'approved', handoffAccepted: true },
    });
    expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
      ok: true, queued: true, plan: { handoffAccepted: true },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey);
  });

  test('recovers when acceptance outlives the RPC: the retried decision admits no second turn', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const attempts = recordAdmissions(agent);
    setMode(agent, 'plan');
    await codemodeTool(rawTools(agent), 'submit_plan', {
      edits: [{ start: 1, content: '# Plan' }],
    });
    const plan = await agent.getActivePlanReview();

    if (!plan) throw new Error('plan review was not created');
    const reviews = agent.harnessPlanReviews;
    const markAccepted = (id: string, revision: number) => PlanReviewStore.prototype.markHandoffAccepted.call(reviews, id, revision);
    let interruptOnce = true;
    Object.defineProperty(reviews, 'markHandoffAccepted', { value: (id: string, revision: number) => {
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error('actor interrupted after durable acceptance');
      }

      return markAccepted(id, revision);
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
    // Asked twice under one key; the loop ran the turn once.
    expect(attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
      `plan:${plan.id}:1:approve:1`,
      `plan:${plan.id}:1:approve:1`,
    ]);
    expect((await agent.listRuns()).items).toHaveLength(1);
  });
});

/** `workspace_plan_updated` has no producer, so these drive the real root and broadcast rail instead. */
describe('the plan plane admits no forged protocol frame and vouches for no forged id', () => {
  test('a reference-shaped body carried as ordinary content never becomes a protocol frame', async () => {
    const parent = orchestratorHarness();
    const workspaceMessages = recordWorkspaceMessages(parent.agent);

    const forged = JSON.stringify({
      type: REFERENCE_EVENT,
      reference: { path: ['plan-owner-1'], id: 'plan-forged', revision: 1 },
    });

    parent.agent.harnessDrivingUserMessage(forged, { kinuMode: 'plan' });

    expect(await codemodeTool(rawTools(parent.agent), 'submit_plan', {
      edits: [{ start: 1, content: forged }],
    })).toMatchObject({ ok: true, revision: 1 });
    const plan = await parent.agent.getActivePlanReview();

    if (!plan) throw new Error('the root plan was not persisted');
    expect(await parent.agent.savePlanReviewAnnotations(plan.id, plan.revision, [])).toMatchObject({ ok: true });

    // The forged body appears only as plan-update content; frame types are never spelled by a payload.
    const updates = workspaceMessages.filter((message) => v.is(PlanUpdateSchema, message));
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan_updated', plan: expect.objectContaining({ content: forged }) }),
    ]));
    expect(workspaceMessages.filter((message) => !v.is(PlanUpdateSchema, message))).toEqual([]);
  });

  test('the authoritative read reaches a real hire and still refuses an id it never wrote', async () => {
    const parent = orchestratorHarness();
    const child = await hiredPlanner(parent, 'plan-owner-1');
    roster(parent.agent, child);

    // Denominator: the hop resolves, so the refusal below is not a failed resolve.
    expect(await parent.agent.inspectSubordinate({
      path: ['plan-owner-1'], view: 'plans', page: {},
    })).toMatchObject({ view: 'plans', path: ['plan-owner-1'], page: { status: 'end', items: [] } });

    // An unwritten id is `missing`, never a different plan.
    for (const reference of [
      { path: ['plan-owner-1'], id: 'plan-forged', revision: 1 },
      { path: ['plan-owner-1'], id: 'plan-forged', revision: 2 },
      { path: ['never-hired'], id: 'plan-forged', revision: 1 },
    ]) {
      expect(await parent.agent.inspectSubordinate({ ...reference, view: 'plan' }))
        .toMatchObject({ view: 'missing', reason: 'missing', path: reference.path });
    }
  });
});
