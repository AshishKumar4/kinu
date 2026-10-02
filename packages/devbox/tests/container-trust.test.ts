// SDK audit (c), 2026-10-01: the trust step runs where the SDK docs run it, after the intercepts.
import { expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, harness } from './support/devbox-harness';

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }
}

test('a started container trusts the intercept CA once, after its HTTPS intercept', async () => {
  const { box, container } = harness(TestBox);
  await box.devboxStartup();

  expect(container.sequence.filter((step) => step === 'intercept:https' || step === 'trust')).toEqual(['intercept:https', 'trust']);
});
