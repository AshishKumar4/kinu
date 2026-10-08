import { seedTranscriptEntry } from '@kinu.run/test-utils';
/**
 * What a fresh activation does with an interrupted drain lease or terminal transition; every case drives a real restart.
 * Terminal ledger: unit-durable-terminal.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  armedWakes, historyOver, ledgerOver, orchestratorHarness, until, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { TERMINAL_RETRY_JOB } from '../src/wake-jobs';
import { CHAT_SESSION_ID } from '@kinu.run/core';

/** One admitted event bound to a synthetic drain turn with its lease open. Filed under the workspace's own
 *  actor: a row under any other id is invisible to actor-scoped reads, so assertions would hold vacuously. */
function boundDelivery(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  eventId: string,
  drainTurnId: string,
  consumedAt: number,
): void {
  harness.db.prepare(
    `INSERT INTO agent_log
       (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
        trust, priority, payload_visibility, payload, received_at,
        dedupe_key, consumed_at)
     VALUES (?, ?, 'event', ?, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
             'authenticated', 'normal', 'full',
             '{"webhook_id":"w1","http_method":"POST","http_headers":{},"body":{"x":1},"delivery_id":"d1"}',
             1, NULL, ?)`,
  ).run(workspaceMainActor(harness.db).actorId, eventId, drainTurnId, consumedAt);
}

/** The transcript pair a resumed reply reads: the drain turn's user entry and its assistant answer. */
async function persistedDrainTurn(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  drainTurnId: string,
  answer: string | null,
): Promise<void> {
  const history = historyOver(harness);
  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: `u-${drainTurnId}`, origin: 'input',
    message: { role: 'user', content: '1 event arrived while you were idle.' }, metadata: { kinuEvent: 'event_drain', drainTurnId } });

  if (answer === null) return;
  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id: `a-${drainTurnId}`, origin: 'output',
    message: { role: 'assistant', content: answer } });
}

/** A prior activation's open claim for `turnId`'s answer, as core writes it. */
function openTransition(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId: 'a-1' });
}

/** `done` once the object closed the sequence; a still-open one answers `resumed`. */
function transitionState(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId: 'a-1' });
}

/** Activation classifies owed work by arming the retry wake and dispatching nothing. */
async function activateAndClassify(harness: ActorHarness<HarnessOrchestratorAgent>): Promise<void> {
  await harness.agent.activateActor();
  await until(() => armedWakes(harness.db).some((wake) => wake.id === TERMINAL_RETRY_JOB),
    'the activation armed the terminal retry wake');
}

/** Inside the sweep's grace, so the sweep leaves it alone and only the resume is under test. */
const RECENT = Date.now();

function lease(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  eventId: string,
): { turn_id: string | null; consumed_at: number | null } {
  return v.parse(
    v.object({ turn_id: v.nullable(v.string()), consumed_at: v.nullable(v.number()) }),
    harness.db.query(`SELECT turn_id, consumed_at FROM agent_log WHERE id = ?`).get(eventId),
  );
}

describe('an interrupted terminal transition finishes the reply it still owed', () => {

  /** Negative control: a lease whose turn produced no answer must stay open to be re-asked. */
  test('a lease whose turn never answered is left open for the sweep to re-ask', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-silent', 'evt-silent', RECENT);
    await persistedDrainTurn(harness, 'evt-silent', null);
    openTransition(harness, 'u-silent');
    // Without this, a row filed under another actor would read as no row and the case would pass vacuously.
    await activateAndClassify(harness);

    // The full wake frame (stale-lease sweep, then replay), not `resumeAll()` alone.
    await harness.agent.terminalRetryPass();

    expect(lease(harness, 'ev-silent')).toEqual({ turn_id: 'evt-silent', consumed_at: RECENT });
  });

  test('an empty answer does not count as a reply', async () => {
    const harness = orchestratorHarness();
    boundDelivery(harness, 'ev-blank', 'evt-blank', RECENT);
    await persistedDrainTurn(harness, 'evt-blank', '   ');
    openTransition(harness, 'u-blank');
    await activateAndClassify(harness);

    await harness.agent.terminalRetryPass();

    expect(lease(harness, 'ev-blank')).toEqual({ turn_id: 'evt-blank', consumed_at: RECENT });
  });

  test('an unfinished transition with nothing to resume stops being re-offered', async () => {
    const harness = orchestratorHarness();
    openTransition(harness, 'u-nothing');

    await harness.agent.terminalRetryPass();

    expect(transitionState(harness, 'u-nothing')).toBe('done');
  });

});

/** A start never replays: replaying there holds the object's gate into platform cancellation with the rows still owed. */
describe('an interrupted terminal transition arms the durable wake rather than replaying', () => {
  test('the activation classifies and arms; the replay happens under the wake', async () => {
    const harness = orchestratorHarness();
    expect(openTransition(harness, 'u-owed')).toBe('first');

    await activateAndClassify(harness);

    // The claim is still open once the start is over: no replay ran in it.
    expect(harness.db.query<{ result_json: string | null }, []>(
      "SELECT result_json FROM tool_effect_claims WHERE normalized_call_id LIKE 'terminal:response:%'",
    ).all().map((row) => row.result_json)).toEqual([null]);

    await harness.agent.terminalRetryPass();

    expect(transitionState(harness, 'u-owed')).toBe('done');
  });
});
