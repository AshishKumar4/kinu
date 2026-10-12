/**
 * A turn's capability and its frozen profile (design v2 §2-§3): every call that runs more of a turn names its run and its
 * opening, which the workspace's durable fence must still hold, and a recovered run assembles on the profile it froze as
 * it first assembled, whatever changed since.
 */
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { TurnFences, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { catalogTurn, chatSessionTurns, GATEWAY_CATALOG, gatewayWorkspace, orchestratorHarness, sentTurn, workspaceFiles, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, GATEWAY_MODEL, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const Count = v.object({ n: v.number() });

test("a call from a run a Retry superseded is refused, though the fence holds the same turn's newer run", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Done.')));

  await catalogTurn(workspace.agent, 'First turn.');
  const actorId = workspaceMainActor(workspace.db).actorId;
  const first = v.parse(v.object({ turn_id: v.string(), run_id: v.string(), seq: v.number() }), workspace.db.query('SELECT turn_id, run_id, seq FROM actor_turn_fence WHERE actor_id = ?').get(actorId));

  // The same turn's Retry opens a new run, as its agent's next opening does.
  expect(new TurnFences(sqlOver(workspace.db)).open(actorId, { turnId: first.turn_id, runId: 'run-retried', seq: first.seq + 1 })).toBe(true);

  const port = await workspace.agent.agentWorkspace(actorId);
  const late = { activity: [], turnId: first.turn_id, runId: first.run_id, epoch: first.seq, mode: 'build' as const, parentDriven: false, callId: 'late-call', name: 'tasks', input: { op: 'add', titles: ['SUPERSEDED_RUN_TASK'] } };

  await expect(port.executeTool(late)).rejects.toMatchObject({ code: 'cancelled' });
  expect(v.parse(Count, workspace.db.query("SELECT COUNT(*) AS n FROM agent_tasks WHERE title = 'SUPERSEDED_RUN_TASK'").get()).n).toBe(0);
});

test('a recovered run assembles on the profile it froze, not on a role chosen since', async () => {
  const { agent } = orchestratorHarness();
  const turns = chatSessionTurns(agent);

  agent.harnessDrivingUserMessage('Inspect the project.', { kinuMode: 'build' });
  const first = await turns.prepare({ messages: [{ role: 'user', content: 'Inspect the project.' }] });

  // Chosen while the run is out: its isolate dies before answering, and the run is recovered on a fresh one.
  await agent.setRole('planner');
  const recovered = await turns.resume();

  expect(recovered.system).toBe(first.system);
  expect(recovered.activeTools).toEqual(first.activeTools);
  await turns.settle({ messageId: 'a-recovered', text: 'Inspected.' });
});

const BUILD_ASK = 'Write the kept file.';

const KEPT = '/home/main/kept.txt';

const OTHER_MODEL = 'ai-gateway/workers-ai/@cf/harness/other';

/** The workspace's hold on a turn goes with its activation while the agent's isolate runs on (design v3 D): the turn's
 *  next call is served on the surface rebuilt from what it froze as it bound, its role's Build authority and its model,
 *  whatever the owner chose since. */
test('a turn the workspace lost mid-run keeps the Build role and model it froze, though a planner and another model were chosen since', async () => {
  const reached = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const served: string[] = [];

  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    if (!openingOf(run).includes(BUILD_ASK) || JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, 'Noted.');
    served.push(JSON.stringify(run.query));

    if (requestOf(run).messages.some((message) => message.role === 'tool')) return chatCompletion(run, 'Written.');
    reached.resolve();
    await held.promise;

    return toolCallCompletion(run, { tool: 'file', args: { op: 'write', path: KEPT, content: 'built' } }, 'call_write');
  }));

  workspace.agent.harnessInstallCatalog({ ...GATEWAY_CATALOG, availableModels: [GATEWAY_MODEL, OTHER_MODEL] });
  workspace.agent.harnessCatalogModels({ [OTHER_MODEL]: { contextWindow: 128_000 } });
  const sent = sentTurn(workspace.agent, BUILD_ASK, crypto.randomUUID(), 'build');

  await reached.promise;
  await workspace.agent.setRole('planner');
  expect(await workspace.agent.setModel(OTHER_MODEL)).toEqual({ ok: true, spec: OTHER_MODEL });
  workspace.agent.harnessEvictAgentTurns();
  held.resolve();
  await sent;

  expect(await readText(workspaceFiles(workspace.agent), KEPT)).toBe('built');
  expect(served).toHaveLength(2);
  expect(served.filter((query) => query.includes('@cf/harness/other'))).toEqual([]);
});
