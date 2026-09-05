// Two overlapping `explore` RPCs against one branch worker must each resolve
// to their own result. The parent used to match a reply to a waiter by method
// name alone, so the first arriving reply settled every same-method waiter.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createBranchSpawner } from '../src/branch-process';

const dir = mkdtempSync(join(tmpdir(), 'kinu-branch-rpc-'));
const parentDbPath = `${dir}.db`;
const parentDb = new Database(parentDbPath, { create: true });
parentDb.exec('CREATE TABLE crafted_tools (name TEXT PRIMARY KEY, description TEXT NOT NULL)');
parentDb.exec('CREATE TABLE agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
parentDb.close();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(parentDbPath, { force: true });
  rmSync(`${dir}/branches`, { recursive: true, force: true });
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
  const { spawn, abort } = createBranchSpawner(dir, { llm });
  const handle = await spawn('rpc-correlation');
  try {
    const first = handle.explore([{ role: 'user', content: 'first task' }], [], LANGUAGES, 'plan', []);
    const second = handle.explore([{ role: 'user', content: 'second task' }], [], LANGUAGES, 'plan', []);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.text).toBe(FIRST_TEXT);
    expect(secondResult.text).toBe(SECOND_TEXT);
  } finally {
    await abort('rpc-correlation');
    await server.stop(true);
  }
}, 30_000);
