import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asFetchFunction, workspaceSlug } from '@kinu.run/core';
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

describe('a cloud workspace name the hub refuses', () => {
  test('kinu create surfaces the hub\'s own limit, verbatim, and records no workspace', async () => {
    // The hub owns the address grammar (a preview hostname label, at most 31
    // characters); the CLI's job is to hand its refusal to the person unchanged.
    const refusal = 'Invalid workspace name: the workspace name "slate-acceptance-20260907-8898094b" cannot be a preview hostname label (a label holds lowercase letters, digits and hyphens, at most 31 characters, and carries no case)';
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input, init) => {
      seen.push(String(input) + ' ' + String(init?.method));
      return Response.json({ error: refusal }, { status: 400 });
    });
    try {
      const { createCloudAgent } = await import('../src/cloud-api');
      await expect(createCloudAgent('https://kinu.test', 'ptc_token', { name: 'slate-acceptance-20260907-8898094b', purpose: 'x' }))
        .rejects.toThrow(refusal);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen).toEqual(['https://kinu.test/api/cli/workspaces POST']);
  });
});

// Local workspace creation touches three planes — a directory, a database
// carrying identity/schema/config/role, and the visible ref — so a failure
// between them could leave an `agent.db` nothing has a ref for, and the
// duplicate-name check would then refuse to create that name again. These pin
// the ONE authority that makes it impossible: `agent.db` exists if and only if
// the workspace was published, so every earlier await boundary either
// publishes or leaves nothing behind.
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
      env: {
        ...process.env, HOME, KINU_HOME: HOME,
        KINU_BASE_URL: 'http://localhost:1/v1', KINU_AUTH: 'Bearer fixture', KINU_MODEL: 'fixture-model',
      },
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
      let failure = null;
      try {
        await createCliAgent({
          name: 'refused-role', displayName: 'Refused role', nameOrigin: 'user',
          purpose: 'Fail after the identity is written.', mode: 'local',
          cwd: ${JSON.stringify(PROJECT)}, workspaceId: 'atomic-workspace',
          role: 'no-such-role-in-any-catalog',
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({ failure }));
      report('refused-role');
    `);
    expect(result.exitCode, result.stderr).toBe(0);
    const { first: attempt, state } = reported(result.stdout, v.object({ failure: v.string() }));
    expect(attempt.failure).toContain('no-such-role-in-any-catalog');
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
      const model = db.query("SELECT value FROM actor_config WHERE key = 'model'").get();
      db.close();
      console.log(JSON.stringify({ identity: identity?.name, model: Boolean(model?.value) }));
      report('published-ws');
    `);
    expect(result.exitCode, result.stderr).toBe(0);
    const { first: contents, state } = reported(
      result.stdout, v.object({ identity: v.string(), model: v.boolean() }),
    );
    // `workspace_identity.name` is the ADDRESS, so it is the slug and not the
    // title beside it. Take whichever of the two is non-empty and `agentName()`
    // answers with a title on every named workspace.
    expect(contents).toEqual({ identity: 'published-ws', model: true });
    expect(state).toEqual({ db: true, partial: false, wal: false, shm: false, ref: true });
  });
});
