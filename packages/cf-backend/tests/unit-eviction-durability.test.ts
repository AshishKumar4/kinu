/**
 * Eviction recovery through a real `OrchestratorAgent`: the alarm's housekeeping pass hands a left-behind fiber row to `onFiberRecovered`.
 * Defends: recovery that never releases its row and re-enters on every boot. Vendor half: `tests/workerd/do-eviction-recovery.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  BACKGROUND_FIBER_PREFIX, CHAT_SESSION_ID, PendingSendStore, PROGRAMMATIC_MESSAGE_ID_PREFIX, SEARCH_FIBER_NAME,
  type AdvisorRecoverySnapshot, type JsonValue,
} from '@kinu.run/core';
import type { FiberRecoveryContext, FiberRecoveryResult } from 'agents';
import {
  catalogTurn, chatSessionTurns, gatewayWorkspace, historyOver, jobsOver, orchestratorHarness, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { answeringGateway, chatCompletion, stubAiBinding } from './helpers/platform-gateway';
import { makeSql } from '../../core/tests/helpers';
import {
  SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
} from '../src/sandbox-lifecycle';
// Relative path, not `@kinu.run/devbox`: the barrel reaches `cloudflare:workers`, which does not exist under bun.
import { INCIDENT_STAGES } from '../../devbox/src/lifecycle';

type Harness = ActorHarness<HarnessOrchestratorAgent>;

function interrupted(
  name: string, snapshot: JsonValue | AdvisorRecoverySnapshot,
): FiberRecoveryContext {
  return {
    id: `fiber-${name}`,
    name,
    snapshot,
    createdAt: Date.now() - 60_000,
    recoveryReason: 'interrupted',
  };
}

/** Refuses a `void` hook result: it leaves a managed row `interrupted` forever. */
async function recover(
  agent: HarnessOrchestratorAgent, ctx: FiberRecoveryContext,
): Promise<FiberRecoveryResult> {
  const result = await agent.harnessRecoverFiber(ctx);

  if (result === undefined) throw new Error(`onFiberRecovered returned nothing for "${ctx.name}"`);

  return result;
}

/** The programmatic turns the workspace ran, as its conversation stores them, once the queue drains. */
async function programmaticTurns(harness: Harness): Promise<{ id: string; text: string }[]> {
  await chatSessionTurns(harness.agent).drainEnqueued();
  const stored = await historyOver(harness).transcript(CHAT_SESSION_ID).history();

  return stored
    .filter((message) => message.role === 'user' && message.id.startsWith(PROGRAMMATIC_MESSAGE_ID_PREFIX))
    .map((message) => ({
      id: message.id,
      text: message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
    }));
}

function advisorSnapshot(turnId: string): AdvisorRecoverySnapshot {
  return {
    turn: {
      userMessage: 'run the migration',
      assistantResponse: 'ran it',
      toolCalls: [{ name: 'shell', args: { command: 'migrate' } }],
      steps: 2,
      durationMs: 1_200,
      feedback: null,
      hadError: false,
      turnId,
    },
    reachable: ['shell', 'read'],
    minSeverity: 'nit',
    recent: [],
  };
}

const ADVISOR_REPLY = JSON.stringify({
  note: 'The migration ran before the suite. Confirm a backup exists.',
  severity: 'blocker',
  class: 'wrong-work',
});

interface HeldAdvisor {
  readonly harness: Harness;
  readonly entered: Promise<void>;
  readonly release: () => void;
}

/** The workspace's models answer through the gateway, parked until `release`, so "the re-drive is detached" is
 *  assertable rather than raced. The first call is the review's. */
function heldAdvisor(): HeldAdvisor {
  const arrived = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();

  const gateway = stubAiBinding(async (run) => {
    arrived.resolve();
    await held.promise;

    return chatCompletion(run, ADVISOR_REPLY);
  });

  return { harness: gatewayWorkspace(gateway), entered: arrived.promise, release: () => { held.resolve(); } };
}

interface Recovering {
  readonly result: Promise<FiberRecoveryResult>;
  /** Flipped in the promise's own continuation, so ordering against the lane needs no clock. */
  readonly answered: () => boolean;
}

function recovering(agent: HarnessOrchestratorAgent, ctx: FiberRecoveryContext): Recovering {
  let answered = false;

  const result = (async () => {
    const value = await agent.harnessRecoverFiber(ctx);
    answered = true;

    if (value === undefined) throw new Error(`onFiberRecovered returned nothing for "${ctx.name}"`);

    return value;
  })();

  return { result, answered: () => answered };
}

describe('a background job whose executor died', () => {
  test('the recovery hands the re-drive to a carrier and terminalizes the old fiber', async () => {
    const { agent, db } = orchestratorHarness();
    jobsOver(db).create({
      id: 'bgjob-evicted', kind: 'search', workMode: 'build',
      input: JSON.stringify({ task: 'keep going' }), now: Date.now(), label: 'keep going',
    });

    expect(jobsOver(db).get('bgjob-evicted')?.status).toBe('running');

    const result = await recover(agent, interrupted(
      `${BACKGROUND_FIBER_PREFIX}search`,
      { phase: 'running', jobId: 'bgjob-evicted', kind: 'search' },
    ));

    // `completed` means the obligation has a carrier, not that the job ran: a wake resolves only when its queued turn ends.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ snapshot: { lane: 'bg:search', redrive: 'background-job' } });
    // `toContain`: re-driving a running job also opens the job lane's own fiber.
    expect(agent.harnessOpenFiberRows().map((row) => row.name)).toContain('bg:search');

    await agent.harnessJoinDetachedFibers();
    expect(agent.harnessOpenFiberRows()).toEqual([]);
  });

  /** A wake delivered on an idle agent resolves only when its turn ends; the hook must answer without awaiting it inside `blockConcurrencyWhile`. */
  test("a settled job's wake is delivered DETACHED, not awaited by the hook", async () => {
    const queued = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();

    // The wake's turn runs on the model the platform gateway serves, and holds there until released.
    const { agent, db } = gatewayWorkspace(stubAiBinding(async (run) => {
      arrived.resolve();
      await queued.promise;

      return chatCompletion(run, 'Read the answer.');
    }));

    const jobs = jobsOver(db);
    jobs.create({
      id: 'bgjob-settled', kind: 'search', workMode: 'build',
      input: JSON.stringify({ task: 'done already' }), now: Date.now(), label: 'done already',
    });
    jobs.settle('bgjob-settled', jobs.epochOf('bgjob-settled') ?? 0, '"answer"', Date.now());

    const recovery = recovering(agent, interrupted(
      `${BACKGROUND_FIBER_PREFIX}search`,
      { phase: 'running', jobId: 'bgjob-settled', kind: 'search' },
    ));

    await arrived.promise;
    expect(recovery.answered()).toBe(true);
    expect(await recovery.result).toMatchObject({
      status: 'completed', snapshot: { redrive: 'background-job' },
    });

    queued.resolve();
    await agent.harnessJoinDetachedFibers();
    expect(jobs.get('bgjob-settled')?.status).toBe('completed');
  });
});

describe('the post-turn lanes', () => {
  test('the evolution lane leaves a durable row and hands the re-entry to a carrier', async () => {
    const { agent, db } = gatewayWorkspace(answeringGateway('Done.'));
    // The first turn creates the platform's fiber table; the second's lanes run under the recorder.
    await catalogTurn(agent, 'Tidy the notes.');
    db.run('CREATE TABLE fiber_starts (name TEXT NOT NULL)');
    db.run('CREATE TRIGGER record_fiber_start AFTER INSERT ON cf_agents_runs BEGIN INSERT INTO fiber_starts VALUES (NEW.name); END');
    await catalogTurn(agent, 'Tidy them again.');
    await agent.harnessJoinDetachedFibers();

    // `runFiber` writes the row before the body runs; a bare `keepAliveWhile` leaves nothing for a later activation.
    expect(db.query<{ name: string }, []>('SELECT name FROM fiber_starts').all().map((row) => row.name))
      .toContain('evolution:settle');

    const result = await recover(agent, interrupted('evolution:settle', { lane: 'evolution:settle' }));

    // Only the durable half re-enters here: `settleEvolution` joins promises this activation never dispatched,
    // and the session pass spends model calls, too heavy for a hook awaited inside the init gate.
    expect(result).toEqual({
      status: 'completed',
      snapshot: { lane: 'evolution:settle', redrive: 'session-evolution' },
    });
    await agent.harnessJoinDetachedFibers();
  });

  /** The review is a model call, so the hook classifies and the carrier reviews; an in-gate review queues every fetch behind `blockConcurrencyWhile`. */
  test('the advisor review runs DETACHED and still lands exactly one note', async () => {
    const advisor = heldAdvisor();
    const { harness } = advisor;
    const agent = harness.agent;

    const recovery = recovering(agent, interrupted('advisor:review', advisorSnapshot('turn-42')));

    await advisor.entered;
    expect(recovery.answered()).toBe(true);
    expect(agent.harnessNotesForTurn('turn-42')).toBe(0);
    // Completed, not a terminal error: the eviction was not a verdict on the review.
    expect(await recovery.result).toMatchObject({
      status: 'completed',
      snapshot: { turnId: 'turn-42', redrive: 'advisor-review' },
    });
    expect(agent.harnessOpenFiberRows().map((row) => row.name)).toEqual(['advisor:review']);

    advisor.release();
    await agent.harnessJoinDetachedFibers();

    // The signal is keyed on the turn so a re-delivery collapses onto the row it already opened.
    expect(agent.harnessNotesForTurn('turn-42')).toBe(1);
    expect((await programmaticTurns(harness)).map((turn) => turn.id))
      .toEqual([`${PROGRAMMATIC_MESSAGE_ID_PREFIX}advisor:turn-42`]);
    expect(agent.harnessOpenFiberRows()).toEqual([]);
  });

  test('a review that had already landed is NOT re-run, so recovery cannot double it', async () => {
    const advisor = heldAdvisor();
    const { harness } = advisor;
    const agent = harness.agent;
    advisor.release();

    // The note was recorded before eviction; re-running would write a second note and speak it twice.
    await recover(agent, interrupted('advisor:review', advisorSnapshot('turn-42')));
    await agent.harnessJoinDetachedFibers();
    const again = await recover(agent, interrupted('advisor:review', advisorSnapshot('turn-42')));

    expect(again).toMatchObject({
      status: 'completed',
      snapshot: { turnId: 'turn-42', redrive: null, alreadyRecorded: true },
    });
    // The guard is synchronous and runs before any carrier, so the refused re-drive leaves no second fiber row.
    expect(agent.harnessOpenFiberRows()).toEqual([]);
    expect(agent.harnessNotesForTurn('turn-42')).toBe(1);
    expect((await programmaticTurns(harness)).map((turn) => turn.id))
      .toEqual([`${PROGRAMMATIC_MESSAGE_ID_PREFIX}advisor:turn-42`]);
  });

  test('a snapshot that will not parse is terminal, because there is no turn to review', async () => {
    const { agent } = orchestratorHarness();

    const result = await recover(agent, interrupted('advisor:review', {
      lane: 'advisor:review', turnId: 'turn-42',
    }));

    expect(result.status).toBe('error');
    expect(result).toMatchObject({ snapshot: { redrive: null } });
  });

  test('an interrupted search is recorded for the next turn rather than re-run', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;

    const result = await recover(agent, interrupted(SEARCH_FIBER_NAME, { budget: 3 }));

    expect(result).toEqual({
      status: 'completed', snapshot: { lane: 'mcts', recorded: true, redrive: 'memory-note' },
    });

    // The audit row lands in this object's SQLite; the MEMORY.md line goes through the workspace filesystem
    // (another Durable Object when hosted), so it rides the carrier.
    const events = harness.db.prepare<{ type: string; message: string }, []>(
      "SELECT type, message FROM evolution_events WHERE type = 'fiber_recovered'",
    ).all();

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('mcts');

    await agent.harnessJoinDetachedFibers();
    expect(await agent.getMemoryContent()).toContain('Fiber "mcts" was interrupted');
  });
});

describe('a fiber nobody defined a recovery for', () => {
  test('is classified terminally instead of being re-offered until the age bound', async () => {
    const { agent } = orchestratorHarness();

    const result = await recover(agent, interrupted('some:future-lane', { anything: true }));

    // The SDK releases an interrupted row when this hook returns and retains it when it throws,
    // so the terminal error is the mechanism, not just the wording.
    expect(result.status).toBe('error');
    expect(String(result.status === 'error' ? result.error : '')).toContain('some:future-lane');
  });

  test('the scan releases the row it recovered, and the carrier retires its own', async () => {
    const { agent } = orchestratorHarness();

    // Seeded rather than run: a fiber running in this process deletes its own row on the way out.
    agent.harnessSeedOrphanFiber('evolution:settle', { lane: 'evolution:settle' });
    expect(agent.harnessOpenFiberRows()).toHaveLength(1);

    await agent.harnessAlarmHousekeeping();

    // The recovered row is released and the carrier's row stands in its place.
    expect(agent.harnessOpenFiberRows().map((row) => row.name)).toEqual(['evolution:settle']);
    await agent.harnessJoinDetachedFibers();
    expect(agent.harnessOpenFiberRows()).toEqual([]);

    await agent.harnessAlarmHousekeeping();
    expect(agent.harnessOpenFiberRows()).toEqual([]);
  });
});

describe('a sandbox lifecycle failure', () => {
  const incident = {
    version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
    incidentId: 'inc-1',
    stage: 'checkpoint' as const,
    reason: 'mksquashfs exited 1',
    attempts: 1,
  };

  test('becomes ONE blocker turn however many times the container retries', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;

    const first = await agent.acceptSandboxLifecycleFailure(incident);
    const second = await agent.acceptSandboxLifecycleFailure(incident);
    const third = await agent.acceptSandboxLifecycleFailure(incident);

    expect(first).toMatchObject({ status: 'queued', incidentId: 'inc-1', duplicate: false });
    expect(second).toMatchObject({ status: 'queued', duplicate: true });
    expect(third).toMatchObject({ status: 'queued', duplicate: true });
    const turns = await programmaticTurns(harness);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toContain('inc-1');
  });

  test('a delivery that never landed is re-deliverable, which is what ends the retry loop', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    // Another activation drives the conversation, so the turn the incident needs cannot run here.
    agent.harnessRefuseDriving({ reason: 'unavailable', error: 'another activation is driving' });

    const refused = await agent.acceptSandboxLifecycleFailure(incident);
    // `undelivered`, not `queued`: the box maps `queued` to `deliveredAt` and stops offering the row.
    expect(refused).toMatchObject({ status: 'undelivered', duplicate: false });

    agent.harnessRefuseDriving(null);
    const retried = await agent.acceptSandboxLifecycleFailure(incident);

    expect(retried).toMatchObject({ status: 'queued', duplicate: false });
    expect(await programmaticTurns(harness)).toHaveLength(1);
  });

  test('the agent is told what the stage costs it, and the incident id, and nothing else', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;

    await agent.acceptSandboxLifecycleFailure({
      version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
      incidentId: 'inc-2',
      stage: 'attach',
      reason: 'archive size 0 did not match the declared 918_224',
      attempts: 1,
    });

    const texts = (await programmaticTurns(harness)).map((turn) => turn.text);
    expect(texts).toHaveLength(1);
    const text = texts[0];
    expect(text).toContain('attach stage');
    expect(text).toContain('Verify the workspace contents');
    expect(text).toContain('archive size 0 did not match the declared 918_224');
    expect(text).toContain('inc-2');
  });

  test('an envelope that invents a field is REFUSED, not silently stripped', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;

    // Stripping it would let the caller believe the agent had read it.
    const rejected = await agent.acceptSandboxLifecycleFailure({
      ...incident,
      incidentId: 'inc-3',
      r2Key: 'backups/abc/data.sqsh',
    });

    expect(rejected.status).toBe('rejected');
    expect(await programmaticTurns(harness)).toEqual([]);
  });

  test('every stage the CONTAINER can emit is queued, not rejected', async () => {
    // Driven from the producer's list: iterating the consumer's list would agree with itself when Devbox adds a stage.
    const harness = orchestratorHarness();
    const { agent } = harness;

    for (const stage of INCIDENT_STAGES) {
      const answer = await agent.acceptSandboxLifecycleFailure({
        version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
        incidentId: `inc-${stage}`, stage, reason: 'measured failure', attempts: 1,
      });

      expect({ stage, status: answer.status }).toEqual({ stage, status: 'queued' });
    }

    // A stage with no consequence written for it would render as `undefined` in the agent's turn.
    const texts = (await programmaticTurns(harness)).map((turn) => turn.text);
    expect(texts).toHaveLength(INCIDENT_STAGES.length);

    for (const text of texts) expect(text).not.toContain('undefined');
  });

  test('a stage outside the closed set is refused rather than given a generic consequence', async () => {
    const { agent } = orchestratorHarness();

    const answer = await agent.acceptSandboxLifecycleFailure({
      version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
      incidentId: 'inc-4', stage: 'defrost', reason: 'measured failure', attempts: 1,
    });

    expect(answer.status).toBe('rejected');
  });
});

describe('whether the container may be disturbed', () => {
  test('idle means idle', async () => {
    const { agent } = orchestratorHarness();
    expect(await agent.hasSandboxBackgroundWork()).toBe(false);
  });

  test('an admitted send protects the container until its reservation retires', async () => {
    const { agent, db } = orchestratorHarness();
    const sends = new PendingSendStore(makeSql(db), workspaceMainActor(db).actorId);
    sends.reserve({ id: 'accepted-before-reset', turnId: null, mode: 'build', text: 'inspect the container' });

    expect(await agent.hasSandboxBackgroundWork()).toBe(true);
    sends.retire(['accepted-before-reset']);
    expect(await agent.hasSandboxBackgroundWork()).toBe(false);
  });

  test('a running detached job counts, because it may hold the container', async () => {
    const { agent, db } = orchestratorHarness();
    jobsOver(db).create({
      id: 'bgjob-live', kind: 'shell', workMode: 'build',
      input: JSON.stringify({ command: 'npm test' }), now: Date.now(), label: 'npm test',
    });
    expect(await agent.hasSandboxBackgroundWork()).toBe(true);
  });

  test('a settled job does not', async () => {
    const { agent, db } = orchestratorHarness();
    const jobs = jobsOver(db);
    jobs.create({
      id: 'bgjob-done', kind: 'shell', workMode: 'build',
      input: JSON.stringify({ command: 'npm test' }), now: Date.now(), label: 'npm test',
    });
    jobs.settle('bgjob-done', jobs.epochOf('bgjob-done') ?? 0, '"ok"', Date.now());
    expect(await agent.hasSandboxBackgroundWork()).toBe(false);
  });

  test('a live turn counts — it is the most likely caller of a container tool', async () => {
    const { agent } = orchestratorHarness();
    await agent.declareTurnInFlight(true);
    expect(await agent.hasSandboxBackgroundWork()).toBe(true);
  });

});
