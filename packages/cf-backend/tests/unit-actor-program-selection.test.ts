import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';
import { createSandboxedExecutor } from '../../cli-backend/src/executor';
import { renderThrownChain } from '@kinu.run/core/obs';
import type { TurnContext } from '@cloudflare/think';

test.each(['orchestrator', 'subordinate'])('the real %s Think turn uses preselected versioned source, not the live alias', async kind => {
  const harness = kind === 'orchestrator' ? orchestratorHarness() : subordinateHarness();
  const { agent, db } = harness;
  agent.modelFactory = () => scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text: 'default inference' }], finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });
  await agent.onStart();
  const rt = agent.observeRuntime();
  rt.executor = createSandboxedExecutor();
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(rt.identity.scaffold.path + '.v1', 'async function run() { await host.emit({ type: "text_delta", text: "selected-root-v1" }); }');
  db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'")
    .run(rt.actor.actorId);
  db.query("INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (?, 1, 1, 'selected program proof', 'current')")
    .run(rt.actor.actorId);
  rt.identity.scaffold.read = async () => 'async function run() { await host.emit({ type: "text_delta", text: "wrong-live-alias" }); }';
  const result = await agent.runTurn({ input: 'Run the selected program.' });
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result.message)).toContain('selected-root-v1');
  expect(JSON.stringify(result.message)).not.toContain('wrong-live-alias');
});

test.each(['orchestrator', 'subordinate'])('the real %s cancelAllChats stops new selected-program effects and preserves its cause', async kind => {
  const { agent, db } = kind === 'orchestrator' ? orchestratorHarness() : subordinateHarness();
  agent.modelFactory = () => scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text: 'unused default' }], finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });
  await agent.onStart();
  const rt = agent.observeRuntime();
  const executor = createSandboxedExecutor();
  const errors: string[] = [];
  rt.executor = { ...executor, execute: async (code, providers, options) => {
    const result = await executor.execute(code, providers, options);
    if (result.error) errors.push(result.error);
    return result;
  } };
  const turns: TurnContext[] = [];
  const beforeTurn = agent.beforeTurn.bind(agent);
  agent.beforeTurn = async context => {
    turns.push(context);
    return beforeTurn(context);
  };
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(rt.identity.scaffold.path + '.v1', 'async function run() { await host.appendMemory("probe", "first"); await host.appendMemory("probe", "second"); }');
  db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'")
    .run(rt.actor.actorId);
  db.query("INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (?, 1, 1, 'cancel selected program', 'current')")
    .run(rt.actor.actorId);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  rt.memory.append = async (_path, content) => { effects.push(content); started.resolve(); await release.promise; };
  const running = agent.runTurn({ input: 'Run until stopped.' });
  await started.promise;
  await agent.cancelAllChats();
  release.resolve();
  await running;
  expect(effects).toEqual(['first']);
  const signal = turns.at(-1)?.signal;
  if (signal === undefined) throw new Error('Think did not expose its actual turn signal');
  expect(signal.aborted).toBe(true);
  expect(errors.join('\n')).toContain(renderThrownChain({ cause: signal.reason }));
});
