/**
 * NOTE ON THE MATRIX. This file has ONE arm, the ROOT's.
 *
 * Every non-root actor is a logical actor whose turns run on one `ActorSession`
 * through the shared runner, so the four non-root kinds are asserted together —
 * with a STRONGER property than a per-kind matrix here would give — in
 * `tests/unit-loop-contract.test.ts`: the pinned version is selected with the
 * live alias POISONED, the claim records `program_version` and
 * `program_digest`, and a promotion does not move a claim already admitted,
 * for root, hired, temporary, head and node.
 *
 * The root's arm is here because it is genuinely different machinery: the
 * workspace root drives Think's own turn loop rather than an `ActorSession`, so
 * nothing in the loop-contract suite covers it — and this file drives a
 * scripted MODEL, so it is the one place the marker is
 * proven to have actually RUN rather than to have been selected. Deleting this
 * arm to "avoid duplication" would delete the only proof of the one path that
 * is not shared, and the only end-to-end execution proof of any of them.
 */
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { orchestratorHarness, thinkTurns } from './helpers/actor-harness';
import { createSandboxedExecutor } from '../../cli-backend/src/executor';
import { renderThrownChain } from '@kinu.run/core/obs';

test('the real Think turn uses preselected versioned source, not the live alias', async () => {
  const harness = orchestratorHarness();
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
  const result = await thinkTurns(agent).run('Run the selected program.');
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result.message)).toContain('selected-root-v1');
  expect(JSON.stringify(result.message)).not.toContain('wrong-live-alias');
});

test('the loop\'s stop halts new selected-program effects and preserves its cause', async () => {
  const { agent, db } = orchestratorHarness();
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
  // The turn's own abort signal, read off the lease the loop hands the
  // preparation: what a Stop aborts, and what the program's failure names.
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

  const running = thinkTurns(agent).run('Run until stopped.');
  await started.promise;
  // The composer's Stop, as the transport dispatches it: the loop's own stop.
  await agent.cancelCurrentWork();
  release.resolve();
  await running;
  expect(effects).toEqual(['first']);
  const signal = signals.at(-1);

  if (signal === undefined) throw new Error('the loop did not hand the preparation its turn signal');
  expect(signal.aborted).toBe(true);
  expect(errors.join('\n')).toContain(renderThrownChain({ cause: signal.reason }));
});
