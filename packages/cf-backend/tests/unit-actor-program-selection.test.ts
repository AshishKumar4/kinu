import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';
import { createSandboxedExecutor } from '../../cli-backend/src/executor';

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
  db.exec("UPDATE scaffold_versions SET status = 'historical' WHERE status = 'current'");
  db.query("INSERT INTO scaffold_versions (version, written_at, rationale, status) VALUES (1, 1, 'selected program proof', 'current')").run();
  rt.identity.scaffold.read = async () => 'async function run() { await host.emit({ type: "text_delta", text: "wrong-live-alias" }); }';
  const result = await agent.runTurn({ input: 'Run the selected program.' });
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result.message)).toContain('selected-root-v1');
  expect(JSON.stringify(result.message)).not.toContain('wrong-live-alias');
});
