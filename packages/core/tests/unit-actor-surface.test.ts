/**
 * Every caller of an actor reaches the namespaces the actor's own programs reach, less what its policy declares: a
 * slate's call saves nothing through web, delegates nothing and keeps no state; a crafted tool a slate runs delegates
 * nothing; a confined copy reaches its memory, files and tasks only as native tools; and every caller reads the actor
 * as it is when its list is built, its executors and its role switch included.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { createMemoryVfs, createTestRuntime } from '@kinu.run/test-utils';
import {
  actorNamespaces, callOperation, SURFACE_POLICY, TurnContextBudget, WORKSPACE_ROOT,
  type ExecutorProviderSurface, type RoleSwitch, type SurfaceActor, type SurfacePolicy,
} from '../src/index';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { conversationsFor } from './helpers';

const SHOT = { url: 'https://example.com/', retrievedAt: '2026-10-08T00:00:00.000Z', bytes: new Uint8Array([137, 80, 78, 71]) };

const WORKSPACE: ExecutorProviderSurface = {
  name: 'workspace', positionalArgs: true,
  tools: { readFile: { description: 'Read a file', planAllowed: true, execute: async () => 'contents' } },
};

const unreached = async (): Promise<never> => { throw new Error('not reached by this suite'); };

function actorWith(input: { executors?: ExecutorProviderSurface[]; roleSwitch?: RoleSwitch | null } = {}): SurfaceActor {
  const { rt, stores } = createTestRuntime();

  return {
    executors: () => input.executors ?? [],
    web: { search: { search: unreached, fetch: unreached, render: unreached, screenshot: async () => SHOT }, files: { vfs: createMemoryVfs().vfs, home: WORKSPACE_ROOT }, browser: null },
    memory: () => ({ memory: rt.memory, facts: stores.facts, actor: rt.actor, conversations: conversationsFor(rt, stores.history), vectorStore: null }),
    files: () => ({ vfs: rt.toolFiles, home: rt.storage.home, planes: rt.planes, memory: rt.memory, ledger: new TurnFileLedger(), budget: new TurnContextBudget() }),
    tasks: () => ({ list: stores.taskList, config: stores.config, roleSwitch: input.roleSwitch ?? null }),
    db: stores.appData,
    programState: rt.actor.programState,
    agents: () => ({ mode: 'build', swarms: false }),
    self: null,
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
    confined: named(actor, SURFACE_POLICY.confined),
    noInbox: named({ ...actor, agents: null }, SURFACE_POLICY.program),
  }).toEqual({
    program: ['state', 'agents', 'memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    operations: ['state', 'agents', 'memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    slate: ['memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    slateTool: ['state', 'memory', 'file', 'tasks', 'db', 'web', 'workspace'],
    confined: ['state', 'db', 'web', 'workspace'],
    noInbox: ['state', 'memory', 'file', 'tasks', 'db', 'web', 'workspace'],
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
