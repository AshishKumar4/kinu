/**
 * A turn's frozen profile (design v2 §2-§3): a recovered run assembles on the profile it froze as it first assembled, and
 * a turn the workspace lost mid-run is served on what it froze, whatever changed since.
 */
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect, test } from 'bun:test';
import { WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { chatSessionTurns, GATEWAY_CATALOG, gatewayWorkspace, orchestratorHarness, sentTurn, storedChat, workspaceFiles } from './helpers/actor-harness';
import { chatCompletion, GATEWAY_MODEL, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test('a recovered run assembles on the profile it froze, not on a role chosen since', async () => {
  const { agent } = orchestratorHarness();
  const turns = chatSessionTurns(agent);

  agent.harnessDrivingUserMessage('Inspect the project.', { kinuMode: 'build' });
  const first = await turns.prepare({ messages: [{ role: 'user', content: 'Inspect the project.' }] });

  // Chosen while the run is out: its isolate dies before answering, and the run is recovered on a fresh one.
  await agent.setRole('planner');
  const recovered = await turns.resume();

  // Offered the Build tools it first assembled with, not the planner's.
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

  const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
    if (!openingOf(run).includes(BUILD_ASK) || JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, 'Noted.');

    // The model chosen since answers in words of its own, so an answer it served is seen.
    if (JSON.stringify(run.query).includes('@cf/harness/other')) return chatCompletion(run, 'OTHER_MODEL_ANSWERED');

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

  const chat = JSON.stringify(await storedChat(workspace));

  expect(await readText(workspaceFiles(workspace.agent), KEPT)).toBe('built');
  expect([chat.includes('Written.'), chat.includes('OTHER_MODEL_ANSWERED')]).toEqual([true, false]);
});
