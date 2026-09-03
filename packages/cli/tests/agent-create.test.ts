import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceSlug } from '@kinu.run/core';
import {
  createCloudAgentFromMission,
  suggestAgentIdentityFromMission,
} from '../src/agent-create';
import type { CreateCloudAgentInput } from '../src/cloud-api';
import * as v from 'valibot';

describe('CLI mission workspace names', () => {
  test('uses the model-proposed title, over a slug the model never chose', async () => {
    const identity = await suggestAgentIdentityFromMission(
      'Build a benchmark for Rust web frameworks',
      {
        id: 'abcdef123456',
        generate: async () => JSON.stringify({ title: 'Rust Framework Benchmark' }),
      },
    );

    expect(identity).toEqual({
      name: workspaceSlug('abcdef123456'),
      displayName: 'Rust Framework Benchmark',
      nameOrigin: 'auto',
    });
  });

  test('keeps a neutral address when model naming is unavailable', async () => {
    // Mission text remains in the editable display name. The permanent URL
    // stays neutral even when the title generator is offline.
    const identity = await suggestAgentIdentityFromMission(
      'Review the OAuth callback flow',
      { id: '123456abcdef', generate: async () => { throw new Error('offline'); } },
    );

    expect(identity).toEqual({
      name: 'ironwood-elm-56abcdef',
      displayName: 'Review the OAuth callback flow',
      nameOrigin: 'auto',
    });
  });

  test('creates an unnamed cloud workspace with the generated name and display name', async () => {
    let createdInput: CreateCloudAgentInput | undefined;
    const created = await createCloudAgentFromMission(
      {
        purpose: 'Build a benchmark for Rust web frameworks',
        model: 'openai/gpt-5-mini',
        reasoningEffort: 'high',
      },
      {
        id: 'abcdef123456',
        generate: async () => JSON.stringify({ title: 'Rust Framework Benchmark' }),
        create: async (input) => {
          createdInput = input;
          return {
            name: input.name ?? 'missing-name',
            displayName: input.displayName ?? 'missing-display-name',
            createdAt: 1,
            lastVisited: 1,
            archivedAt: null,
          };
        },
      },
    );

    expect(createdInput).toEqual({
      name: workspaceSlug('abcdef123456'),
      displayName: 'Rust Framework Benchmark',
      purpose: 'Build a benchmark for Rust web frameworks',
      model: 'openai/gpt-5-mini',
      reasoningEffort: 'high',
    });
    expect(created).toMatchObject({
      name: workspaceSlug('abcdef123456'),
      displayName: 'Rust Framework Benchmark',
    });
  });

  test('preserves an explicit cloud workspace name', async () => {
    let createdInput: CreateCloudAgentInput | undefined;
    await createCloudAgentFromMission(
      {
        name: 'jarvis',
        displayName: 'Jarvis',
        nameOrigin: 'user',
        purpose: 'Manage my calendar',
      },
      {
        generate: async () => { throw new Error('explicit names must not be regenerated'); },
        create: async (input) => {
          createdInput = input;
          return {
            name: input.name ?? 'missing-name',
            displayName: input.displayName ?? 'missing-display-name',
            createdAt: 1,
            lastVisited: 1,
            archivedAt: null,
          };
        },
      },
    );

    expect(createdInput).toEqual({
      name: 'jarvis',
      displayName: 'Jarvis',
      purpose: 'Manage my calendar',
    });
  });
});

// Local workspace creation touches three planes — a directory, a database
// carrying identity/schema/config/role, and the visible ref — and a failure
// between them used to leave an `agent.db` nothing had a ref for, which the
// duplicate-name check then refused to create again. These pin the one
// authority that replaced that: `agent.db` exists if and only if the workspace
// was published, so every earlier await boundary either publishes or leaves
// nothing behind.
const CreateStateSchema = v.object({
  db: v.boolean(),
  partial: v.boolean(),
  wal: v.boolean(),
  shm: v.boolean(),
  ref: v.boolean(),
});

describe('local workspace creation publishes or leaves nothing', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'kinu-create-atomic-home-'));
  const PROJECT = mkdtempSync(join(tmpdir(), 'kinu-create-atomic-project-'));

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  /** config.ts binds KINU_HOME at module load, so the isolated home is only
   *  authoritative in a fresh process. */
  function run(scenario: string) {
    const result = Bun.spawnSync(['bun', '-e', scenario], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, KINU_HOME: HOME },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  /** Every on-disk trace a create can leave, read the way the CLI reads it. */
  const PRELUDE = `
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { Database } from 'bun:sqlite';
    import { createCliAgent } from './packages/cli/src/agent-create.ts';
    import { agentDbPath, resolveAgentRef } from './packages/cli/src/config.ts';
    const report = (name) => {
      const dbPath = agentDbPath(name);
      console.log(JSON.stringify({
        db: existsSync(dbPath),
        partial: existsSync(dbPath + '.partial'),
        wal: existsSync(dbPath + '.partial-wal'),
        shm: existsSync(dbPath + '.partial-shm'),
        ref: resolveAgentRef(name) !== null,
      }));
    };
  `;

  /** Every on-disk trace the scenario printed, parsed rather than asserted:
   *  each scenario emits its own first line then the state line. */
  function reported<First>(stdout: string, first: v.GenericSchema<First>) {
    const [head, tail] = stdout.trim().split('\n');
    return {
      first: v.parse(first, JSON.parse(head ?? '')),
      state: v.parse(CreateStateSchema, JSON.parse(tail ?? '')),
    };
  }

  test('a role the catalog refuses leaves no database, no partial and no ref', () => {
    const result = run(`
      ${PRELUDE}
      let failed = false;
      try {
        await createCliAgent({
          name: 'refused-role', displayName: 'Refused role', nameOrigin: 'user',
          purpose: 'Fail after the identity is written.', mode: 'local',
          cwd: ${JSON.stringify(PROJECT)}, workspaceId: 'atomic-workspace',
          role: 'no-such-role-in-any-catalog',
        });
      } catch {
        failed = true;
      }
      console.log(JSON.stringify({ failed }));
      report('refused-role');
    `);
    expect(result.exitCode, result.stderr).toBe(0);
    const { first: attempt, state } = reported(result.stdout, v.object({ failed: v.boolean() }));
    expect(attempt).toEqual({ failed: true });
    // No ghost: nothing on disk claims to be this workspace, and the name is
    // free again — the whole difference from the half-created state.
    expect(state).toEqual({ db: false, partial: false, wal: false, shm: false, ref: false });
  });

  test('a partial left by a killed create does not block the name, and the retry publishes', () => {
    const result = run(`
      ${PRELUDE}
      // Exactly what a SIGKILL mid-create leaves behind: an unpublished
      // database under the partial name, invisible to every reader.
      const dbPath = agentDbPath('killed-create');
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(dbPath + '.partial', 'truncated sqlite bytes');
      const created = await createCliAgent({
        name: 'killed-create', displayName: 'Killed create', nameOrigin: 'user',
        purpose: 'Retry after a kill.', mode: 'local',
        cwd: ${JSON.stringify(PROJECT)}, workspaceId: 'atomic-workspace',
      });
      console.log(JSON.stringify({ name: created.name }));
      report('killed-create');
    `);
    expect(result.exitCode, result.stderr).toBe(0);
    const { first: created, state } = reported(result.stdout, v.object({ name: v.string() }));
    expect(created).toEqual({ name: 'killed-create' });
    expect(state).toEqual({ db: true, partial: false, wal: false, shm: false, ref: true });
  });

  test('the published database is a complete, openable workspace', () => {
    const result = run(`
      ${PRELUDE}
      await createCliAgent({
        name: 'published-ws', displayName: 'Published', nameOrigin: 'user',
        purpose: 'Be complete at publication.', mode: 'local',
        cwd: ${JSON.stringify(PROJECT)}, workspaceId: 'atomic-workspace',
      });
      const db = new Database(agentDbPath('published-ws'), { readonly: true });
      const identity = db.query('SELECT name FROM workspace_identity LIMIT 1').get();
      const model = db.query("SELECT value FROM agent_config WHERE key = 'model'").get();
      db.close();
      console.log(JSON.stringify({ identity: identity?.name, model: Boolean(model?.value) }));
      report('published-ws');
    `);
    expect(result.exitCode, result.stderr).toBe(0);
    const { first: contents, state } = reported(
      result.stdout, v.object({ identity: v.string(), model: v.boolean() }),
    );
    // `workspace_identity.name` is the ADDRESS, so it is the slug and not the
    // title beside it. It used to be whichever of the two was non-empty, which
    // made `agentName()` answer with a title on every named workspace.
    expect(contents).toEqual({ identity: 'published-ws', model: true });
    expect(state).toEqual({ db: true, partial: false, wal: false, shm: false, ref: true });
  });
});
