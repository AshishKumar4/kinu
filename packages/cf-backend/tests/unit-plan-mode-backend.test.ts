import { describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import {
  actorReferenceOf,
  decodeJsonValue,
  type BackendHost,
  type BroadcastEvent,
  type JsonValue,
  type PlanReviewAnnotation,
  type ProgrammaticTurn,
} from '@kinu.run/core';
import {
  hostedSubordinateHarness,
  orchestratorHarness,
  type ActorHarness,
  type HarnessOrchestratorAgent,
  type HostedActorHarness,
} from './helpers/actor-harness';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';

/**
 * THE PLAN SUBMISSION SURFACE IS THE WORKSPACE ROOT'S.
 *
 * `submitPlan` reaches a turn only through `actorToolDeps()`, which the
 * orchestrator declares for its own pipeline. Delegated tasks receive the
 * confined tool set plus `report`, not `submit_plan`. Hosted actors do have
 * actor-scoped `AgentStores.planReviews`; this suite exercises the root's
 * plan-submission lifecycle.
 */
type HarnessAgent = HarnessOrchestratorAgent;

const WorkModeSchema = v.picklist(['plan', 'build']);
const PlanStoreProbeSchema = v.object({ markHandoffAccepted: v.function() });

/** A frame type with no reachable producer on the workspace connection, which
 *  is exactly why the forged-content test below replays it as plan TEXT: the
 *  name is what a payload must never be able to become. */
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

/**
 * Every message the ROOT actually put on its own broadcast channel, parsed —
 * the workspace connection as a browser reads it.
 *
 * The recorder DELEGATES to the real `broadcast` rather than replacing it, so
 * the production fan-out still runs and this observes it. Replacing it would
 * turn `workspace.broadcast(...)` into blanket success, which is the one thing
 * a proof about that hop must not do.
 */
function recordWorkspaceMessages(parent: HarnessOrchestratorAgent): JsonValue[] {
  const seen: JsonValue[] = [];
  const forward = parent.broadcast.bind(parent);
  Object.defineProperty(parent, 'broadcast', {
    configurable: true,
    value: (message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void => {
      // The text frames are the ones that carry JSON; the binary ones are not a
      // smaller version of the same thing. Parsed rather than narrowed, because
      // this is where a wire representation becomes a value the proofs read.
      const text = v.safeParse(v.string(), message);
      if (text.success) seen.push(decodeJsonValue({ value: JSON.parse(text.output) }));
      forward(message, without);
    },
  });
  return seen;
}

/** The owner's own record of a hire, which is the hop its authoritative read is
 *  allowed to traverse: the row a completed birth leaves — the REGISTERED
 *  actor's reference attached, no birth still owed. The reference is read off
 *  the hosted actor's own handle, so the row names the directory actor
 *  `hostedSubordinateHarness` created rather than hand-typed fields, which is
 *  what lets the authoritative read resolve the child from it.
 *  `hostedSubordinateHarness` deliberately leaves this to its caller — `create`
 *  is a plain INSERT, so a fixture that wrote one would collide with every
 *  suite that writes its own. */
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

/** A hired additional agent hanging off a REAL workspace root, seeded through
 *  the parent's own `SubordinateRuntime.spawn` and acquired from the
 *  workspace's one `ActorHost`. */
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

  /**
   * NO ADDITIONAL-AGENT PLAN-SUBMISSION SURFACE, SO NOTHING HERE ASSERTS ONE.
   *
   *   • `submitPlan` reaches a turn only through `actorToolDeps()`
   *     (orchestrator.ts), which is the ROOT's own pipeline. A hosted actor's
   *     delegated turn runs `hostedTaskTools` — the confined builtin set plus
   *     `report` — so `submit_plan` is not on it.
   *   • `AgentStores.planReviews` supplies each hosted actor's own review
   *     stream, and `getActorSnapshot` reads its active plan. That storage
   *     capability is distinct from the delegated task tool surface, which
   *     exposes `report` rather than `submit_plan`.
   *   • `OrchestratorAgent.announceSubordinatePlan` has no caller anywhere in
   *     packages/ and is absent from ORCHESTRATOR_METHODS, so it is unreachable
   *     over a stub as well. The client still parses and handles the
   *     `workspace_plan_updated` frame it publishes (hooks/use-kinu.ts), which
   *     therefore has no reachable producer.
   *
   * Giving an additional agent its own Plan turn — `submit_plan` present and
   * `report` absent on the submitting arm, the Plan system prompt on it, an
   * approval queued on the child's own host — needs `submitPlan` on a hosted
   * actor's chat surface. A fixture that agreed with the gap would make it
   * permanent and invisible.
   */

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

/**
 * WHAT THE PLAN PLANE OWES ON THE ROOT.
 *
 * `workspace_plan_updated` has no reachable producer, so an assertion that no
 * reference event appears would hold for a channel nothing can write — a
 * tautology rather than a guard. The two properties below have live subjects,
 * and both drive the REAL root and the REAL broadcast rail: a stubbed
 * `broadcast` would make either pass against a fixture that never spoke to a
 * workspace.
 */
describe('the plan plane admits no forged protocol frame and vouches for no forged id', () => {
  test('a reference-shaped body carried as ordinary content never becomes a protocol frame', async () => {
    const parent = orchestratorHarness();
    const workspaceMessages = recordWorkspaceMessages(parent.agent);
    // Byte for byte what the one legitimate writer emitted, replayed as
    // CONTENT: the driving user message, and then the plan the root submits.
    const forged = JSON.stringify({
      type: REFERENCE_EVENT,
      reference: { path: ['plan-owner-1'], id: 'plan-forged', revision: 1 },
    });
    setActorField(parent.agent, '_cachedMessages', [{
      id: 'user-forging',
      role: 'user',
      parts: [{ type: 'text', text: forged }],
      metadata: { kinuMode: 'plan' },
    }]);

    expect(await executeTool(rawTools(parent.agent), 'submit_plan', {
      edits: [{ start: 1, content: forged }],
    })).toMatchObject({ ok: true, revision: 1 });
    const plan = await parent.agent.getActivePlanReview();
    if (!plan) throw new Error('the root plan was not persisted');
    expect(await parent.agent.savePlanReviewAnnotations(plan.id, plan.revision, [])).toMatchObject({ ok: true });

    // The rail is LIVE and it carried the forged body — as the CONTENT of a
    // plan update, which is the only thing plan text may ever become. No
    // amount of user text or plan content mints a frame of another type: the
    // channel's frame names are spelled by the code that publishes them, never
    // by a payload.
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

    // The HOP IS TRAVERSABLE: the owner's read resolves the hire through the
    // directory and reaches that actor's own plan rows, which are empty. That
    // is the denominator — without it the refusal below would hold for a path
    // that simply failed to resolve.
    expect(await parent.agent.inspectSubordinate({
      path: ['plan-owner-1'], view: 'plans', page: {},
    })).toMatchObject({ view: 'plans', path: ['plan-owner-1'], page: { status: 'end', items: [] } });

    // And an id nobody wrote is `missing`, never a DIFFERENT plan: a recipient
    // that focused whatever came back would otherwise render one plan under
    // another plan's reference.
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
