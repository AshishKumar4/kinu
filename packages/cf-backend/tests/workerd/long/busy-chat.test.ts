/**
 * Socket intake measured on workerd: a held provider call keeps a REAL actor
 * busy while one raw `cf_agent_use_chat_request` goes out on its socket —
 * the frame the composer sends, not an RPC beside it.
 *
 * The oracles are the surface's own: the `queued` steer_status that admits
 * the request while the turn still runs, the reservation the admission wrote
 * under the CLIENT's message id, the done frame that answers the request
 * once the words landed, the `steer_status` landing the object broadcast to
 * the socket, the provider requests, and the assistant rows the drive ended
 * with. A regression here is the words opening a SECOND turn behind the
 * running one, landing under an id the client never rendered — both of
 * which the pane shows as a bubble that never resolves — or a landing
 * claimed at admission, before the turn decided it.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('a raw steer lands under its client id while a turn runs', async () => {
  const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('raw-steer-driver'));
  const result = await root.rawChat();

  // Announced AT ONCE, while the provider call was still parked: the running
  // turn's inbox took the words under the client's id.
  expect(result.admission).toBe('queued');

  // Accepted for the running turn, under the id the client minted: the
  // reservation exists while the turn is held, and nothing was written to
  // the transcript as a turn of its own.
  expect(result.pendingIds).toEqual(['raw-client-id']);
  expect(result.persistedWhileHeld).toBe(false);

  // Answered once the held turn's next step took the words: the request is
  // spent with the landing the turn decided, not one guessed at admission.
  expect(result.landing).toBe('mid-turn');

  // The socket's own report of WHERE they landed: the running turn's second
  // step, under that same id.
  expect(result.landed).toEqual([{ id: 'raw-client-id', text: 'RAW-STEER', atStep: 1 }]);

  // Two provider calls — the held first step and the step the steer landed
  // at, carrying the words — and one answer: no second turn was opened.
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]?.users).not.toContain('RAW-STEER');
  expect(result.calls[1]?.users).toContain('RAW-STEER');
  expect(result.answerCount).toBe(1);
});
