import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-provider-wait', ['provider-wait']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('a wait on the provider shows over the composer only while it holds a turn (#88)', () => {
  test("a background call's wait, the workspace's logo drawn from Settings, shows nothing in its chat", () => {
    expect(verdictOf(observed.providerWait, 'provider-wait').whileLogoWaited).toEqual([]);
  });

  test("a turn's own wait shows while it waits", () => {
    expect(verdictOf(observed.providerWait, 'provider-wait').duringTurn.length).toBeGreaterThan(0);
  });

  test('its countdown never reads 0s', () => {
    expect(verdictOf(observed.providerWait, 'provider-wait').duringTurn.filter((text) => /\b0s\b/u.test(text))).toEqual([]);
  });

  test('it is gone once the turn has answered', () => {
    expect(verdictOf(observed.providerWait, 'provider-wait').afterTurn).toEqual([]);
  });
});
