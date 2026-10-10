/** What an agent is, read from its row (design v2 §9): every path that decides by kind reads this. */
import { describe, expect, test } from 'bun:test';
import { actorPolicy } from '../src/index';

describe('actorPolicy', () => {
  test("the workspace's own agent has no hirer and hands its turns to the workspace", () => {
    expect(actorPolicy({ parentActorId: null, origin: 'system' })).toEqual({ hirer: null, workspaceAgent: true });
  });

  test('a hire answers its hirer and keeps its turns', () => {
    for (const origin of ['user', 'agent', 'swarm', 'evolution'] as const) {
      expect(actorPolicy({ parentActorId: 'hirer-id', origin })).toEqual({ hirer: 'hirer-id', workspaceAgent: false });
    }
  });
});
