/**
 * The cuts an agent's lifecycle must survive, each at the boundary production crosses: a call from a turn that has
 * closed, a crossing lost before admission, a note send that fails after its delivery committed, a finished swarm node
 * with nothing left to watch, and main's state as the roster reads it from its own isolate.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { type GeneralNote, type NotedChanges } from '@kinu.run/core';
import { agentWakes, catalogTurn, driveUntil, fireSoonestWake, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { cutNextDelivery } from './helpers/agent-facets';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

afterEach(() => { setSystemTime(); });

const Count = v.object({ n: v.number() });

test("a turn that has closed runs no tool call made under it, and a reset workspace refuses it too", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Done.')));

  await catalogTurn(workspace.agent, 'First turn.');
  const actorId = workspaceMainActor(workspace.db).actorId;
  const closed = v.parse(v.object({ turn_id: v.string() }), workspace.db.query('SELECT turn_id FROM actor_turn_fence WHERE actor_id = ?').get(actorId));
  const port = await workspace.agent.agentWorkspace(actorId);
  const late = { activity: [], turnId: closed.turn_id, runId: closed.turn_id, mode: 'build' as const, parentDriven: false, callId: 'late-call', name: 'tasks', input: { op: 'add', titles: ['STALE_RPC_TASK'] } };

  await expect(port.executeTool(late)).rejects.toMatchObject({ code: 'cancelled' });
  expect(v.parse(Count, workspace.db.query("SELECT COUNT(*) AS n FROM agent_tasks WHERE title = 'STALE_RPC_TASK'").get()).n).toBe(0);
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
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Done.')));

  const set: NotedChanges = { source: 'workspace', label: 'Workspace', mode: 'vfs-baseline' };
  const note: GeneralNote = { id: 'retry-note', type: 'GLOBAL_COMMENT', text: 'CHANGE_NOTE_RETRY_MARKER', createdA: 1 };

  await catalogTurn(workspace.agent, 'Start the ledger.');
  const actorId = workspaceMainActor(workspace.db).actorId;

  expect(await workspace.agent.saveChangeNotes(set.source, [note])).toMatchObject({ ok: true });
  cutNextDelivery(workspace.agent.agentOf(actorId).storageKey, 'before-admit');
  const sent = await workspace.agent.sendChangeNotes(set).then(() => 'sent', () => 'failed');

  const drafted = (await workspace.agent.getChangeNotes(set.source)).map((kept) => kept.id);

  const owed = v.parse(Count, workspace.db.query('SELECT COUNT(*) AS n FROM agent_deliveries WHERE actor_id = ? AND input_json LIKE ?')
    .get(actorId, '%CHANGE_NOTE_RETRY_MARKER%')).n;

  // One owner for the note's fate: either it is drafted again and owed to nobody, or it is owed and not drafted.
  expect({ sent, drafted, owed }).toEqual(owed === 0 ? { sent: 'failed', drafted: ['retry-note'], owed: 0 } : { sent: 'sent', drafted: [], owed: 1 });
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

  const node = v.parse(v.object({ actor_id: v.string(), status: v.string() }), workspace.db.query(
    "SELECT a.actor_id, h.status FROM workspace_actors a JOIN head_journal h ON h.id = a.creation_id WHERE a.origin = 'swarm' LIMIT 1",
  ).get());

  expect(node.status).toBe('completed');
  expect(agentWakes(workspace.db)).not.toContain(node.actor_id);

  const calls = gateway.runs.length;

  // Any wake still armed for other work fires, as production fires it; none re-arms the finished node.
  for (let pass = 0; pass < 3 && agentWakes(workspace.db).length > 0; pass += 1) {
    await fireSoonestWake(workspace.agent, workspace.db);
    await workspace.agent.harnessJoinDetachedFibers();
    expect(agentWakes(workspace.db)).not.toContain(node.actor_id);
  }

  expect(gateway.runs.length).toBe(calls);
});

test("the roster shows main's failed turn as failed once main rests", async () => {
  const workspace = gatewayWorkspace(stubAiBinding(() => new Response('refused by the test', { status: 400 })));

  await catalogTurn(workspace.agent, 'This turn fails.');

  expect((await workspace.agent.listWorkspaceAgents()).find((agent) => agent.category === 'main')?.activity).toBe('failed');
});
