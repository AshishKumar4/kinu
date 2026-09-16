// A timing assertion: a comparison against the machine's speed.
import { expect } from 'bun:test';

export async function measure(run: () => Promise<void>): Promise<void> {
  const started = performance.now();
  await run();
  expect(performance.now() - started).toBeLessThan(500);
}
