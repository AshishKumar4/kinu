/**
 * Eviction durability — what survives an activation this Durable Object never
 * chose to end, and what it does on the next one.
 *
 * Every case below drives a REAL `OrchestratorAgent` (tests/helpers/actor-harness)
 * through the entry points the platform uses: a durable fiber runs and its row
 * is left behind, then the alarm's housekeeping pass — the path that runs with
 * no request and no socket — hands that row to `onFiberRecovered`. Nothing here
 * calls the hook and asserts a decision without also asserting what happened to
 * the row, because the row IS the difference between recovery that converges and
 * recovery that re-enters on every boot until an age bound discards it.
 *
 * The vendor half — that an accepted submission and an interrupted chat turn
 * really do survive a reset, and that the alarm really does fire with nobody
 * connected — is `tests/workerd/do-eviction-recovery.test.ts`. That semantic
 * does not exist under bun, so this file does not pretend to measure it.
 */
import { describe, expect, test } from 'bun:test';
import {
  BACKGROUND_FIBER_PREFIX, SEARCH_FIBER_NAME,
  type AdvisorRecoverySnapshot, type AgentSignal, type JsonValue,
} from '@kinu.run/core';
import type { FiberRecoveryContext, FiberRecoveryResult } from 'agents';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { SANDBOX_LIFECYCLE_STAGES, sandboxLifecycleIncidentKey } from '../src/sandbox-lifecycle';
// The PRODUCER's own stage list, by relative path rather than through
// `@kinu.run/devbox`: the barrel exports the Devbox class, which imports the
// Sandbox runtime and therefore `cloudflare:workers`, which does not exist
// under bun. Same reason the devbox package's own decision tests avoid it.
import { INCIDENT_STAGES } from '../../devbox/src/lifecycle';

/** The recovery context the SDK builds for an unmanaged row it found
 *  interrupted. Only `name` and `snapshot` are decisions here; the rest is the
 *  shape the hook is handed. */
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

/** A recovery result, refused when the hook returned nothing — which is the
 *  regression this file exists to catch: `void` leaves a managed row
 *  `interrupted` forever and tells a reader nothing about what was decided. */
async function recover(
  agent: HarnessOrchestratorAgent, ctx: FiberRecoveryContext,
): Promise<FiberRecoveryResult> {
  const result = await agent.harnessRecoverFiber(ctx);
  if (result === undefined) throw new Error(`onFiberRecovered returned nothing for "${ctx.name}"`);
  return result;
}

/** The slice of the SDK's `SubmitMessagesResult` the recovery seam reads:
 *  identity, the idempotency-key echo, and admission status. */
interface RecordedSubmission {
  submissionId: string;
  idempotencyKey?: string;
  status: 'pending';
  createdAt: number;
  accepted: boolean;
}

/** Every programmatic turn the actor admitted, by the message id the seam
 *  derives from a producer's idempotency key. Recorded on the instance because
 *  a durable submission needs a platform this suite does not have; the vendor's
 *  own dedupe over the same key is proven in the workerd layer. */
function recordSubmissions(agent: HarnessOrchestratorAgent): string[] {
  const seen: string[] = [];
  Object.defineProperty(agent, 'submitMessages', {
    configurable: true,
    value: async (messages: { id: string }[], options?: { idempotencyKey?: string }) => {
      const id = messages[0]?.id ?? '(none)';
      const first = !seen.includes(id);
      seen.push(id);
      const submission: RecordedSubmission = {
        submissionId: `sub-${String(seen.length)}`,
        status: 'pending',
        createdAt: Date.now(),
        accepted: first,
      };
      if (options?.idempotencyKey !== undefined) submission.idempotencyKey = options.idempotencyKey;
      return submission;
    },
  });
  return seen;
}

/** The snapshot an interrupted advisor lane stashed — the complete turn plus
 *  the three decisions taken at turn end, which is the whole of what a re-drive
 *  needs. Minimal but COMPLETE: every field the lane's deps require. */
function advisorSnapshot(turnId: string): AdvisorRecoverySnapshot {
  return {
    turn: {
      userMessage: 'run the migration',
      assistantResponse: 'ran it',
      toolCalls: [{ name: 'run', args: { command: 'migrate' } }],
      steps: 2,
      durationMs: 1_200,
      feedback: null,
      hadError: false,
      turnId,
    },
    reachable: ['run', 'read'],
    minSeverity: 'nit',
    recent: [],
  };
}

interface AdvisorObservation {
  notes: string[];
  signals: AgentSignal[];
}

/** The advisor lane's two outputs, captured at the seams the lane itself uses:
 *  a reviewer model that answers one note, the real note store (so the durable
 *  row a recovery guards on is really written), and the signal seam. */
function observeAdvisor(agent: HarnessOrchestratorAgent): AdvisorObservation {
  const notes: string[] = [];
  const signals: AgentSignal[] = [];
  const reply = JSON.stringify({
    note: 'The migration ran before the suite. Confirm a backup exists.',
    severity: 'blocker',
    class: 'wrong-work',
  });
  Object.defineProperty(agent.observeRuntime(), 'advisorLlm', {
    configurable: true,
    get: () => ({
      complete: async () => { notes.push(reply); return reply; },
      stream: () => { throw new Error('the advisor lane completes, it does not stream'); },
    }),
  });
  const signals_ = agent.observeOrch().signals;
  const deliver = signals_.deliver.bind(signals_);
  Object.defineProperty(signals_, 'deliver', {
    configurable: true,
    value: async (signal: AgentSignal) => { signals.push(signal); return await deliver(signal); },
  });
  return { notes, signals };
}

describe('the recovery configuration is declared, not inherited', () => {
  test('chat turns run inside a recovery fiber and no elapsed bound ends one', () => {
    const { agent } = orchestratorHarness();

    // Every owner turn and every subordinate turn on this substrate depends on
    // the chat-recovery fiber, so it is stated rather than left to an SDK
    // default that a version bump could flip.
    expect(agent.chatRecovery).toBe(true);
    // And the stall watchdog stays off: it measures the gap between stream
    // chunks, no chunks flow while a server-side tool runs, so any finite value
    // is a wall-clock bound on a TURN. A hung provider is bounded by recovery
    // attempts instead.
    expect(agent.chatStreamStallTimeoutMs).toBe(0);
  });
});

describe('a background job whose executor died', () => {
  test('the recovery re-drives it from the durable row and terminalizes the old fiber', async () => {
    const { agent } = orchestratorHarness();
    agent.harnessJobs().create({
      id: 'bgjob-evicted', kind: 'search', workMode: 'build',
      input: JSON.stringify({ task: 'keep going' }), now: Date.now(), label: 'keep going',
    });

    // What the dead activation left: a `running` row nothing in this isolate
    // owns, and a fiber row whose stash names the job it was driving.
    expect(agent.harnessJobs().get('bgjob-evicted')?.status).toBe('running');

    const result = await recover(agent, interrupted(
      `${BACKGROUND_FIBER_PREFIX}search`,
      { phase: 'running', jobId: 'bgjob-evicted', kind: 'search' },
    ));

    // `completed` is the mark that moves a managed row off `interrupted`, and
    // the snapshot says which job this recovery actually re-drove — so a reader
    // can tell a re-drive from a no-op without reading the job table.
    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ snapshot: { redriven: 'bgjob-evicted' } });
  });

  test('a job whose outcome had landed is not re-driven, and the recovery still terminalizes', async () => {
    const { agent } = orchestratorHarness();
    const jobs = agent.harnessJobs();
    jobs.create({
      id: 'bgjob-settled', kind: 'search', workMode: 'build',
      input: JSON.stringify({ task: 'done already' }), now: Date.now(), label: 'done already',
    });
    // The outcome landed and the wake did not — the one case a fiber row knows
    // about and the registry does not.
    jobs.settle('bgjob-settled', jobs.epochOf('bgjob-settled') ?? 0, '"answer"', Date.now());

    const result = await recover(agent, interrupted(
      `${BACKGROUND_FIBER_PREFIX}search`,
      { phase: 'running', jobId: 'bgjob-settled', kind: 'search' },
    ));

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ snapshot: { redriven: null } });
    // The recorded outcome is untouched: recovery re-delivers the wake, it does
    // not re-run work that already answered.
    expect(jobs.get('bgjob-settled')?.status).toBe('completed');
  });
});

describe('the post-turn lanes', () => {
  test('the evolution lane leaves a durable row and re-enters from the queue', async () => {
    const { agent } = orchestratorHarness();

    agent.harnessSettleEvolution();
    // The row is written by `runFiber` BEFORE the body runs, which is the whole
    // difference from a bare `keepAliveWhile`: that leaves nothing behind for a
    // later activation to find.
    expect(agent.harnessOpenFiberRows().map((row) => row.name)).toContain('evolution:settle');

    const result = await recover(agent, interrupted('evolution:settle', { lane: 'evolution:settle' }));

    // Re-entry is the DURABLE half only: the session pass, which claims and
    // settles its own window and drains its own trial queue. `settleEvolution`
    // joins promises this activation never dispatched, so it is deliberately
    // absent from the recovery path.
    expect(result).toEqual({
      status: 'completed',
      snapshot: { lane: 'evolution:settle', reentered: 'session-evolution' },
    });
  });

  test('the advisor lane re-drives from its snapshot and lands exactly one note', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const advisor = observeAdvisor(agent);

    // Exactly what the interrupted lane stashed: the complete turn plus the
    // three decisions taken at turn end. Nothing is re-derived on recovery, so
    // the review runs against the world the turn ran in.
    const result = await recover(agent, interrupted(
      'advisor:review', advisorSnapshot('turn-42'),
    ));

    // Completed, NOT a terminal error: the review is work, and the eviction was
    // not a verdict on it.
    expect(result).toMatchObject({
      status: 'completed',
      snapshot: { turnId: 'turn-42', reentered: true },
    });
    // One note on the audit stream, one signal spoken, and the signal is keyed
    // on the turn so a re-delivery collapses onto the row it already opened.
    expect(advisor.notes).toHaveLength(1);
    expect(advisor.signals).toHaveLength(1);
    expect(advisor.signals[0]).toMatchObject({ idempotencyKey: 'advisor:turn-42' });
    expect(agent.harnessNotesForTurn('turn-42')).toBe(1);
  });

  test('a review that had already landed is NOT re-run, so recovery cannot double it', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;
    const advisor = observeAdvisor(agent);

    // The other side of the one durable write: the lane recorded its note and
    // was evicted before the fiber row was released, so recovery is offered the
    // same work again. Re-running here is what would write a second note about
    // one turn and speak it twice.
    await recover(agent, interrupted('advisor:review', advisorSnapshot('turn-42')));
    const again = await recover(agent, interrupted('advisor:review', advisorSnapshot('turn-42')));

    expect(again).toMatchObject({
      status: 'completed',
      snapshot: { turnId: 'turn-42', reentered: false, alreadyRecorded: true },
    });
    // Still one, after two recoveries of the same lane.
    expect(advisor.notes).toHaveLength(1);
    expect(advisor.signals).toHaveLength(1);
    expect(agent.harnessNotesForTurn('turn-42')).toBe(1);
  });

  test('a snapshot that will not parse is terminal, because there is no turn to review', async () => {
    const { agent } = orchestratorHarness();

    // The pre-change stash shape: a pointer, not the review. Nothing a further
    // attempt could do differently, so this one really is terminal.
    const result = await recover(agent, interrupted('advisor:review', {
      lane: 'advisor:review', turnId: 'turn-42',
    }));

    expect(result.status).toBe('error');
    expect(result).toMatchObject({ snapshot: { reentered: false } });
  });

  test('an interrupted search is recorded for the next turn rather than re-run', async () => {
    const harness = orchestratorHarness();
    const agent = harness.agent;

    const result = await recover(agent, interrupted(SEARCH_FIBER_NAME, { budget: 3 }));

    expect(result).toEqual({ status: 'completed', snapshot: { lane: 'mcts', recorded: true } });
    // The agent's own record of the interruption: a future turn that finds a
    // half-expanded tree can see why. The search itself is NOT re-driven here —
    // its tree is durable and, when the call was detached, its job row is what
    // re-drives it.
    const events = harness.db.prepare<{ type: string; message: string }, []>(
      "SELECT type, message FROM evolution_events WHERE type = 'fiber_recovered'",
    ).all();
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toContain('mcts');
  });
});

describe('a fiber nobody defined a recovery for', () => {
  test('is classified terminally instead of being re-offered until the age bound', async () => {
    const { agent } = orchestratorHarness();

    const result = await recover(agent, interrupted('some:future-lane', { anything: true }));

    // The SDK releases an interrupted row when this hook RETURNS and retains it
    // when it THROWS — a retained row is re-offered on every activation for 24
    // hours and keeps the object warm the whole time. So the terminal error is
    // the mechanism, not just the wording.
    expect(result.status).toBe('error');
    expect(String(result.status === 'error' ? result.error : '')).toContain('some:future-lane');
  });

  test('the scan releases the row it recovered, so it is not offered twice', async () => {
    const { agent } = orchestratorHarness();

    // Exactly what a dead activation leaves: the row `runFiber` wrote, with no
    // live body behind it. Seeded rather than run, because a fiber running in
    // THIS process deletes its own row on the way out.
    agent.harnessSeedOrphanFiber('evolution:settle', { lane: 'evolution:settle' });
    expect(agent.harnessOpenFiberRows()).toHaveLength(1);

    // The alarm's housekeeping pass — no request, no socket, no client.
    await agent.harnessAlarmHousekeeping();

    // Nothing left interrupted after a successful re-drive: the acceptance
    // property, observed on the row rather than on the return value. A hook
    // that threw would leave the row here and be re-offered every boot for 24h.
    expect(agent.harnessOpenFiberRows()).toEqual([]);

    // And a second pass has nothing to do, which is what "converges" means.
    await agent.harnessAlarmHousekeeping();
    expect(agent.harnessOpenFiberRows()).toEqual([]);
  });
});

describe('a sandbox lifecycle failure', () => {
  const incident = {
    incidentId: 'inc-1',
    stage: 'checkpoint' as const,
    reason: 'mksquashfs exited 1',
  };

  test('becomes ONE blocker turn however many times the container retries', async () => {
    const { agent } = orchestratorHarness();
    const submitted = recordSubmissions(agent);

    const first = await agent.acceptSandboxLifecycleFailure(incident);
    const second = await agent.acceptSandboxLifecycleFailure(incident);
    const third = await agent.acceptSandboxLifecycleFailure(incident);

    expect(first).toMatchObject({ status: 'queued', incidentId: 'inc-1', duplicate: false });
    expect(second).toMatchObject({ status: 'queued', duplicate: true });
    expect(third).toMatchObject({ status: 'queued', duplicate: true });
    // One admitted turn, and its durable message id is derived from the
    // incident id — so even a delivery the ledger did not collapse would land
    // on the row the first one wrote.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain(sandboxLifecycleIncidentKey('inc-1'));
  });

  test('a delivery that never landed is re-deliverable, which is what ends the retry loop', async () => {
    const { agent } = orchestratorHarness();
    // The seam's `undelivered` outcome: the host pre-empted the turn.
    Object.defineProperty(agent, 'submitMessages', {
      configurable: true,
      value: async () => ({
        submissionId: 'sub-x', status: 'aborted' as const, createdAt: Date.now(), accepted: true,
      }),
    });

    const refused = await agent.acceptSandboxLifecycleFailure(incident);
    expect(refused).toMatchObject({ status: 'queued', signal: 'undelivered', duplicate: false });

    const submitted = recordSubmissions(agent);
    const retried = await agent.acceptSandboxLifecycleFailure(incident);

    // NOT reported as a duplicate: nothing had been announced, so the retry is
    // the first announcement and the caller can stop retrying now.
    expect(retried).toMatchObject({ status: 'queued', signal: 'queued', duplicate: false });
    expect(submitted).toHaveLength(1);
  });

  test('the agent is told what the stage costs it, and the incident id, and nothing else', async () => {
    const { agent } = orchestratorHarness();
    const texts: string[] = [];
    Object.defineProperty(agent, 'submitMessages', {
      configurable: true,
      value: async (messages: { parts: { text?: string }[] }[]) => {
        texts.push(messages[0]?.parts[0]?.text ?? '');
        return { submissionId: 's', status: 'pending' as const, createdAt: Date.now(), accepted: true };
      },
    });

    await agent.acceptSandboxLifecycleFailure({
      incidentId: 'inc-2',
      stage: 'attach',
      reason: 'archive size 0 did not match the declared 918_224',
    });

    expect(texts).toHaveLength(1);
    const text = texts[0]!;
    // The consequence the agent has to act on, then the evidence.
    expect(text).toContain('attach stage');
    expect(text).toContain('Verify the workspace contents');
    expect(text).toContain('archive size 0 did not match the declared 918_224');
    expect(text).toContain('inc-2');
  });

  test('an envelope that invents a field is REFUSED, not silently stripped', async () => {
    const { agent } = orchestratorHarness();
    const submitted = recordSubmissions(agent);

    // The shape a caller reaches for when it wants to pass something the
    // contract has no field for. Stripping it would let the caller believe the
    // agent had read it.
    const rejected = await agent.acceptSandboxLifecycleFailure({
      ...incident,
      incidentId: 'inc-3',
      r2Key: 'backups/abc/data.sqsh',
    });

    expect(rejected.status).toBe('rejected');
    expect(submitted).toEqual([]);
  });

  test('every stage the CONTAINER can emit is queued, not rejected', async () => {
    // Driven from the PRODUCER's list, which is the whole point. The two sides
    // used to keep separate ones — Devbox emitted `attach` and `checkpoint`,
    // this schema admitted neither — so both classes of failure the seam exists
    // for were answered `rejected`, frozen in the container's ledger as a
    // caller defect, never retried and never seen by the agent. A test that
    // iterated the CONSUMER's list agreed with itself and saw none of it.
    const { agent } = orchestratorHarness();
    const texts: string[] = [];
    Object.defineProperty(agent, 'submitMessages', {
      configurable: true,
      value: async (messages: { parts: { text?: string }[] }[]) => {
        texts.push(messages[0]?.parts[0]?.text ?? '');
        return { submissionId: 's', status: 'pending' as const, createdAt: Date.now(), accepted: true };
      },
    });

    for (const stage of INCIDENT_STAGES) {
      const answer = await agent.acceptSandboxLifecycleFailure({
        incidentId: `inc-${stage}`, stage, reason: 'measured failure',
      });
      expect({ stage, status: answer.status }).toEqual({ stage, status: 'queued' });
    }

    // Both directions of the same equality: the schema admits every stage the
    // container emits, and admits nothing it does not.
    expect([...SANDBOX_LIFECYCLE_STAGES]).toEqual([...INCIDENT_STAGES]);
    // The denominator: a stage admitted by the schema with no consequence
    // written for it would render as `undefined` in the agent's own turn.
    expect(texts).toHaveLength(INCIDENT_STAGES.length);
    for (const text of texts) expect(text).not.toContain('undefined');
  });

  test('a stage outside the closed set is refused rather than given a generic consequence', async () => {
    const { agent } = orchestratorHarness();
    const answer = await agent.acceptSandboxLifecycleFailure({
      incidentId: 'inc-4', stage: 'defrost', reason: 'measured failure',
    });
    expect(answer.status).toBe('rejected');
  });
});

describe('whether the container may be disturbed', () => {
  test('idle means idle', async () => {
    const { agent } = orchestratorHarness();
    expect(await agent.hasSandboxBackgroundWork()).toBe(false);
  });

  test('a running detached job counts, because it may hold the container', async () => {
    const { agent } = orchestratorHarness();
    agent.harnessJobs().create({
      id: 'bgjob-live', kind: 'run', workMode: 'build',
      input: JSON.stringify({ command: 'npm test' }), now: Date.now(), label: 'npm test',
    });
    expect(await agent.hasSandboxBackgroundWork()).toBe(true);
  });

  test('a settled job does not', async () => {
    const { agent } = orchestratorHarness();
    const jobs = agent.harnessJobs();
    jobs.create({
      id: 'bgjob-done', kind: 'run', workMode: 'build',
      input: JSON.stringify({ command: 'npm test' }), now: Date.now(), label: 'npm test',
    });
    jobs.settle('bgjob-done', jobs.epochOf('bgjob-done') ?? 0, '"ok"', Date.now());
    expect(await agent.hasSandboxBackgroundWork()).toBe(false);
  });

  test('a live turn counts — it is the most likely caller of a container tool', async () => {
    const { agent } = orchestratorHarness();
    agent.declareTurnInFlight(true);
    expect(await agent.hasSandboxBackgroundWork()).toBe(true);
  });

  test('an unreachable subordinate counts, because unknown is not idle', async () => {
    const { agent } = orchestratorHarness();
    agent.harnessRoster().create({
      name: 'helper',
      createdBy: 'orchestrator', status: 'working', currentTask: 'building in the container',
      createdAt: Date.now(), dismissedAt: null,
    });

    // The harness `subAgent` stub refuses every call, which is exactly the
    // shape of a facet that cannot be reached. A root that read that as "idle"
    // would clear a container its own subordinate is building in.
    expect(await agent.hasSandboxBackgroundWork()).toBe(true);
  });
});
