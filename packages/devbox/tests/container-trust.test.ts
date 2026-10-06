// SDK audit (c), 2026-10-01: the trust step runs where the SDK docs run it, after the intercepts.
import { TestDevbox } from './support/test-devbox';
import { expect, test } from 'bun:test';

import { harness } from './support/devbox-harness';

test('a started container trusts the intercept CA once, after its HTTPS intercept', async () => {
  const { box, container } = harness(TestDevbox);
  await box.devboxStartup();

  expect(container.sequence.filter((step) => step === 'intercept:https' || step === 'trust')).toEqual(['intercept:https', 'trust']);
});
