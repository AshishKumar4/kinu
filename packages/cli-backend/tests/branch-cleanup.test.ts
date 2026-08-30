// S18 acceptance: a branch's trace SQLite is live-worker state ONLY. After the
// worker exits — success, abort, or failure — the store and every sidecar are
// gone from the branches directory.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { JsonValueSchema } from '@kinu.run/core';
import * as v from 'valibot';
import { createBranchSpawner } from '../src/branch-process';

const dir = mkdtempSync(join(tmpdir(), 'kinu-branch-cleanup-'));
const parentDbPath = `${dir}.db`;
const parentDb = new Database(parentDbPath, { create: true });
parentDb.exec('CREATE TABLE crafted_tools (name TEXT PRIMARY KEY, description TEXT NOT NULL)');
parentDb.exec('CREATE TABLE agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
parentDb.close();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(parentDbPath, { force: true });
});

const HISTORY = [{ role: 'user', content: 'ship a parser' }];
const LANGUAGES: [string, ...string[]] = ['typescript'];
const wireBodySchema = v.record(v.string(), JsonValueSchema);

/** An OpenAI-compatible endpoint whose status code each test chooses. */
function startModelEndpoint(status: number) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      v.parse(wireBodySchema, await request.json());
      if (status >= 400) {
        return Response.json({
          error: { message: 'upstream refused', type: 'server_error' },
        }, { status });
      }
      return Response.json({
        id: 'cmpl-branch-cleanup',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'one read-only approach: parse with a PEG and verify fixtures',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    },
  });
  return {
    stop: () => server.stop(true),
    llm: {
      name: 'workers-ai',
      baseURL: `http://127.0.0.1:${String(server.port)}/v1`,
      headers: { Authorization: 'Bearer branch-cleanup' },
      model: 'test-model',
    },
  };
}

function branchFiles(branchId: string, basePath = dir): string[] {
  const root = join(basePath, 'branches');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(`${branchId}.db`));
}

test('an aborted successful branch leaves no trace database behind', async () => {
  const endpoint = startModelEndpoint(200);
  try {
    const spawner = createBranchSpawner(dir, { llm: endpoint.llm });
    const handle = await spawner.spawn('cleanup-success');
    await handle.explore(HISTORY, [], LANGUAGES, 'build');
    expect(branchFiles('cleanup-success').length).toBeGreaterThan(0);
    await spawner.abort('cleanup-success');
    // The exit hook runs asynchronously after SIGTERM lands.
    for (let i = 0; i < 100 && branchFiles('cleanup-success').length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(branchFiles('cleanup-success')).toEqual([]);
  } finally {
    await endpoint.stop();
  }
});

test('a branch that crashes during startup leaves no trace database behind', async () => {
  const missingParent = join(dir, 'missing-parent');
  const spawner = createBranchSpawner(missingParent, { llm: null });
  await expect(spawner.spawn('cleanup-crash')).rejects.toThrow();
  for (let i = 0; i < 100 && branchFiles('cleanup-crash', missingParent).length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(branchFiles('cleanup-crash', missingParent)).toEqual([]);
});
