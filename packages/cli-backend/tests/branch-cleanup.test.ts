// S18: a branch is a `workspace_actors` row in a separate process with no store of its own;
// after exit (success, abort, startup refusal) its row has released its name and no file bears its key.
import { scratchDir } from '../../test-utils/src/scratch';
import { test, expect, afterAll } from 'bun:test';
import { readdirSync } from 'node:fs';

import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { JsonValueSchema } from '@kinu.run/core';
import * as v from 'valibot';
import { createBranchSpawner } from '../src/branch-process';
import { localActorDirectory } from '../src/actor-identity';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { initActorStateSchema } from '@kinu.run/core';

const dir = scratchDir('branch-cleanup');

const parentDbPath = join(dir, 'parent.db');

const parentDb = new Database(parentDbPath, { create: true });

const parentRuntime = createCLIRuntime(parentDb, { dbPath: parentDbPath, llm: null, agentName: 'branch-parent' });

initActorStateSchema(makeWorkspaceSchemaSql(parentDb));

afterAll(() => {
  parentDb.close();
});

const HISTORY = [{ role: 'user', content: 'ship a parser' }];

const LANGUAGES: [string, ...string[]] = ['typescript'];

const wireBodySchema = v.record(v.string(), JsonValueSchema);

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

/** This branch's directory row, read through the directory the root handle was issued by; a second instance is a second authority. */
function branchRow(branchId: string) {
  const { directory } = localActorDirectory(parentRuntime.actor);

  return directory.apply(parentRuntime.actor, [], { action: 'resolveCreation', creationId: branchId });
}

/** Files named for the branch's physical key; asserted while live too, since "swept" is not "never written". */
function branchStores(storageKey: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter((entry) => entry.includes(storageKey));
}

test('a released branch leaves no store of its own and gives up its name', async () => {
  const endpoint = startModelEndpoint(200);

  try {
    // `branch-worker.ts` refuses a `KINU_ROOT_DB` its root-issued bootstrap does not name.
    const spawner = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawner.spawn('cleanup-success');
    const exploration = await handle.explore({ priorHistory: HISTORY, craftedTools: [], languages: LANGUAGES, mode: 'build' });
    expect(exploration.text).toContain('parse with a PEG');
    const live = branchRow('cleanup-success');
    expect(live.state).toBe('active');
    expect(branchStores(live.storageKey)).toEqual([]);
    await spawner.abort('cleanup-success');
    await handle.release();
    expect(branchStores(live.storageKey)).toEqual([]);
    expect(branchRow('cleanup-success').state).toBe('deleted');
  } finally {
    await endpoint.stop();
  }
});

test('a branch that is refused at startup leaves no live actor behind', async () => {
  // An unnamed database path: the worker exits before `ready`, the only pre-work failure a branch has.
  const spawner = createBranchSpawner(join(dir, 'missing-parent'), { llm: null, parent: parentRuntime.actor });
  await expect(spawner.spawn('cleanup-crash')).rejects.toThrow();
  const crashed = branchRow('cleanup-crash');
  // A failed spawn retires and releases the creation it admitted.
  expect(crashed.state).toBe('deleted');
  expect(branchStores(crashed.storageKey)).toEqual([]);
});
