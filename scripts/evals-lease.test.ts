import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asFetchFunction } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { keysWindows } from './evals-lease';

const NOW = Date.parse('2026-10-19T12:31:23Z');

const keysPath = join(scratchDir('evals-lease-keys'), 'eval-provider-keys.json');

writeFileSync(keysPath, JSON.stringify({ 'opencode-go.bearer': 'go-key' }));

/** OpenCode Go's usage answer as it came on 2026-10-19, its 5h window at `rolling` percent. */
const usage = (rolling: number) => asFetchFunction(async () => Response.json({ usage: {
  rolling: { status: rolling >= 100 ? 'rate-limited' : 'ok', percent: rolling, resetsAt: '2026-10-19T15:07:10.000Z' },
  weekly: { status: 'ok', percent: 45, resetsAt: '2026-10-26T00:00:00.000Z' },
  monthly: { status: 'ok', percent: 70, resetsAt: '2026-11-08T13:59:31.000Z' },
} }));

// 2026-10-19: a 48-trial comparison spent the shared key's 5h window, and the release's evals would have started into it.
test('a run says what each eval key has left, and will not start into a spent window', async () => {
  const said: string[] = [];

  await expect(keysWindows((line) => said.push(line), { keysPath, fetch: usage(100), now: NOW }))
    .rejects.toThrow("opencode-go's 5h window is spent until 2026-10-19T15:07:10.000Z");
  expect(said.some((line) => line.includes('5h  100% used'))).toBe(true);
  await expect(keysWindows(() => {}, { keysPath, fetch: usage(60), now: NOW })).resolves.toBeUndefined();
});

// A run reads the windows again as it ends, so its own cost is measured: a window it spent is said, not refused.
test("a run's closing read says a spent window and refuses nothing", async () => {
  const said: string[] = [];

  await expect(keysWindows((line) => said.push(line), { keysPath, fetch: usage(100), now: NOW, refuseSpent: false })).resolves.toBeUndefined();
  expect(said.some((line) => line.includes('5h  100% used'))).toBe(true);
});
