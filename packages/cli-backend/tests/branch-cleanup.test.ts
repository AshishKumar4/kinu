// S18 acceptance, over the ONE workspace database: a branch is a
// `workspace_actors` row that runs its rollouts in a separate OS process, and
// it opens NO store of its own. So there is no longer a per-branch `<key>.db`
// under a `branches/` directory to be swept after the worker exits — the claim
// is stronger now, "never written at all", and the residue that CAN outlive a
// branch is its directory row. After the worker exits — success, abort, or a
// startup refusal — that row has given up its name and no file bears the
// branch's physical key.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { JsonValueSchema } from '@kinu.run/core';
import * as v from 'valibot';
import { createBranchSpawner } from '../src/branch-process';
import { localActorDirectory } from '../src/actor-identity';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { initActorStateSchema } from '@kinu.run/core';
const dir = mkdtempSync(join(tmpdir(), 'kinu-branch-cleanup-'));
const parentDbPath = `${dir}.db`;
const parentDb = new Database(parentDbPath, { create: true });
const parentRuntime = createCLIRuntime(parentDb, { dbPath: parentDbPath, llm: null, hostRoot: null, agentName: 'branch-parent' });
initActorStateSchema(makeWorkspaceSchemaSql(parentDb));

afterAll(() => {
  parentDb.close();
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

/**
 * This branch's directory row, in whatever lifecycle state it is now in.
 *
 * Read through the directory THE ROOT HANDLE WAS ISSUED BY, never a second
 * `WorkspaceActorDirectory` over the same file: a handle carries the authority
 * of its issuer, so a fresh instance is a second authority over one workspace
 * — and it has to invent an `ownerUserId` the workspace already records.
 */
function branchRow(branchId: string) {
  const { directory } = localActorDirectory(parentRuntime.actor);
  return directory.apply(parentRuntime.actor, [], { action: 'resolveCreation', creationId: branchId });
}

/** Everything in this fixture's own tree named for the branch's physical key —
 *  a per-branch store and its WAL sidecars, if the branch had one. It never has
 *  one now, which is why this is asserted while the worker is LIVE as well as
 *  after it exits: the old shape passed the second check by having its
 *  directory deleted, and that is not the same claim. */
function branchStores(storageKey: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter((entry) => entry.includes(storageKey));
}

test('a released branch leaves no store of its own and gives up its name', async () => {
  const endpoint = startModelEndpoint(200);
  try {
    // The workspace's ONE database, not a base path the spawner decorates:
    // `branch-worker.ts` refuses a `KINU_ROOT_DB` its root-issued bootstrap
    // does not name, so anything else is a child that exits before `ready`.
    const spawner = createBranchSpawner(parentDbPath, { llm: endpoint.llm, parent: parentRuntime.actor });
    const handle = await spawner.spawn('cleanup-success');
    const exploration = await handle.explore(HISTORY, [], LANGUAGES, 'build');
    // The rollout really ran, in the branch's own process, over that database.
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
  // A database path the root's own bootstrap does not name. The worker refuses
  // it and exits before `ready`, which is the startup failure this case is
  // about — and the only place a branch can still fail before doing any work.
  const spawner = createBranchSpawner(join(dir, 'missing-parent'), { llm: null, parent: parentRuntime.actor });
  await expect(spawner.spawn('cleanup-crash')).rejects.toThrow();
  const crashed = branchRow('cleanup-crash');
  // COMPENSATED, not left half-registered: a failed spawn retires and releases
  // the creation it admitted, so no roster read can see a branch whose process
  // never started.
  expect(crashed.state).toBe('deleted');
  expect(branchStores(crashed.storageKey)).toEqual([]);
});
