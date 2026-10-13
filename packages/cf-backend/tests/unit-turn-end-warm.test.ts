/**
 * A turn's end and its prompt's warm: main's isolate asks the workspace to arm the warm as its turn settles, and tells
 * the turn's end without waiting for that answer, which on deployed objects waits out the workspace's flush of it. The
 * next turn's preparation notes its request where the warm is armed, so it waits for the arming first.
 */
import { expect, test } from 'bun:test';
import { driveUntil, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { delayNextCacheWarm } from './helpers/agent-facets';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }], trigger: 'submit-message',
    }) },
  });
}

test("a turn ends in its room while its warm's arming is still on the way, and the next turn opens after it", async () => {
  let asked = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    asked += 1;

    return chatCompletion(run, 'Noted.');
  }));

  const { agent } = workspace;
  const { storageKey } = agent.agentOf(workspaceMainActor(workspace.db).actorId);
  const done = new Set<string>();

  // Each request closes at its turn's end; its done frame, sent to the socket that asked or to every tab, is the signal.
  const heard = (message: string): void => {
    const id = /"id":"([^"]+)"/u.exec(message)?.[1];

    if (id !== undefined && message.includes('"done":true')) done.add(id);
  };

  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      heard(message);
      fanout(message, exclude);
    },
  });
  const tab = (id: string) => socketConnection({ id, send: (data: string) => { heard(data); } });
  const warm = delayNextCacheWarm(storageKey);

  // The gate answers a request once its turn is done in the room, so each is awaited only after the turn was let run.
  const first = agent.harnessChatGate()(tab('conn-first'), chatRequest('first', 'First.'));

  let laps = 0;

  // Two hundred laps for the turn to end while its warm is held.
  await warm.reached;
  await driveUntil(workspace, 'the turn stopped short of its end and its laps', () => done.has('first') || ++laps > 200);
  expect(done.has('first')).toBe(true);
  await first;

  const firstAsked = asked;

  laps = 0;

  // The next turn is given two hundred laps to reach its model while the warm is still held: it must not.
  const second = agent.harnessChatGate()(tab('conn-second'), chatRequest('second', 'Second.'));

  await driveUntil(workspace, 'the next turn asked its model, or stopped, while the warm was held', () => asked > firstAsked || ++laps > 200);
  expect(asked).toBe(firstAsked);
  warm.release();
  await second;
  await driveUntil(workspace, 'the next turn did not end', () => done.has('second'));

  expect(asked).toBeGreaterThan(firstAsked);
});
