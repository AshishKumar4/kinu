/**
 * Root arm only: non-root kinds are covered in `tests/unit-loop-contract.test.ts`. The root drives Think's
 * own loop, and this is the only proof the selected program actually ran; do not delete as a duplicate.
 */
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { orchestratorHarness, chatSessionTurns } from './helpers/actor-harness';
import { createSandboxedExecutor } from '../../cli-backend/src/executor';
import { renderThrownChain } from '@kinu.run/core/obs';

function oneTextTurn(text: string) {
  return scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });
}

test('the real Think turn uses preselected versioned source, not the live alias', async () => {
  const harness = orchestratorHarness();
  const { agent, db } = harness;
  agent.modelFactory = () => oneTextTurn('default inference');
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
  const result = await chatSessionTurns(agent).run('Run the selected program.');
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result.message)).toContain('selected-root-v1');
  expect(JSON.stringify(result.message)).not.toContain('wrong-live-alias');
});

test('the loop\'s stop halts new selected-program effects and preserves its cause', async () => {
  const { agent, db } = orchestratorHarness();
  agent.modelFactory = () => oneTextTurn('unused default');
  await agent.onStart();
  const rt = agent.observeRuntime();
  const executor = createSandboxedExecutor();
  const errors: string[] = [];
  rt.executor = { ...executor, execute: async (code, providers, options) => {
    const result = await executor.execute(code, providers, options);

    if (result.error) errors.push(result.error);

    return result;
  } };
  // What a Stop aborts, and what the program's failure names.
  const signals: AbortSignal[] = [];
  agent.harnessObserveLease((lease) => { signals.push(lease.signal); });

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

  const running = chatSessionTurns(agent).run('Run until stopped.');
  await started.promise;
  await agent.cancelCurrentWork();
  release.resolve();
  await running;
  expect(effects).toEqual(['first']);
  const signal = signals.at(-1);

  if (signal === undefined) throw new Error('the loop did not hand the preparation its turn signal');
  expect(signal.aborted).toBe(true);
  expect(errors.join('\n')).toContain(renderThrownChain({ cause: signal.reason }));
});
