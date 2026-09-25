// Plan review on the local backend: `submit_plan`, the `plan_updated` fan-out, the stored review,
// and a build turn waiting for the owner's verdict. Asserted only through the session's public surface.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath, scriptedTurnModel } from '@kinu.run/test-utils';
import { CHAT_SESSION_ID, initWorkspaceSchema, type JsonObject, type LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const PLAN_BODY = '# Migration plan\n- move the ledger to integer cents';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

type Step =
  | { readonly call: string; readonly input: JsonObject }
  | { readonly answer: string };

/** Replays `steps` one per request, then answers, so an extra request ends the turn instead of re-running a tool. */
function scriptedSteps(steps: readonly Step[]) {
  const taken: Step[] = [];

  const model = scriptedTurnModel({ doGenerate: () => {
    const step = steps[taken.length] ?? { answer: 'nothing left to do' };
    taken.push(step);

    if ('answer' in step) {
      return {
        content: [{ type: 'text' as const, text: step.answer }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE, warnings: [],
      };
    }

    return {
      content: [{
        type: 'tool-call' as const,
        toolCallId: `call-${String(taken.length)}`,
        toolName: step.call,
        input: JSON.stringify(step.input),
      }],
      finishReason: { unified: 'tool-calls' as const, raw: undefined },
      usage: USAGE, warnings: [],
    };
  } });

  return { model, taken };
}

function session(steps: readonly Step[]) {
  const db = new Database(scratchPath('local-plan-review', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
  const events: SessionEvent[] = [];
  const { model, taken } = scriptedSteps(steps);

  const agent = new LocalAgentSession({
    rt, db, model, noAutoEvolve: true, onEvent: (event) => events.push(event),
  });

  return { db, rt, agent, events, taken };
}

function planBroadcasts(events: readonly SessionEvent[]) {
  return events.flatMap((event) => event.type === 'broadcast' && event.event.type === 'plan_updated'
    ? [event.event]
    : []);
}

function turnModes(agent: LocalAgentSession): string[] {
  return agent.listRuns().items
    .map((run) => run.runId)
    .reverse()
    .flatMap((runId) => agent.getRunEvents(runId)
      .flatMap((event) => event.type === 'turn_end' && event.workMode !== undefined ? [event.workMode] : []));
}

function fileResults(events: readonly SessionEvent[]) {
  return events.filter((event) => event.type === 'tool-result' && event.toolName === 'file');
}

describe('LocalAgentSession — plan review', () => {
  test('a submitted plan is stored, broadcast, holds the next build turn, and releases it on approval', async () => {
    const write = { action: 'write', path: '/home/main/ledger.txt', content: 'integer cents' };

    const { db, agent, events, taken } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
      // Typed as ordinary work but held in Plan until the verdict, so this write is refused.
      { call: 'file', input: write },
      { answer: 'I cannot implement before the plan is decided.' },
      // The handoff turn an approval queues: the same write, now authorized.
      { call: 'file', input: write },
      { answer: 'Implemented the approved plan.' },
    ]);

    try {
      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });

      expect(taken[0]).toEqual({ call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } });
      const submitted = events.find((event) => event.type === 'tool-result' && event.toolName === 'submit_plan');
      expect(submitted).toMatchObject({ success: true });

      const active = await agent.getActivePlanReview();
      expect(active).toMatchObject({
        sessionId: CHAT_SESSION_ID, revision: 1, status: 'pending', content: PLAN_BODY, handoffAccepted: false,
      });

      expect(planBroadcasts(events).map((event) => event.plan?.content)).toEqual([PLAN_BODY]);

      await agent.send('Implement it now.', { id: crypto.randomUUID() });
      expect(fileResults(events)).toMatchObject([{ success: false, reason: 'denied' }]);
      expect(turnModes(agent)).toEqual(['plan', 'plan']);

      const planId = active?.id;

      if (planId === undefined) throw new Error('the submitted plan has no id');
      const decided = await agent.decidePlanReview(planId, 1, 'approve');
      expect(decided).toMatchObject({ ok: true, queued: true, plan: { status: 'approved', handoffAccepted: true } });
      // The decision answers after the loop ran the admitted handoff turn.
      expect(fileResults(events)).toMatchObject([{ success: false, reason: 'denied' }, { success: true }]);
      expect(turnModes(agent)).toEqual(['plan', 'plan', 'build']);
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('a change request hands the numbered plan back and the revision supersedes it', async () => {
    const { db, agent, events, taken } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
      { call: 'submit_plan', input: { edits: [{ start: 2, end: 2, content: '- keep the audit trail' }] } },
      { answer: 'Revised.' },
    ]);

    try {
      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
      const first = await agent.getActivePlanReview();

      if (!first) throw new Error('the submitted plan was not stored');
      const decided = await agent.decidePlanReview(first.id, 1, 'request_changes', 'Say what happens to the audit trail.');
      expect(decided).toMatchObject({ ok: true, queued: true });
      await agent.settleBackgroundWork();

      // The feedback turn carried the numbered plan, so the edit could name pre-edit lines.
      const handoff = taken[2];

      if (handoff === undefined || !('call' in handoff)) throw new Error('the feedback turn ran no submit_plan');
      const revised = await agent.getActivePlanReview();
      expect(revised).toMatchObject({
        id: first.id, revision: 2, status: 'pending',
        content: '# Migration plan\n- keep the audit trail',
      });

      // Repeats collapsed: the state sequence is the contract.
      const seen = planBroadcasts(events).map((event) => `${String(event.plan?.revision)}:${String(event.plan?.status)}`);
      expect(seen.filter((state, index) => state !== seen[index - 1])).toEqual([
        '1:pending', '1:changes_requested', '2:pending',
      ]);
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('a build turn with no plan pending keeps its build authority', async () => {
    const { db, agent, events } = session([
      { call: 'file', input: { action: 'write', path: '/home/main/plain.txt', content: 'no plan here' } },
      { answer: 'Done.' },
    ]);

    try {
      await agent.send('Write the file.', { id: crypto.randomUUID() });
      expect(fileResults(events)).toMatchObject([{ success: true }]);
      expect(turnModes(agent)).toEqual(['build']);
      expect(await agent.getActivePlanReview()).toBeNull();
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('an actor that answers to a parent has no review surface at all', async () => {
    const { db, agent, events } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
    ]);

    // A subordinate reports to whoever hired it, so a plan has no owner to decide it
    // (the cloud backend wires `submitPlan` on the orchestrator alone).
    agent.setParentRelay({
      owed: async () => null,
      sequenceId: (messageId) => messageId,
      send: async () => 'relayed',
    });

    try {
      await expect(agent.enqueueTurn({ text: 'Draft a plan.', metadata: { kinuMode: 'plan' } }))
        .rejects.toThrow('delegated task reports its result instead');

      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
      expect(events.find((event) => event.type === 'tool-result' && event.toolName === 'submit_plan'))
        .toMatchObject({ success: false });
      expect(await agent.getActivePlanReview()).toBeNull();
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('an approval whose handoff turn the loop refuses stays owed, never accepted', async () => {
    const { db, agent, taken } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
    ]);

    try {
      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
      const plan = await agent.getActivePlanReview();

      if (!plan) throw new Error('the submitted plan was not stored');
      // By the time the handoff turn is dequeued another process holds the driver lease.
      let asked = 0;
      agent.setDriverGate(() => (asked++ === 0 ? null : { reason: 'unavailable', error: 'another process is driving' }));

      expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
        ok: true, queued: false, plan: { status: 'approved', handoffAccepted: false },
      });
      expect(await agent.getActivePlanReview()).toMatchObject({ status: 'approved', handoffAccepted: false });
      expect(taken).toHaveLength(2);
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('an acceptance lost after the handoff was admitted is recovered by the next decision, with one turn', async () => {
    const { db, agent } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
      { answer: 'Implemented the approved plan.' },
    ]);

    try {
      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
      const plan = await agent.getActivePlanReview();

      if (!plan) throw new Error('the submitted plan was not stored');
      // The acceptance write fails once, after the loop admitted the turn.
      db.run(`CREATE TRIGGER lose_acceptance BEFORE UPDATE OF handoff_accepted ON plan_reviews
        WHEN NEW.handoff_accepted = 1 BEGIN SELECT RAISE(ABORT, 'interrupted after durable acceptance'); END`);

      expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
        ok: true, queued: false, queueError: expect.stringContaining('interrupted after durable acceptance'),
        plan: { status: 'approved', handoffAccepted: false },
      });
      db.run('DROP TRIGGER lose_acceptance');
      await agent.settleBackgroundWork();

      expect(await agent.decidePlanReview(plan.id, 1, 'approve')).toMatchObject({
        ok: true, queued: true, plan: { status: 'approved', handoffAccepted: true },
      });
      await agent.settleBackgroundWork();
      expect(turnModes(agent)).toEqual(['plan', 'build']);
    } finally {
      await agent.end();
      db.close();
    }
  });
});
