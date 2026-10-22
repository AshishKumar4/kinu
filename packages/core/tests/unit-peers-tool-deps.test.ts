// Defends: the `peers` an agent's tools reach being one shape on both hosts. The cloud refused a typo as `missing` and
// the CLI killed the call with a plain error; a name is checked before a row is queued, and the owner is read per call.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { peersToolDeps } from '../src/tools/local-peer';
import type { PeerHub } from '../src/events/ingress/peer';

type Hub = Pick<PeerHub, 'ask' | 'send' | 'reply'>;

function hubRecording() {
  const asked: Array<{ readonly agent: string; readonly userId: string }> = [];

  const hub: Hub = {
    ask: async ({ agent, userId }) => {
      asked.push({ agent, userId });

      return { status: 'replied', from: agent, reply: 'ok' };
    },
    send: async ({ agent, userId }) => {
      asked.push({ agent, userId });

      return { status: 'queued', message_id: 'm1' };
    },
    reply: async () => ({ ok: true }),
  };

  return { hub, asked };
}

const FailureSchema = v.object({ code: v.string(), message: v.string() });

describe('the peers an agent reaches', () => {
  test('a name it cannot reach, or its own, is refused before anything is queued, in one shape', async () => {
    const { hub, asked } = hubRecording();
    let owner = 'owner-1';

    const peers = peersToolDeps(hub, {
      self: 'me', peers: async () => [{ name: 'scout', displayName: 'Scout' }], known: async (agent) => agent === 'scout',
      userId: () => owner, spawnWorkspace: async () => ({ agent: '', created: false, status: 'rejected', reason: 'no' }),
    });

    const refusals = await Promise.allSettled([
      peers.send({ agent: 'stranger', topic: 'task', message: 'hi', mode: 'build' }),
      peers.ask({ agent: 'me', topic: 'task', message: 'hi', mode: 'build' }),
    ]);

    expect(refusals.map((settled) => (settled.status === 'rejected' ? v.parse(FailureSchema, settled.reason).code : 'answered'))).toEqual(['missing', 'bad_input']);
    expect(asked).toEqual([]);

    await peers.send({ agent: 'scout', topic: 'task', message: 'hi', mode: 'build' });
    owner = 'owner-2';
    await peers.ask({ agent: 'scout', topic: 'task', message: 'hi', mode: 'build' });

    expect(asked).toEqual([{ agent: 'scout', userId: 'owner-1' }, { agent: 'scout', userId: 'owner-2' }]);
    expect(await peers.listPeers()).toEqual([{ name: 'scout', displayName: 'Scout' }]);
  });
});
