import { afterEach, expect, test } from 'bun:test';
import { accountCredentialKey, asFetchFunction, requestUrl } from '@kinu.run/core';
import {
  agentSql, catalogTurn, driveUntil, gatewayWorkspace, hostedSubordinateHarness, makeEnv, orchestratorHarness, wakeForDelegatedTask,
} from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const openingOf = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages.filter((message) =>
  message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context')));

const toolOutputs = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages.filter((message) => message.role === 'tool'));

test('a planner a Build turn hires cannot write files through the workspace', async () => {
  const path = '/tmp/plan-mode-leak.txt';

  const gateway = stubAiBinding((run) => {
    const answered = toolOutputs(run) !== '[]';

    if (openingOf(run).includes('Plan the change.')) {
      return answered ? chatCompletion(run, 'Planned.') : toolCallCompletion(run, { tool: 'file', args: { action: 'write', path, content: 'x' } }, 'call_leak');
    }

    return answered
      ? chatCompletion(run, 'Root waits.')
      : toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'planner', lifetime: 'task', mission: 'Plan the change.' } }, 'call_planner');
  });

  const workspace = gatewayWorkspace(gateway);
  const planner = () => gateway.runs.find((run) => openingOf(run).includes('Plan the change.') && toolOutputs(run) !== '[]');

  await catalogTurn(workspace.agent, 'Hire a planner.');
  await driveUntil(workspace, 'the planner never saw its write answered', () => planner() !== undefined);

  expect(toolOutputs(planner() ?? gateway.runs[0])).toContain('denied');
  expect(toolOutputs(planner() ?? gateway.runs[0])).not.toContain('created');
  const hired = workspace.db.query<{ id: string }, []>("SELECT actor_id AS id FROM workspace_actors WHERE origin = 'agent'").get()?.id ?? '';

  await driveUntil(workspace, "the planner's run never ended", () => agentSql(hired)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${hired} AND type = 'run_end'`[0]?.n === 1);
  expect(agentSql(hired)<{ payload: string }>`
    SELECT payload FROM run_events WHERE actor_id = ${hired} AND type = 'turn_end'`[0]?.payload).toContain('"workMode":"plan"');
});

test("a turn an agent's isolate loses to its own reset runs again, the workspace staying up", async () => {
  let asked = 0;

  const gateway = stubAiBinding(async (run) => {
    if (!openingOf(run).includes('Middle task.')) return chatCompletion(run, 'Root noted.');
    asked++;

    return asked === 1 ? await new Promise<Response>(() => {}) : chatCompletion(run, 'Middle done.');
  });

  const workspace = gatewayWorkspace(gateway);
  const middle = await hostedSubordinateHarness(workspace, { name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate' });
  const middleId = middle.actor.handle.actorId;

  const ended = (): number => agentSql(middleId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middleId} AND type = 'run_end'`[0]?.n ?? 0;

  await wakeForDelegatedTask(workspace, middleId, 'Middle task.');
  await driveUntil(workspace, "the agent's model was never asked", () => asked === 1);
  workspace.agent.harnessResetAgentIsolate(workspace.db.query<{ key: string }, [string]>(
    'SELECT storage_key AS key FROM workspace_actors WHERE actor_id = ?').get(middleId)?.key ?? '');
  await driveUntil(workspace, 'the lost turn never ran again', () => ended() > 0);

  expect(asked).toBe(2);
});

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

test("a hired agent's model call authenticates with the provider account the owner selected", async () => {
  const OWNER = 'abcdef0123456789abcdef0123456789';
  const MODEL = 'anthropic/claude-sonnet-4-5';
  const user = createTestUserDO({ durableObjectId: OWNER });
  const owner = await testOwner();

  await user.userDO.setCredential(owner, 'anthropic.bearer', { kind: 'bearer', token: 'sk-main' });
  await user.userDO.setCredential(owner, accountCredentialKey('anthropic.bearer', 'work'), { kind: 'bearer', token: 'sk-work' });
  const token = await provisionTestWorkspace(user, 'accounts', 'Accounts');
  const world = { userDO: user.userDO, workspace: 'accounts', ownerUserId: OWNER };
  const workspace = orchestratorHarness(undefined, world, makeEnv(undefined, undefined, world));
  const used: string[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const headers = new Headers(init?.headers);

    if (requestUrl(input).includes('anthropic.com')) used.push(headers.get('authorization') ?? headers.get('x-api-key') ?? '');

    return new Response('refused by the test', { status: 400 });
  });
  workspace.agent.harnessHoldsCapability(token);
  workspace.agent.harnessInstallCatalog({ tiers: { default: { model: MODEL }, deep: { model: MODEL }, fast: { model: MODEL } }, availableModels: [MODEL] });
  await workspace.agent.setProviderAccount('anthropic', 'work');
  const hire = await hostedSubordinateHarness(workspace, { name: 'writer', displayName: 'Writer', nameOrigin: 'user', mission: 'write' });

  await wakeForDelegatedTask(workspace, hire.actor.handle.actorId, 'Write it.');
  await driveUntil(workspace, "the hire's model was never called", () => used.length > 0);

  expect(used.join(' ')).toContain('sk-work');
  expect(used.join(' ')).not.toContain('sk-main');
  await user.joinFibers();
  user.close();
});
