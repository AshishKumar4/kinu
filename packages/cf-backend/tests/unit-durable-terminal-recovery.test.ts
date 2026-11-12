import { seedTranscriptEntry } from '@kinu.run/test-utils';
/** Recovery dispatches an answered drain's reply from its agent's own durable conversation.
 *  Real interrupted inputs are exercised by workerd/wide/two-turn.test.ts. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  agentHistory, armedWakes, ledgerOver, orchestratorHarness, until, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { TERMINAL_RETRY_JOB } from '../src/wake-jobs';
import { CHAT_SESSION_ID } from '@kinu.run/core';

function boundDelivery(
  harness: ActorHarness<HarnessOrchestratorAgent>, eventId: string, drainTurnId: string, consumedAt: number,
): void {
  harness.db.prepare(`INSERT INTO agent_log
    (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
      trust, priority, payload_visibility, payload, received_at, dedupe_key, consumed_at)
    VALUES (?, ?, 'event', ?, 0, NULL, 'tr-1', 'webhook_bearer', 'webhook',
      'authenticated', 'normal', 'full',
      '{"webhook_id":"w1","http_method":"POST","http_headers":{},"body":{"x":1},"delivery_id":"d1"}', 1, NULL, ?)`)
    .run(workspaceMainActor(harness.db).actorId, eventId, drainTurnId, consumedAt);
}

/** D9 keeps this conversation in main's facet, where owedDrainReplies reads it. */
async function persistedDrainTurn(harness: ActorHarness<HarnessOrchestratorAgent>, drainTurnId: string, answer: string): Promise<void> {
  await harness.agent.getChatHistoryPage({ limit: 1 });
  const { history } = agentHistory(harness, workspaceMainActor(harness.db).actorId);

  await seedTranscriptEntry(history, CHAT_SESSION_ID, {
    id: `programmatic:${drainTurnId}`, origin: 'input',
    message: { role: 'user', content: '1 event arrived while you were idle.' }, metadata: { kinuEvent: 'event_drain', drainTurnId },
  });
  await seedTranscriptEntry(history, CHAT_SESSION_ID, {
    id: `a-${drainTurnId}`, origin: 'output', message: { role: 'assistant', content: answer },
  });
}

function openTransition(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId: 'a-1' });
}

function transitionState(harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId: 'a-1' });
}

async function activateAndClassify(harness: ActorHarness<HarnessOrchestratorAgent>): Promise<void> {
  await harness.agent.activateActor();
  await until(() => armedWakes(harness.db).some((wake) => wake.id === TERMINAL_RETRY_JOB), 'the activation armed the terminal retry wake');
}

function lease(harness: ActorHarness<HarnessOrchestratorAgent>, eventId: string): { turn_id: string | null; consumed_at: number | null } {
  return v.parse(
    v.object({ turn_id: v.nullable(v.string()), consumed_at: v.nullable(v.number()) }),
    harness.db.query('SELECT turn_id, consumed_at FROM agent_log WHERE id = ?').get(eventId),
  );
}

describe('an interrupted terminal transition finishes the reply it still owed', () => {
  // The nonempty control proves this fixture reaches recovery's reader, rather than an unused workspace transcript.
  for (const answer of ['   ', 'the build passed']) {
    test(answer.trim() === '' ? 'an empty answer does not count as a reply' : 'a recorded answer closes the lease without asking again', async () => {
      const harness = orchestratorHarness();
      const consumedAt = Date.now();

      boundDelivery(harness, 'ev-answer', 'evt-answer', consumedAt);
      await persistedDrainTurn(harness, 'evt-answer', answer);
      openTransition(harness, 'u-answer');
      await activateAndClassify(harness);
      await harness.agent.terminalRetryPass();

      expect(lease(harness, 'ev-answer')).toEqual({ turn_id: 'evt-answer', consumed_at: answer.trim() === '' ? consumedAt : null });
    });
  }

  test('an unfinished transition with nothing to resume stops being re-offered', async () => {
    const harness = orchestratorHarness();
    openTransition(harness, 'u-nothing');

    await harness.agent.terminalRetryPass();

    expect(transitionState(harness, 'u-nothing')).toBe('done');
  });
});

describe('an interrupted terminal transition arms the durable wake rather than replaying', () => {
  test('the activation classifies and arms; the replay happens under the wake', async () => {
    const harness = orchestratorHarness();
    expect(openTransition(harness, 'u-owed')).toBe('first');

    await activateAndClassify(harness);
    expect(harness.db.query<{ result_json: string | null }, []>(
      "SELECT result_json FROM tool_effect_claims WHERE normalized_call_id LIKE 'terminal:response:%'",
    ).all().map((row) => row.result_json)).toEqual([null]);
    await harness.agent.terminalRetryPass();

    expect(transitionState(harness, 'u-owed')).toBe('done');
  });
});
