/**
 * Root arm only: non-root kinds are covered in `tests/unit-loop-contract.test.ts`. The root drives Think's
 * own loop, and this is the only proof the selected program actually ran; do not delete as a duplicate.
 * The program runs on the Worker Loader binding (in this process, through `helpers/worker-loader.ts`).
 */
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { actorScaffoldPath, MAIN_AGENT } from '@kinu.run/core';
import {
  orchestratorHarness, chatSessionTurns, workspaceFiles, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';

const TURN_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function oneTextTurn(text: string, before?: () => Promise<void>) {
  return scriptedTurnModel({ doGenerate: async () => {
    await before?.();

    return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined }, usage: TURN_USAGE, warnings: [] };
  } });
}

const SCAFFOLD = actorScaffoldPath({ kind: 'main', storageKey: MAIN_AGENT });

/** Version 1 of the root's program on disk and selected as current, as a promotion leaves it. */
async function selectProgram(harness: ActorHarness<HarnessOrchestratorAgent>, source: string, rationale: string): Promise<void> {
  const { db } = harness;
  await workspaceFiles(harness.agent).writeFile(`${SCAFFOLD}.v1`, source);
  const actorId = workspaceMainActor(db).actorId;
  db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'").run(actorId);
  db.query("INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (?, 1, 1, ?, 'current')")
    .run(actorId, rationale);
}

test('the real Think turn uses preselected versioned source, not the live alias', async () => {
  const harness = orchestratorHarness();
  const { agent } = harness;
  agent.modelFactory = () => oneTextTurn('default inference');
  await agent.onStart();
  await selectProgram(harness,
    'async function run() { await host.emit({ type: "text_delta", text: "selected-root-v1" }); }', 'selected program proof');
  // The live alias names a different program; the turn must not run it.
  await workspaceFiles(agent).writeFile(SCAFFOLD,
    'async function run() { await host.emit({ type: "text_delta", text: "wrong-live-alias" }); }');

  const result = await chatSessionTurns(agent).run('Run the selected program.');
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result.message)).toContain('selected-root-v1');
  expect(JSON.stringify(result.message)).not.toContain('wrong-live-alias');
});

test('the loop\'s stop halts new selected-program effects', async () => {
  const harness = orchestratorHarness();
  const { agent } = harness;
  // The program's model call is where it waits while the owner presses Stop.
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  agent.modelFactory = () => oneTextTurn('thinking', async () => {
    started.resolve();
    await release.promise;
  });
  await agent.onStart();
  await selectProgram(harness, `async function run() {
    await host.emit({ type: "text_delta", text: "effect-first" });
    await host.llmStream({ system: "Think.", messages: [{ role: "user", content: "think" }] });
    await host.emit({ type: "text_delta", text: "effect-second" });
  }`, 'cancel selected program');

  const running = chatSessionTurns(agent).run('Run until stopped.');
  // A turn that ends first never reached its model call, so there is nothing to stop.
  await Promise.race([started.promise, running.then(() => { throw new Error('the program finished before its model call'); })]);
  await agent.cancelCurrentWork();
  release.resolve();
  const result = await running;

  expect(JSON.stringify(result.message)).toContain('effect-first');
  expect(JSON.stringify(result.message)).not.toContain('effect-second');
  const [run] = (await agent.listRuns()).items;

  if (run === undefined) throw new Error('the stopped turn left no run');
  expect((await agent.getRunEvents(run.runId)).find((event) => event.type === 'run_end')).toMatchObject({ reason: 'aborted' });
});
