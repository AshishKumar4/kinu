// Plan review on the local backend: `submit_plan`, the `plan_updated` fan-out, the stored review,
// and a build turn waiting for the owner's verdict. Asserted only through the session's public surface.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath, scriptedTurnModel, scratchDir } from '@kinu.run/test-utils';
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
  | { readonly call: string; readonly input: JsonObject; readonly waitFor?: Promise<void>; readonly onTaken?: () => void }
  | { readonly answer: string; readonly waitFor?: Promise<void>; readonly onTaken?: () => void };

const QUIET = {
  content: [{ type: 'text' as const, text: 'Nothing to change.' }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: USAGE, warnings: [],
};

/**
 * Replays `steps` one per turn request, then answers, so an extra request ends the turn instead of re-running a tool.
 * A request offered no tools is the session's own background work between turns (memory compression), not a turn.
 */
function scriptedSteps(steps: readonly Step[]) {
  const taken: Step[] = [];

  const model = scriptedTurnModel({ doGenerate: async (options) => {
    if ((options.tools ?? []).length === 0) return QUIET;
    const step = steps[taken.length] ?? { answer: 'nothing left to do' };
    taken.push(step);

    if ('answer' in step) {
      step.onTaken?.();
      await step.waitFor;

      return {
        content: [{ type: 'text' as const, text: step.answer }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE, warnings: [],
      };
    }

    step.onTaken?.();
    await step.waitFor;

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
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
  const events: SessionEvent[] = [];
  const { model, taken } = scriptedSteps(steps);

  rt.actor.config.setLearning(false);

  const agent = new LocalAgentSession({
    rt, db, model, onEvent: (event) => events.push(event),
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
  /**
   * One owner's plan, start to finish, on one session. The plan holds what they type in Plan, while an explicit Auto
   * message and a harness drain keep build. A change request hands the numbered plan back and its revision supersedes
   * it. An approval whose acceptance was lost is recovered by the next decision with one handoff turn, which may write.
   * A second plan, dismissed, lifts the hold with no handoff. Write authority is read off each turn's own write.
   */
  test('one plan through hold, revision, a lost acceptance and its replay, then a dismissed plan', async () => {
    const write = (path: string) => ({ call: 'file', input: { action: 'write', path: `vfs://home/main/${path}`, content: path } });

    const { db, agent, events, taken } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
      write('held.txt'), { answer: 'I cannot implement before the plan is decided.' },
      write('typo.txt'), { answer: 'Fixed the typo.' },
      write('report.txt'), { answer: 'Handled the report.' },
      { call: 'submit_plan', input: { edits: [{ start: 2, end: 2, content: '- keep the audit trail' }] } },
      { answer: 'Revised.' },
      write('ledger.txt'), { answer: 'Implemented the approved plan.' },
      { call: 'submit_plan', input: { edits: [{ start: 1, content: '# Export plan' }] } },
      { answer: 'Plan submitted for review.' },
      write('other.txt'), { answer: 'Done.' },
    ]);

    try {
      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
      const first = await agent.getActivePlanReview();

      expect(first).toMatchObject({ sessionId: CHAT_SESSION_ID, revision: 1, status: 'pending', content: PLAN_BODY, handoffAccepted: false });

      if (!first) throw new Error('the submitted plan was not stored');
      // Typed as ordinary work but held in Plan; an explicit Auto message and a drain are outside the plan's thread.
      await agent.send('Implement it now.', { id: crypto.randomUUID() });
      await agent.send('Fix the typo meanwhile.', { id: crypto.randomUUID(), mode: 'build' });
      await agent.enqueueTurn({ text: '[subordinate_report] done', idempotencyKey: 'drain:1' });
      await agent.settleBackgroundWork();
      expect(fileResults(events)).toMatchObject([{ success: false, reason: 'denied' }, { success: true }, { success: true }]);
      expect(await agent.getActivePlanReview()).toMatchObject({ id: first.id, status: 'pending' });

      expect(await agent.decidePlanReview(first.id, 1, 'request_changes', 'Say what happens to the audit trail.')).toMatchObject({ ok: true, queued: true });
      await agent.settleBackgroundWork();
      expect(await agent.getActivePlanReview()).toMatchObject({ id: first.id, revision: 2, status: 'pending', content: '# Migration plan\n- keep the audit trail' });

      // The acceptance write fails once, after the loop admitted the handoff; the next decision recovers it.
      db.run(`CREATE TRIGGER lose_acceptance BEFORE UPDATE OF handoff_accepted ON plan_reviews
        WHEN NEW.handoff_accepted = 1 BEGIN SELECT RAISE(ABORT, 'interrupted after durable acceptance'); END`);
      expect(await agent.decidePlanReview(first.id, 2, 'approve')).toMatchObject({
        ok: true, queued: false, queueError: expect.stringContaining('interrupted after durable acceptance'), plan: { status: 'approved', handoffAccepted: false },
      });
      db.run('DROP TRIGGER lose_acceptance');
      await agent.settleBackgroundWork();
      expect(await agent.decidePlanReview(first.id, 2, 'approve')).toMatchObject({ ok: true, queued: true, plan: { status: 'approved', handoffAccepted: true } });
      await agent.settleBackgroundWork();

      const states = planBroadcasts(events).map((event) => `${String(event.plan?.revision)}:${String(event.plan?.status)}`);

      expect(states.filter((state, index) => state !== states[index - 1])).toEqual(['1:pending', '1:changes_requested', '2:pending', '2:approved']);

      // A second plan, dismissed: no handoff runs, and what is typed next may write.
      await agent.send('Plan the export.', { id: crypto.randomUUID(), mode: 'plan' });
      const second = await agent.getActivePlanReview();

      if (!second || second.id === first.id) throw new Error('the second plan was not stored as its own');
      const asked = taken.length;

      expect(await agent.dismissPlanReview(second.id, 1)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
      await agent.settleBackgroundWork();
      expect(taken).toHaveLength(asked);
      await agent.send('Do the other thing.', { id: crypto.randomUUID() });

      expect(fileResults(events).map((result) => result.type === 'tool-result' && result.success)).toEqual([false, true, true, true, true]);
      expect(turnModes(agent)).toEqual(['plan', 'plan', 'build', 'build', 'plan', 'build', 'plan', 'build']);
    } finally {
      await agent.end();
      db.close();
    }
  });


  test('a plan-mode harness turn carrying a refiner\'s proposal cannot submit it as a plan', async () => {
    const proposal = '{"scope":"workspace","edits":[{"kind":"prompt_section","sectionId":"state/output-format","source":"Stop after one line."}]}';

    const { db, agent, events } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: `# Prompt edits\n${proposal}` }] } },
      { answer: 'Could not submit.' },
    ]);

    try {
      await agent.enqueueTurn({
        text: `1 event arrived while you were idle.\n- [subordinate_report] from subordinate (ask-refiner-a1): completed: ${proposal}`,
        idempotencyKey: 'drain:refiner', metadata: { kinuEvent: 'event_drain', kinuMode: 'plan' },
      });
      await agent.settleBackgroundWork();

      expect(turnModes(agent)).toEqual(['plan']);
      expect(events.find((event) => event.type === 'tool-result' && event.toolName === 'submit_plan'))
        .toMatchObject({ output: { ok: false } });
      expect(await agent.getActivePlanReview()).toBeNull();
      expect(planBroadcasts(events)).toEqual([]);
    } finally {
      await agent.end();
      db.close();
    }
  });

  test('a dismissed plan\'s handoff that was still queued never runs, approved or sent back', async () => {
    // The handoff waits in the queue behind a running turn, so the plan still reads as awaiting and Dismiss is offered.
    for (const decision of ['approve', 'request_changes'] as const) {
      const running = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();

      const { db, agent, taken } = session([
        { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
        { answer: 'Plan submitted for review.' },
        { answer: 'Still on the other thing.', waitFor: running.promise, onTaken: started.resolve },
      ]);

      try {
        await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
        const plan = await agent.getActivePlanReview();

        if (!plan) throw new Error('the submitted plan was not stored');
        const other = agent.send('Meanwhile, look at the logs.', { id: crypto.randomUUID(), mode: 'build' });
        await started.promise;
        // The running turn holds the queue, so the handoff this decision enqueues waits behind it.
        const decided = agent.decidePlanReview(plan.id, 1, decision, decision === 'approve' ? undefined : 'Say what happens to the audit trail.');

        expect(await agent.dismissPlanReview(plan.id, 1)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
        running.resolve();
        await other;
        await decided;
        await agent.settleBackgroundWork();

        expect(taken).toHaveLength(3);
        expect(turnModes(agent)).toEqual(['plan', 'build']);
        expect(await agent.getActivePlanReview()).toMatchObject({ status: 'dismissed' });
      } finally {
        await agent.end();
        db.close();
      }
    }
  });

  test('dismissing a sent-back plan while its revision turn runs stops that turn, and no new plan appears', async () => {
    // Being held in Plan was the complaint: Dismiss never refuses, and a revision already running files nothing.
    const revising = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const { db, agent, taken } = session([
      { call: 'submit_plan', input: { edits: [{ start: 1, content: PLAN_BODY }] } },
      { answer: 'Plan submitted for review.' },
      // The revision turn is running and about to file its revision when the dismiss lands.
      { call: 'submit_plan', input: { edits: [{ start: 1, content: '# The revised plan' }] }, waitFor: revising.promise, onTaken: started.resolve },
      { answer: 'Revision submitted.' },
    ]);

    try {
      await agent.send('Draft the ledger migration.', { id: crypto.randomUUID(), mode: 'plan' });
      const plan = await agent.getActivePlanReview();

      if (!plan) throw new Error('the submitted plan was not stored');
      const decided = agent.decidePlanReview(plan.id, 1, 'request_changes', 'Say what happens to the audit trail.');
      await started.promise;

      expect(await agent.dismissPlanReview(plan.id, 1)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
      revising.resolve();
      await decided;
      await agent.settleBackgroundWork();

      expect(await agent.getActivePlanReview()).toMatchObject({ id: plan.id, revision: 1, status: 'dismissed' });
      expect(taken.length).toBeLessThanOrEqual(3);
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

});
