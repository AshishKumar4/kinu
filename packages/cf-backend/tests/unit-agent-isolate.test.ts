import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { afterEach, expect, test } from 'bun:test';
import { accountCredentialKey, agentAffinityKey, asFetchFunction, requestUrl } from '@kinu.run/core';
import { OPENCODE_GO_CATALOG } from '@kinu.run/test-utils';
import {
  agentSql, catalogTurn, driveUntil, gatewayWorkspace, hostedMainActor, hostedSubordinateHarness, makeEnv, orchestratorHarness, runDelegatedTask,
  wakeForDelegatedTask,
} from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun, type StubbedAiBinding } from './helpers/platform-gateway';

const openingOf = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages.filter((message) =>
  message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context')));

const toolOutputs = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages.filter((message) => message.role === 'tool'));

/** The model call that opened on `opening` and carries its tool call's answer. */
const answeredRun = (gateway: StubbedAiBinding, opening: string): RecordedGatewayRun | undefined =>
  gateway.runs.find((run) => openingOf(run).includes(opening) && toolOutputs(run) !== '[]');

test('a planner a Build turn hires cannot write files through the workspace', async () => {
  const path = '/tmp/plan-mode-leak.txt';

  const gateway = stubAiBinding((run) => {
    const answered = toolOutputs(run) !== '[]';

    if (openingOf(run).includes('Plan the change.')) {
      return answered ? chatCompletion(run, 'Planned.') : toolCallCompletion(run, { tool: 'file', args: { op: 'write', path, content: 'x' } }, 'call_leak');
    }

    return answered
      ? chatCompletion(run, 'Root waits.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'planner', lifetime: 'task', mission: 'Plan the change.' } }, 'call_planner');
  });

  const workspace = gatewayWorkspace(gateway);
  const planner = () => answeredRun(gateway, 'Plan the change.');

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

test("a hired agent's model call to OpenCode Go names the agent's own conversation", async () => {
  const OWNER = 'abcdef0123456789abcdef0123456789';
  const MODEL = 'opencode-go/muse-spark-1.3-contributor';
  const user = createTestUserDO({ durableObjectId: OWNER });
  const owner = await testOwner();

  await user.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'go-key' });
  const token = await provisionTestWorkspace(user, 'go-hire', 'Go hire');
  const world = { userDO: user.userDO, workspace: 'go-hire', ownerUserId: OWNER };
  const workspace = orchestratorHarness(undefined, world, makeEnv(undefined, undefined, world));
  const sessions: (string | null)[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    if (requestUrl(input).includes('models.dev')) return Response.json(OPENCODE_GO_CATALOG);
    sessions.push(new Headers(init?.headers).get('x-opencode-session'));

    return new Response('refused by the test', { status: 400 });
  });
  workspace.agent.harnessHoldsCapability(token);
  workspace.agent.harnessInstallCatalog({ tiers: { default: { model: MODEL }, deep: { model: MODEL }, fast: { model: MODEL } }, availableModels: [MODEL] });
  const hire = await hostedSubordinateHarness(workspace, { name: 'writer', displayName: 'Writer', nameOrigin: 'user', mission: 'write' });

  await runDelegatedTask(workspace, hire.actor.handle.actorId, 'Write it.');

  expect(new Set(sessions)).toEqual(new Set([agentAffinityKey(hire.actor.record.name)]));
  await user.joinFibers();
  user.close();
});

test("a hire made with context=inherit carries its hirer's working conversation from the hirer's isolate", async () => {
  const gateway = stubAiBinding((run) => {
    const opening = openingOf(run);

    if (opening.includes('Pass it on.')) return chatCompletion(run, 'Passed.');

    if (!opening.includes('The code word is OTTER.')) return chatCompletion(run, 'Root noted.');

    return toolOutputs(run) === '[]'
      ? toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', context: 'inherit', mission: 'Pass it on.' } }, 'call_inherit')
      : chatCompletion(run, 'Hired.');
  });

  const workspace = gatewayWorkspace(gateway);
  const middle = await hostedSubordinateHarness(workspace, { name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate' });
  const inherited = () => gateway.runs.find((run) => openingOf(run).includes('Pass it on.'));

  await wakeForDelegatedTask(workspace, middle.actor.handle.actorId, 'The code word is OTTER.');
  await driveUntil(workspace, 'the inheriting hire never ran', () => inherited() !== undefined);

  expect(JSON.stringify(requestOf(inherited() ?? gateway.runs[0]).messages)).toContain('OTTER');
});

test("a hired agent's turn requests are read from its own database", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Done.'));
  const workspace = gatewayWorkspace(gateway);
  const middle = await hostedSubordinateHarness(workspace, { name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate' });
  const middleId = middle.actor.handle.actorId;

  const ended = (): number => agentSql(middleId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middleId} AND type = 'run_end'`[0]?.n ?? 0;

  await wakeForDelegatedTask(workspace, middleId, 'Say done.');
  await driveUntil(workspace, "the hire's turn never ended", () => ended() > 0);
  const turnId = agentSql(middleId)<{ turn: string }>`SELECT turn_id AS turn FROM actor_turn_claims WHERE actor_id = ${middleId}`[0]?.turn ?? '';
  const index = await workspace.agent.getTurnRequests(turnId, middleId);

  expect(index.claim).not.toBeNull();
  expect(index.requests.length).toBeGreaterThan(0);
  const [first] = index.requests;

  if (first === undefined) throw new Error('no request recorded');
  expect((await workspace.agent.getTurnRequest(turnId, { actor: middleId, epoch: first.epoch, revision: first.revision })).messageCount).toBeGreaterThan(0);
});

test("a hired agent's conversation recall searches its own conversation", async () => {
  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes('Recall the word.')) return chatCompletion(run, 'Noted the word.');

    return toolOutputs(run) === '[]'
      ? toolCallCompletion(run, { tool: 'memory', args: { op: 'searchConversations', query: 'OTTER' } }, 'call_recall')
      : chatCompletion(run, 'Recalled.');
  });

  const workspace = gatewayWorkspace(gateway);
  const middle = await hostedSubordinateHarness(workspace, { name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate' });
  const middleId = middle.actor.handle.actorId;
  const recalled = () => answeredRun(gateway, 'Recall the word.');

  await wakeForDelegatedTask(workspace, middleId, 'The word is OTTER.');
  await driveUntil(workspace, 'the first turn never ended', () => gateway.runs.some((run) => openingOf(run).includes('The word is OTTER.')));
  await wakeForDelegatedTask(workspace, middleId, 'Recall the word.');
  await driveUntil(workspace, 'the recall never answered', () => recalled() !== undefined);

  expect(toolOutputs(recalled() ?? gateway.runs[0])).toMatch(/hits.{0,20}conversationId/u);
});

test("a hired agent's model spend counts in the workspace's and the account's totals", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Done.'));
  const workspace = gatewayWorkspace(gateway);
  const middle = await hostedSubordinateHarness(workspace, { name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate' });
  const middleId = middle.actor.handle.actorId;

  const steps = (): number => agentSql(middleId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middleId} AND type = 'step_finish'`[0]?.n ?? 0;

  const before = (await workspace.agent.getActivitySnapshot()).spend.total.calls;
  const accountBefore = (await workspace.agent.accountSpend()).reduce((sum, row) => sum + row.calls, 0);

  await wakeForDelegatedTask(workspace, middleId, 'Say done.');
  await driveUntil(workspace, "the hire's step never finished", () => steps() > 0);

  expect((await workspace.agent.getActivitySnapshot()).spend.total.calls).toBeGreaterThanOrEqual(before + steps());
  expect((await workspace.agent.accountSpend()).reduce((sum, row) => sum + row.calls, 0)).toBeGreaterThanOrEqual(accountBefore + steps());
});

test("a hired agent's working context is read and edited where its conversation is, by it and by its hirer", async () => {
  const EDIT = 'Edit your context.';
  const edit = { op: 'edit', path: '/context/working.jsonl', edits: [{ old_text: 'First task OTTERX.', new_text: 'First task OTTERX. INJECTED-NOTE' }] };

  // The hire edits with its own file tool: read, then edit, then answer.
  const gateway = stubAiBinding((run) => {
    const { messages } = requestOf(run);
    const opened = messages.map((message) => message.role === 'user' && JSON.stringify(message.content).includes(EDIT)).lastIndexOf(true);

    if (opened < 0) return chatCompletion(run, 'Done.');
    const step = messages.slice(opened).filter((message) => message.role === 'tool').length;

    if (step === 0) return toolCallCompletion(run, { tool: 'file', args: { op: 'read', path: '/context/working.jsonl' } }, 'call_read');

    return step === 1 ? toolCallCompletion(run, { tool: 'file', args: edit }, 'call_edit') : chatCompletion(run, 'Done.');
  });

  const workspace = gatewayWorkspace(gateway);
  const middle = await hostedSubordinateHarness(workspace, { name: 'middle', displayName: 'Middle', nameOrigin: 'user', mission: 'coordinate' });
  const middleId = middle.actor.handle.actorId;
  const hirer = `/context/agents/${middle.actor.record.storageKey}/working.jsonl`;

  const ended = (): number => agentSql(middleId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${middleId} AND type = 'run_end'`[0]?.n ?? 0;

  const main = async (): Promise<string> => readText((await hostedMainActor(workspace)).actor.runtime.storage.vfs, hirer);

  await wakeForDelegatedTask(workspace, middleId, 'First task OTTERX.');
  await driveUntil(workspace, 'the first turn never ended', () => ended() > 0);

  expect(await main()).toContain('First task OTTERX.');
  await wakeForDelegatedTask(workspace, middleId, EDIT);
  await driveUntil(workspace, 'the edit turn never ended', () => ended() > 1);

  const answers = gateway.runs.filter((run) => openingOf(run).includes(EDIT))
    .flatMap((run) => requestOf(run).messages.flatMap((message) => (message.role === 'tool' ? [String(message.content)] : [])));

  expect(answers.some((answer) => answer.includes('First task OTTERX.'))).toBe(true);
  expect(answers.some((answer) => answer.includes('"applied":[{'))).toBe(true);
  expect(await main()).toContain('First task OTTERX. INJECTED-NOTE');
  await wakeForDelegatedTask(workspace, middleId, 'Third task.');
  await driveUntil(workspace, 'the third turn never ended', () => ended() > 2);

  expect(gateway.runs.some((run) => openingOf(run).includes('Third task.') && openingOf(run).includes('INJECTED-NOTE'))).toBe(true);
});

test("a child's client snapshot counts its own chat inputs and answers", async () => {
  const gateway = stubAiBinding((run) => openingOf(run).includes('Counter task.') || toolOutputs(run) !== '[]'
    ? chatCompletion(run, 'Done.')
    : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'durable', mission: 'Counter task.' } }, 'call_counter'));

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'Hire a counter.');
  const child = workspace.db.query<{ actorId: string; name: string }, []>("SELECT actor_id AS actorId, name FROM workspace_actors WHERE origin = 'agent'").get();

  if (child === null) throw new Error('the child was not registered');
  const actorId = child.actorId;

  await driveUntil(workspace, 'the child never completed its answer', () => agentSql(actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_end'`[0]?.n === 1);

  expect((await workspace.agent.getActorSnapshot(child.name)).messageCount).toBe(2);
  await wakeForDelegatedTask(workspace, actorId, 'Second task.');
  await driveUntil(workspace, 'the child never completed its second answer', () => agentSql(actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_end'`[0]?.n === 2);

  expect((await workspace.agent.getActorSnapshot(child.name)).messageCount).toBe(4);
});
