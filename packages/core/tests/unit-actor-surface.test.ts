/**
 * Every caller of an actor reaches the namespaces the actor's own programs reach, less what its policy declares: a
 * slate's call saves nothing through web, delegates nothing and keeps no state; a crafted tool a slate runs delegates
 * nothing; a confined copy reaches its memory, files and tasks only as native tools; and every caller reads the actor
 * as it is when its list is built, its executors and its role switch included.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { createMemoryVfs, present } from '@kinu.run/test-utils';
import {
  actorNamespaces, callOperation, SURFACE_POLICY, TurnContextBudget, WORKSPACE_ROOT,
  type ExecutorProviderSurface, type RoleSwitch, type SurfaceActor, type SurfacePolicy,
} from '../src/index';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { conversationsFor, createTestRuntime } from './helpers';
import { inWorkMode } from '../src/execution/work-mode';

const SCRATCH = {
  name: 'scratch', scope: 'private',
  columns: [{ name: 'key', type: 'text', primaryKey: true }, { name: 'value', type: 'json' }],
} as const;

test('a slate cannot redeclare a private table name or learn its columns', async () => {
  const actor = actorWith();
  actor.db.createTable({ name: 'sealed', scope: 'private', columns: [{ name: 'confidential_column', type: 'json' }] });

  for (const policy of [SURFACE_POLICY.slate, SURFACE_POLICY.slateTool]) {
    const db = present(actorNamespaces(actor, policy).find(({ name }) => name === 'db'), 'the slate db');

    const answer = await present(db.tools.createTable, 'db.createTable').execute({
      name: 'sealed', scope: 'actor', columns: [{ name: 'public_column', type: 'text' }],
    });

    expect(answer).toMatchObject({ success: false, reason: 'denied', error: expect.stringContaining('sealed') });
    expect(JSON.stringify(answer)).not.toContain('confidential_column');
    expect(JSON.stringify(answer)).not.toContain('json');
    expect(answer).not.toHaveProperty('columns');
  }

  expect(actor.db.schema('sealed').columns).toEqual([{ name: 'confidential_column', type: 'json' }]);
});

const SHOT = { url: 'https://example.com/', retrievedAt: '2026-10-08T00:00:00.000Z', bytes: new Uint8Array([137, 80, 78, 71]) };

const WORKSPACE: ExecutorProviderSurface = {
  name: 'workspace', positionalArgs: true, capabilities: new Set(),
  tools: { readFile: { description: 'Read a file', planAllowed: true, execute: async () => 'contents' } },
};

const unreached = async (): Promise<never> => { throw new Error('not reached by this suite'); };

function actorWith(input: { executors?: ExecutorProviderSurface[]; roleSwitch?: RoleSwitch | null } = {}): SurfaceActor {
  const { rt, stores } = createTestRuntime();

  return {
    executors: () => input.executors ?? [],
    web: { search: { search: unreached, fetch: unreached, render: unreached, screenshot: async () => SHOT }, files: { vfs: createMemoryVfs().vfs, home: WORKSPACE_ROOT }, browser: null },
    memory: () => ({ memory: rt.memory, facts: stores.facts, actor: rt.actor, conversations: conversationsFor(rt), vectorStore: null }),
    files: () => ({ vfs: rt.toolFiles, home: rt.storage.home, planes: rt.planes, memory: rt.memory, ledger: new TurnFileLedger(), budget: new TurnContextBudget() }),
    tasks: () => ({ list: stores.taskList, config: stores.config, roleSwitch: input.roleSwitch ?? null }),
    db: stores.appData,
    agents: () => ({ mode: 'build', swarms: false }),
    self: null,
    ownerWaits: null,
  };
}

const named = (actor: SurfaceActor, policy: SurfacePolicy): string[] => actorNamespaces(actor, policy).map((provider) => provider.name);

const call = (actor: SurfaceActor, policy: SurfacePolicy, id: string, input: Record<string, string>) =>
  callOperation(actorNamespaces(actor, policy), id, input, { callId: crypto.randomUUID(), signal: undefined });

test("each caller reaches the actor's own namespaces, less what its policy declares", () => {
  const actor = actorWith({ executors: [WORKSPACE] });

  expect({
    program: named(actor, SURFACE_POLICY.program),
    operations: named(actor, SURFACE_POLICY.operations),
    slate: named(actor, SURFACE_POLICY.slate),
    slateTool: named(actor, SURFACE_POLICY.slateTool),
    noInbox: named({ ...actor, agents: null }, SURFACE_POLICY.program),
  }).toEqual({
    program: ['agents', 'memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    operations: ['agents', 'memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    slate: ['memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    slateTool: ['memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    noInbox: ['memory', 'file', 'tasks', 'db', 'web', 'workspace'],
  });
});

test("a slate's screenshot is saved nowhere, and the actor's own program saves one into its files", async () => {
  const actor = actorWith();

  const saved = async (policy: SurfacePolicy): Promise<boolean> => {
    const shot = await call(actor, policy, 'web.screenshot', { url: SHOT.url });

    return v.parse(v.object({ value: v.looseObject({ path: v.optional(v.string()) }) }), shot).value.path !== undefined;
  };

  expect({ slate: await saved(SURFACE_POLICY.slate), program: await saved(SURFACE_POLICY.program) }).toEqual({ slate: false, program: true });
});

test("a program switches the actor's role through the actor's own switch, and a hire's programs switch none", async () => {
  const asked: string[] = [];

  const roleSwitch: RoleSwitch = ({ to }) => {
    asked.push(to);

    return { kind: 'applied' };
  };

  await call(actorWith({ roleSwitch }), SURFACE_POLICY.program, 'tasks.switchRole', { role: 'planner' });

  expect(asked).toEqual(['planner']);
  await expect(call(actorWith(), SURFACE_POLICY.program, 'tasks.switchRole', { role: 'planner' })).rejects.toMatchObject({ code: 'unsupported' });
});

test('an executor is reached while it is attached: each build reads the actor as it is then', () => {
  const attached: ExecutorProviderSurface[] = [];
  const actor = actorWith({ executors: attached });
  const before = named(actor, SURFACE_POLICY.program);

  attached.push(WORKSPACE);

  expect({ before: before.includes('workspace'), after: named(actor, SURFACE_POLICY.program).includes('workspace') }).toEqual({ before: false, after: true });
});

for (const mode of ['build', 'plan'] as const) {
  test(`the program policy creates, writes, reads and batches private tables in ${mode}`, async () => {
    const actor = actorWith();
    const db = present(actorNamespaces(actor, SURFACE_POLICY.program).find((provider) => provider.name === 'db'), 'program db').tools;

    await inWorkMode(mode, async () => {
      expect(await present(db.createTable, 'db.createTable').execute(SCRATCH)).toMatchObject({ name: 'scratch', scope: 'private' });
      expect(await present(db.insert, 'db.insert').execute('scratch', [{ key: 'draft', value: { count: 1 } }])).toEqual({ rowsAffected: 1 });
      expect(await present(db.select, 'db.select').execute('scratch')).toEqual([{ key: 'draft', value: { count: 1 } }]);
      expect(await present(db.batch, 'db.batch').execute([
        { op: 'update', table: 'scratch', set: { value: { count: 2 } }, where: { key: 'draft' } },
        { op: 'insert', table: 'scratch', rows: [{ key: 'next', value: [3, 1, 2] }] },
      ])).toEqual([{ rowsAffected: 1 }, { rowsAffected: 1 }]);
      expect(await present(db.select, 'db.select').execute('scratch', { orderBy: [{ column: 'key', dir: 'asc' }] }))
        .toEqual([{ key: 'draft', value: { count: 2 } }, { key: 'next', value: [3, 1, 2] }]);
    });
  });
}

for (const policy of ['slate', 'slateTool'] as const) {
  test(`${policy} refuses every private-table operation and every batch item without exposing the table`, async () => {
    const actor = actorWith();
    actor.db.createTable(SCRATCH);
    actor.db.apply({ op: 'insert', table: 'scratch', rows: [{ key: 'secret', value: 'only the program sees this' }] });
    actor.db.createTable({ name: 'public_notes', scope: 'actor', columns: [{ name: 'note', type: 'text' }] });
    const db = present(actorNamespaces(actor, SURFACE_POLICY[policy]).find((provider) => provider.name === 'db'), `${policy} db`).tools;

    const privateCalls: readonly [string, unknown[]][] = [
      ['schema', ['scratch']], ['select', ['scratch']], ['count', ['scratch']],
      ['insert', ['scratch', [{ key: 'injected', value: 'stolen' }]]],
      ['update', ['scratch', { value: 'stolen' }, {}]], ['deleteRows', ['scratch', {}]], ['dropTable', ['scratch']],
    ];

    for (const [member, args] of privateCalls) {
      expect(await present(db[member], `db.${member}`).execute(...args)).toMatchObject({
        success: false, reason: 'denied', error: expect.stringContaining('scratch'),
      });
    }

    for (const privateFirst of [false, true]) {
      const shared = { op: 'insert', table: 'public_notes', rows: [{ note: 'must not land' }] };
      const hidden = { op: 'insert', table: 'scratch', rows: [{ key: 'injected', value: 'stolen' }] };
      expect(await present(db.batch, 'db.batch').execute(privateFirst ? [hidden, shared] : [shared, hidden]))
        .toMatchObject({ success: false, reason: 'denied', error: expect.stringContaining('scratch') });
    }

    expect(await present(db.listTables, 'db.listTables').execute()).toEqual([expect.objectContaining({ name: 'public_notes', scope: 'actor' })]);
    expect(await present(db.createTable, 'db.createTable').execute({ ...SCRATCH, name: 'another_secret' }))
      .toMatchObject({ success: false, reason: 'denied', error: expect.stringContaining('private') });
    expect(actor.db.listTables().map(({ name }) => name).sort()).toEqual(['public_notes', 'scratch']);
    expect(actor.db.count('public_notes')).toBe(0);
    expect(actor.db.select('scratch')).toEqual([{ key: 'secret', value: 'only the program sees this' }]);
  });
}
