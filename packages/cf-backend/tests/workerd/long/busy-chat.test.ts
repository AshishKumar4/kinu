/**
 * A raw `cf_agent_use_chat_request` sent while a held turn keeps a real actor busy must steer into that turn under
 * the client's message id, not open a second turn or claim its landing at admission.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('a raw steer lands under its client id while a turn runs', async () => {
  const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('raw-steer-driver'));
  const result = await root.rawChat();

  expect(result.admission).toBe('queued');

  expect(result.pendingIds).toEqual(['raw-client-id']);
  expect(result.persistedWhileHeld).toBe(false);

  // The landing is the one the turn decided, not guessed at admission.
  expect(result.landing).toBe('mid-turn');

  expect(result.landed).toEqual([{ id: 'raw-client-id', text: 'RAW-STEER', atStep: 1 }]);

  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]?.users).not.toContain('RAW-STEER');
  expect(result.calls[1]?.users).toContain('RAW-STEER');
  expect(result.answerCount).toBe(1);
});
