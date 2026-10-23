/**
 * The cuts an agent's lifecycle must survive, each at the boundary production crosses: a call from a turn that has
 * closed, a crossing lost before admission, a note send that fails after its delivery committed, a finished swarm node
 * with nothing left to watch, main's state as the roster reads it from its own isolate, and a delivery still on its way
 * when a Stop cut it off.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { type GeneralNote, type NotedChanges } from '@kinu.run/core';
import { agentWakes, catalogTurn, driveUntil, fireSoonestWake, gatewayWorkspace, reactivateOrchestratorHarness, workspaceMainActor } from './helpers/actor-harness';
import { cutNextDelivery, holdNextDelivery } from './helpers/agent-facets';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';

afterEach(() => { setSystemTime(); });

/** The owner's words, as the pane sends them. */
function ownerWords(text: string): string {
  const id = crypto.randomUUID();

  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }], trigger: 'submit-message' }) },
  });
}

test("a turn that has closed runs no tool call or advisor read made under it, and a reset workspace refuses it too", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Done.')));

  await catalogTurn(workspace.agent, 'First turn.');
  const actorId = workspaceMainActor(workspace.db).actorId;
  const closed = v.parse(v.object({ turn_id: v.string(), run_id: v.string(), seq: v.number() }), workspace.db.query('SELECT turn_id, run_id, seq FROM actor_turn_fence WHERE actor_id = ?').get(actorId));
  const port = await workspace.agent.agentWorkspace(actorId);
  // Its own capability, as its turn carried it: the turn ended, so the fence no longer holds it.
  const late = { activity: [], turnId: closed.turn_id, runId: closed.run_id, epoch: closed.seq, mode: 'build' as const, parentDriven: false, callId: 'late-call', name: 'tasks', input: { op: 'add', titles: ['STALE_RPC_TASK'] } };

  await expect(port.executeTool(late)).rejects.toMatchObject({ code: 'cancelled' });
  // Its advisor's reads are fenced as its calls are.
  await expect(port.advisorRead({ turnId: closed.turn_id, runId: closed.run_id, epoch: closed.seq, callId: 'late-read', name: 'file', input: { op: 'list', path: '.' } }))
    .rejects.toMatchObject({ code: 'cancelled' });
  const restarted = await reactivateOrchestratorHarness(workspace.db);

  await expect((await restarted.agent.agentWorkspace(actorId)).executeTool(late)).rejects.toMatchObject({ code: 'cancelled' });
  const work = await restarted.agent.listWorkspaceWork();

  expect([...work.plans, ...work.tasks].flatMap((owned) => owned.tasks.map((task) => task.title))).not.toContain('STALE_RPC_TASK');
});

test('a later delivery never reaches the model before an older one whose crossing was lost', async () => {
  const A = 'ORDER_A_MARKER';
  const B = 'ORDER_B_MARKER';
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    const prompt = JSON.stringify(requestOf(run).messages);
    const read = [A, B].filter((marker) => prompt.includes(marker));

    if (read.length > 0) asked.push(read.join('+'));

    return chatCompletion(run, 'Done.');
  });

  const workspace = gatewayWorkspace(gateway);
  await catalogTurn(workspace.agent, 'Start the ledger.');
  const actorId = workspaceMainActor(workspace.db).actorId;

  cutNextDelivery(workspace.agent.agentOf(actorId).storageKey, 'before-admit');
  expect(await workspace.agent.runTaskFromMcp(A)).toEqual({ status: 'queued' });
  expect(await workspace.agent.runTaskFromMcp(B)).toEqual({ status: 'queued' });
  await driveUntil(workspace, 'neither delivery reached the model', () => asked.length > 0);

  expect(asked[0]).not.toBe(B);
});

test('a note send whose delivery committed is not also drafted again', async () => {
  const heard: string[] = [];

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    // What each call answers: its newest user message.
    heard.push(JSON.stringify(requestOf(run).messages.filter((message) => message.role === 'user').at(-1) ?? null));

    return chatCompletion(run, 'Done.');
  }));

  const set: NotedChanges = { source: 'workspace', label: 'Workspace', mode: 'vfs-baseline' };
  const note: GeneralNote = { id: 'retry-note', type: 'GLOBAL_COMMENT', text: 'CHANGE_NOTE_RETRY_MARKER', createdA: 1 };

  await catalogTurn(workspace.agent, 'Start the ledger.');
  const actorId = workspaceMainActor(workspace.db).actorId;

  expect(await workspace.agent.saveChangeNotes(set.source, [note])).toMatchObject({ ok: true });
  cutNextDelivery(workspace.agent.agentOf(actorId).storageKey, 'before-admit');
  const sent = await workspace.agent.sendChangeNotes(set).then(() => 'sent', () => 'failed');

  const drafted = (await workspace.agent.getChangeNotes(set.source)).map((kept) => kept.id);

  // One owner for the note's fate: either it is drafted again, or it is owed and its agent's wake delivers it, once.
  if (sent === 'failed') {
    expect(drafted).toEqual(['retry-note']);

    return;
  }

  expect(drafted).toEqual([]);
  await driveUntil(workspace, 'the owed note never reached the agent', () => heard.some((said) => said.includes('CHANGE_NOTE_RETRY_MARKER')));
  await workspace.agent.harnessAgentsIdle();
  expect(heard.filter((said) => said.includes('CHANGE_NOTE_RETRY_MARKER'))).toHaveLength(1);
});

test('a swarm node that finished leaves no wake armed, and a fired wake arms none', async () => {
  const ASK = 'Find a way to speed up the parser.';

  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'Cache the token table.');

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: 'Name one way to tokenize faster.', preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  });

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, ASK);
  await workspace.agent.harnessJoinDetachedFibers();

  const calls = gateway.runs.length;

  // Any wake still armed fires, as production fires it; none runs the finished node, or anything, again.
  for (let pass = 0; pass < 3 && agentWakes(workspace.db).length > 0; pass += 1) {
    await fireSoonestWake(workspace.agent, workspace.db);
    await workspace.agent.harnessJoinDetachedFibers();
  }

  expect(gateway.runs.length).toBe(calls);
});

test("the roster shows main's failed turn as failed once main rests", async () => {
  const workspace = gatewayWorkspace(stubAiBinding(() => new Response('refused by the test', { status: 400 })));

  await catalogTurn(workspace.agent, 'This turn fails.');

  expect((await workspace.agent.listWorkspaceAgents()).find((agent) => agent.category === 'main')?.activity).toBe('failed');
});

test('a delivery on its way when a Stop cut it off arrives cancelled, never runs, and the next input runs', async () => {
  const asked: string[] = [];

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    asked.push(JSON.stringify(requestOf(run).messages));

    return chatCompletion(run, 'Done.');
  }));

  await catalogTurn(workspace.agent, 'Start the ledger.');
  const { agent } = workspace;
  const main = workspaceMainActor(workspace.db).actorId;
  const owner = socketConnection({ id: 'owner', send: () => {} });
  const held = holdNextDelivery(agent.agentOf(main).storageKey);
  const sending = agent.onMessage(owner, ownerWords('BEFORE_STOP_MARKER'));
  const release = await held;

  // The Stop cancels what the agent is owed, the delivery on its way among them, then the delivery arrives.
  await agent.cancelCurrentWork();
  await release();
  await sending;

  await agent.onMessage(owner, ownerWords('AFTER_STOP_MARKER'));
  await agent.harnessAgentsIdle();

  expect(asked.some((messages) => messages.includes('AFTER_STOP_MARKER'))).toBe(true);
  expect(asked.some((messages) => messages.includes('BEFORE_STOP_MARKER'))).toBe(false);
});
