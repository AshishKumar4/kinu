/**
 * Eviction recovery through a real `OrchestratorAgent`: the alarm's housekeeping pass hands a left-behind fiber row to `onFiberRecovered`.
 * Defends: recovery that never releases its row and re-enters on every boot. Vendor half: `tests/workerd/do-eviction-recovery.test.ts`.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  ActorSession, ADVISOR_HEADER, BACKGROUND_FIBER_PREFIX, CHAT_SESSION_ID, PendingSendStore, PROGRAMMATIC_MESSAGE_ID_PREFIX,
  TERMINAL_EFFECT_RETRY_CEILING_MS, type JsonValue,
} from '@kinu.run/core';
import type { FiberRecoveryContext, FiberRecoveryResult } from 'agents';
import {
  catalogTurn, chatSessionTurns, GATEWAY_CATALOG, gatewayWorkspace, historyOver, jobsOver, orchestratorHarness,
  adviceDue, driveUntil, reactivateOrchestratorHarness, until, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { answeringGateway, chatCompletion, stubAiBinding } from './helpers/platform-gateway';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { makeSql } from '../../core/tests/helpers';
import {
  SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
} from '../src/sandbox-lifecycle';
// Relative path, not `@kinu.run/devbox`: the barrel reaches `cloudflare:workers`, which does not exist under bun.
import { INCIDENT_STAGES } from '../../devbox/src/lifecycle';

type Harness = ActorHarness<HarnessOrchestratorAgent>;

afterEach(() => { setSystemTime(); });

function interrupted(
  name: string, snapshot: JsonValue,
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

const ADVISOR_REPLY = JSON.stringify({
  note: 'The migration ran before the suite. Confirm a backup exists.',
  severity: 'blocker',
  class: 'wrong-work',
});

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

  /** The advisor's hire is its own terminal row: the snapshot is its input, so a fresh activation replays it. */
  async function cutReview(): Promise<{ readonly harness: Harness; readonly calls: () => number; readonly restart: () => Promise<Harness> }> {
    let calls = 0;

    const gateway = stubAiBinding(async (run) => {
      const asked = JSON.stringify(run);

      // This turn's review only: a delivered note opens a follow-up turn, which owes its own.
      if (asked.includes('You are reviewing one finished turn') && asked.includes('run the migration')) calls += 1;

      return chatCompletion(run, ADVISOR_REPLY);
    });

    const harness = gatewayWorkspace(gateway, { cut: ['advisor_review', 'before'] });
    workspaceMainActor(harness.db).config.setAdvisorEnabled(true);
    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'run the migration' }] });
    await chatSessionTurns(harness.agent).settle({ messageId: 'turn-42', text: 'ran it' });
    await joinHarnessFibers();

    // A fresh activation over the same rows, past any backoff, running the alarm's pass.
    const restart = async (): Promise<Harness> => {
      setSystemTime(new Date(Date.now() + TERMINAL_EFFECT_RETRY_CEILING_MS));

      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        world: { aiGateway: gateway },
        beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
      });

      await restarted.agent.terminalRetryPass();
      // The review is the hired advisor's own delegated turn, which the wake drains; its answer's job delivers the note.
      await driveUntil(restarted, 'the replayed review settled', () => owedReview(restarted) === 0 && advisorsWorking(restarted) === 0 && !adviceDue(restarted.db));
      await joinHarnessFibers();

      return restarted;
    };

    return { harness, calls: () => calls, restart };
  }

  const count = (harness: Harness, query: string): number => harness.db.query<{ n: number }, []>(query).get()?.n ?? 0;

  const owedReview = (harness: Harness): number =>
    count(harness, "SELECT COUNT(*) AS n FROM terminal_effects WHERE effect_name = 'advisor_review' AND status != 'completed'");

  const notes = (harness: Harness): number => count(harness, "SELECT COUNT(*) AS n FROM evolution_events WHERE type = 'advisor_note'");

  const advisorsWorking = (harness: Harness): number =>
    count(harness, "SELECT COUNT(*) AS n FROM actor_subordinates WHERE name LIKE 'ask-advisor-%' AND status = 'working'");

  test('a hire cut before it ran is replayed by the next activation and lands exactly one note', async () => {
    const { harness, calls, restart } = await cutReview();
    expect(calls()).toBe(0);
    expect(owedReview(harness)).toBe(1);

    const restarted = await restart();

    expect(calls()).toBe(1);
    expect(notes(restarted)).toBe(1);
    expect(owedReview(restarted)).toBe(0);
    // The signal is keyed on the turn so a re-delivery collapses onto the row it already opened.
    expect((await programmaticTurns(restarted)).filter((turn) => turn.id.startsWith(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}advisor:`)))
      .toHaveLength(1);
  });

  test('an advisor answer stored before a death is delivered once, by the next activation', async () => {
    const { calls, restart } = await cutReview();
    const deliver = Object.getOwnPropertyDescriptor(ActorSession.prototype, 'deliverAdvisorAnswers');

    // The object dies after the ingress stored the answer and before its note is delivered.
    Object.defineProperty(ActorSession.prototype, 'deliverAdvisorAnswers', {
      configurable: true, value: () => Promise.reject(new Error('the object died')),
    });

    let died: Harness;

    try {
      died = await restart();
    } finally {
      if (deliver) Object.defineProperty(ActorSession.prototype, 'deliverAdvisorAnswers', deliver);
    }

    expect(calls()).toBe(1);
    expect(notes(died)).toBe(0);
    // The answer and the job that delivers it are both still on disk.
    expect(count(died, "SELECT COUNT(*) AS n FROM evolution_helpers WHERE answer_status IS NOT NULL")).toBe(1);

    const restarted = await restart();
    await restart();

    expect(calls()).toBe(1);
    expect(notes(restarted)).toBe(1);
    expect((await programmaticTurns(restarted)).filter((turn) => turn.id.startsWith(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}advisor:`)))
      .toHaveLength(1);
  });

  test('a turn whose note had already landed hires no advisor again, so recovery cannot double it', async () => {
    const { harness, calls, restart } = await cutReview();
    // The review recorded its note, then the isolate reset before the row settled.
    harness.db.run(`INSERT INTO evolution_events (actor_id, type, message, data)
      SELECT actor_id, 'advisor_note', 'already said', json_object('turnId', json_extract(input_json, '$.advisor.turn.turnId'))
      FROM terminal_effects WHERE effect_name = 'advisor_review'`);

    const restarted = await restart();

    expect(calls()).toBe(0);
    expect(notes(restarted)).toBe(1);
    expect(owedReview(restarted)).toBe(0);
  });
});

// Review P1 (d35c1060fe): the answer job awaited the note's delivery, and a note sent to an idle actor settles only
// when the whole turn it opens does, so the alarm held across that turn's inference and a long one met the wall.
describe('an advisor answer handed to a turn', () => {
  test('the alarm returns while the turn the note opened still runs; the answer is kept until it is said', async () => {
    const gateway = stubAiBinding((run) => chatCompletion(run, ADVISOR_REPLY));
    const harness = gatewayWorkspace(gateway);
    const turns = chatSessionTurns(harness.agent);
    workspaceMainActor(harness.db).config.setAdvisorEnabled(true);
    await turns.prepare({ messages: [{ role: 'user', content: 'run the migration' }] });
    await turns.settle({ messageId: 'turn-42', text: 'ran it' });

    const answers = (): number => harness.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM evolution_helpers WHERE answer_status IS NOT NULL',
    ).get()?.n ?? 0;

    // The note opens a turn on the idle actor, and that turn parks on its model call; the wake drives the advisor's
    // own turn, then the answer's job, which hands the note to that turn.
    let noteAsked = false;
    let drove = false;

    const noteTurn = turns.park().then((request) => {
      noteAsked = true;

      return request;
    });

    const driving = driveUntil(harness, 'the note opened its turn', () => noteAsked).then(() => { drove = true; });

    expect(JSON.stringify((await noteTurn).messages)).toContain(ADVISOR_HEADER);
    await until(() => drove, "the alarm returned while the note's turn runs");
    await driving;
    expect(answers()).toBe(1);

    await turns.settle({ messageId: 'note-answer', text: 'Checked the backup.' });
    await until(() => answers() === 0, 'the said note released its answer');
    expect(harness.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM evolution_events WHERE type = 'advisor_note'").get()?.n).toBe(1);
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

describe('whether the container is in use', () => {
  test('idle means idle', async () => {
    const { agent } = orchestratorHarness();
    expect(await agent.sandboxInUse()).toBe(false);
  });

  test('work the root owes itself does not hold the container: an admitted send waits for the root wake', async () => {
    // warm-forge-4d6acc02 kept its container running 30+ h on 2026-09-25/26 while its root owed work it
    // could not finish (unfinished arms), and every beat woke the root to ask.
    const { agent, db } = orchestratorHarness();
    const sends = new PendingSendStore(makeSql(db), workspaceMainActor(db).actorId);
    sends.reserve({ id: 'accepted-before-reset', turnId: null, mode: 'build', text: 'inspect the container' });

    expect(await agent.sandboxInUse()).toBe(false);
  });

  test('a running job row nothing drives (deferred, or left by a dead activation) does not', async () => {
    const { agent, db } = orchestratorHarness();
    jobsOver(db).create({
      // Started by an earlier activation: nothing in this one drives it.
      id: 'bgjob-orphan', kind: 'shell', workMode: 'build',
      input: JSON.stringify({ command: 'npm test' }), now: Date.now() - 60_000, label: 'npm test',
    });

    expect(await agent.sandboxInUse()).toBe(false);
  });

  test('a live turn counts — it is the most likely caller of a container tool', async () => {
    const { agent } = orchestratorHarness();
    await agent.declareTurnInFlight(true);
    expect(await agent.sandboxInUse()).toBe(true);
  });
});

