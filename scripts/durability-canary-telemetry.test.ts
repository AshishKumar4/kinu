import { expect, test } from 'bun:test';
import { canaryActivations } from './durability-canary-telemetry';

const startup = (timestamp: number, activation: number) => ({
  timestamp, source: { event: 'actor.startup', code: '', cause: '', fields: { activation } }, $workers: { scriptVersion: { id: 'v' } }, $metadata: {},
});

// Staging 2026-10-08: the canary's object started six times and telemetry kept four of the startup rows.
test('a dropped startup row is an activation still: the ordinals count it, at an unknown time', () => {
  const read = canaryActivations(null, [startup(10, 3), startup(40, 6), startup(20, 4)]);

  expect(read.map((activation) => [activation.ordinal, activation.at])).toEqual([[3, 10], [4, 20], [5, null], [6, 40]]);
  expect(canaryActivations([{ ordinal: 9, at: 5, version: null }], [startup(10, 3)])).toEqual([{ ordinal: 9, at: 5, version: null }]);
});
