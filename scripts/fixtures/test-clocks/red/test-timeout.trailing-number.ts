// A duration handed to the runner, through a chain.
import { describe, test } from 'bun:test';

const SLOW_MS = 30_000;

describe('a suite', () => {
  test('a case', async () => { await Promise.resolve(); }, 15_000);
  test.skipIf(false)('a named duration', async () => { await Promise.resolve(); }, SLOW_MS);
});
