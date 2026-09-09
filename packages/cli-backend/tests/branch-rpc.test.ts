// Two overlapping `explore` RPCs against one branch worker must each resolve
// to their own result. Matching a reply to a waiter by method name alone lets
// the first arriving reply settle every same-method waiter.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createBranchSpawner } from '../src/branch-process';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { initActorStateSchema } from '@kinu.run/core';
const dir = mkdtempSync(join(tmpdir(), 'kinu-branch-rpc-'));
const parentDbPath = `${dir}.db`;
const parentDb = new Database(parentDbPath, { create: true });
const parentRuntime = createCLIRuntime(parentDb, { dbPath: parentDbPath, llm: null, hostRoot: null, agentName: 'branch-parent' });
initActorStateSchema(makeWorkspaceSchemaSql(parentDb));

afterAll(() => {
  parentDb.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(parentDbPath, { force: true });
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
      // The first HTTP request belongs to the first explore. It answers
      // slowly, so the second explore's reply arrives over IPC first.
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
  // The spawner is handed the workspace's ONE database, not a base path it
  // decorates: `branch-worker.ts` refuses a `KINU_ROOT_DB` its root-issued
  // bootstrap does not name, so a fixture that passes anything else gets a
  // child that exits before `ready` and a startup rejection instead of a reply.
  const { spawn } = createBranchSpawner(parentDbPath, { llm, parent: parentRuntime.actor });
  const handle = await spawn('rpc-correlation');
  try {
    const first = handle.explore([{ role: 'user', content: 'first task' }], [], LANGUAGES, 'plan', []);
    const second = handle.explore([{ role: 'user', content: 'second task' }], [], LANGUAGES, 'plan', []);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.text).toBe(FIRST_TEXT);
    expect(secondResult.text).toBe(SECOND_TEXT);
  } finally {
    await handle.release();
    await server.stop(true);
  }
}, 30_000);
