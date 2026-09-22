// Overlapping `explore` RPCs must each resolve to their own result, not the first same-method reply.
import { scratchDir } from '../../test-utils/src/scratch';
import { test, expect, afterAll } from 'bun:test';
import { join } from 'node:path';


import { Database } from 'bun:sqlite';
import { createBranchSpawner } from '../src/branch-process';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { initActorStateSchema } from '@kinu.run/core';

const dir = scratchDir('branch-rpc');

const parentDbPath = join(dir, 'parent.db');

const parentDb = new Database(parentDbPath, { create: true });

const parentRuntime = createCLIRuntime(parentDb, { dbPath: parentDbPath, llm: null, agentName: 'branch-parent' });

initActorStateSchema(makeWorkspaceSchemaSql(parentDb));

afterAll(() => {
  parentDb.close();
});

const LANGUAGES: [string, ...string[]] = ['typescript'];

const FIRST_TEXT = 'first branch answer alpha';

const SECOND_TEXT = 'second branch answer beta';

function completionBody(text: string) {
  return {
    id: 'cmpl-branch-rpc',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

test('concurrent explores resolve to their own results', async () => {
  let seen = 0;

  const server = Bun.serve({
    port: 0,
    async fetch() {
      seen += 1;
      const mine = seen;

      // The first request answers slowly so the second reply arrives first.
      if (mine === 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));

        return Response.json(completionBody(FIRST_TEXT));
      }

      await new Promise((resolve) => setTimeout(resolve, 20));

      return Response.json(completionBody(SECOND_TEXT));
    },
  });

  const llm = {
    name: 'workers-ai',
    baseURL: `http://127.0.0.1:${String(server.port)}/v1`,
    headers: { Authorization: 'Bearer branch-rpc' },
    model: 'test-model',
  };

  // `branch-worker.ts` refuses a `KINU_ROOT_DB` its root-issued bootstrap does not name.
  const { spawn } = createBranchSpawner(parentDbPath, { llm, parent: parentRuntime.actor });
  const handle = await spawn('rpc-correlation');

  try {
    const first = handle.explore({ priorHistory: [{ role: 'user', content: 'first task' }], craftedTools: [], languages: LANGUAGES, mode: 'plan', siblings: [] });
    const second = handle.explore({ priorHistory: [{ role: 'user', content: 'second task' }], craftedTools: [], languages: LANGUAGES, mode: 'plan', siblings: [] });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.text).toBe(FIRST_TEXT);
    expect(secondResult.text).toBe(SECOND_TEXT);
  } finally {
    await handle.release();
    await server.stop(true);
  }
});
