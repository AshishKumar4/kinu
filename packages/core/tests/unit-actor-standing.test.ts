import { expect, test } from 'bun:test';
import { actorStanding } from '../src/identity/workspace-actors';

test('an actor is live until its retirement starts, retiring until deleted, and retired once deleted', () => {
  expect(actorStanding({ retiringAt: null, deletedAt: null })).toBe('live');
  expect(actorStanding({ retiringAt: 1, deletedAt: null })).toBe('retiring');
  expect(actorStanding({ retiringAt: 1, deletedAt: 2 })).toBe('retired');
  // Deleted without a retirement first (a cancelled creation) is retired, not live.
  expect(actorStanding({ retiringAt: null, deletedAt: 2 })).toBe('retired');
});
