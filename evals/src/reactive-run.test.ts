import { basename, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { DEV_IDENTITY_ACCOUNT_HEADER } from '@kinu.run/core';
import { evalMatrix } from './config';
import { runArm } from './reactive-run';
import { trialSlot } from './slot';

test('each reactive arm and seed prepares its own real-runner slot before creating a workspace', async () => {
  const requests: Array<{ method: string; path: string; account: string | null }> = [];

  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(request) {
      const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER);
      requests.push({ method: request.method, path: new URL(request.url).pathname, account });

      return Response.json({ entries: [{ name: `eval-held-${account}`, lastVisited: Date.now() }], nextCursor: null });
    },
  });

  const runner = basename(resolve(import.meta.dir, '../reactive/reactive.run.ts'));

  const matrix = evalMatrix({
    KINU_EVAL_MODELS: 'opencode-go/muse', KINU_EVAL_ARMS: 'learning-on,learning-off', KINU_EVAL_TRIALS: '3',
  }, ['learning-on', 'learning-off']);

  try {
    for (const seed of [1, 2, 3]) {
      await Promise.all((['learning-on', 'learning-off'] as const).map(async (arm) => {
        const account = trialSlot({ taskFiles: [runner], task: runner, matrix, model: 'opencode-go/muse', arm, trial: seed });
        await expect(runArm({
          target: { origin: server.url.origin, identity: { kind: 'loopback' } },
          account, model: 'opencode-go/muse', arm, seed, plan: [], tasks: new Map(),
        })).rejects.toThrow(`eval-held-${account}`);
      }));
    }

    expect(requests.map((request) => request.account).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['trial-1', 'trial-2', 'trial-3', 'trial-4', 'trial-5', 'trial-6']);
    expect(requests.every((request) => request.method === 'GET' && request.path === '/api/user/workspaces')).toBe(true);
  } finally {
    await server.stop(true);
  }
});
