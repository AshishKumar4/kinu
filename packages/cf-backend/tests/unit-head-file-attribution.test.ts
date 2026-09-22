/**
 * A hosted head reports the files it changed, and only those. The capture's observer must reach the plane
 * the head writes to before `host.run` builds the runtime (`CFRuntimeHooks.workspaceObserver`). Two heads
 * write concurrently and each must name only its own file (`heads/file-changes.ts` states the rule).
 */
import { expect, test } from 'bun:test';
import {
  agentHome, createProviderRegistry, explorationActorKey, headAgentName, parseActorKey,
  type HeadInput, type HeadReport,
} from '@kinu.run/core';
import { scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostHead } from '../src/exploration-hosting';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A rendezvous for `count` arrivals: neither write is issued until both heads hold one. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release = (): void => undefined;
  const open = new Promise<void>((resolve) => { release = () => { resolve(); }; });

  return async () => {
    arrived += 1;

    if (arrived >= count) release();
    await open;
  };
}

interface HeadFixture {
  readonly input: HeadInput;
  readonly notes: string;
}

/** Registered through the production directory op `hostHead` re-finds; registering is not acquiring. */
async function headFixture(
  workspace: ActorHarness<HarnessOrchestratorAgent>, id: string,
): Promise<HeadFixture> {
  const entry = await workspace.agent.actorDirectory({
    action: 'register', creationId: id, name: explorationActorKey(id), kind: 'head', lifetime: 'task',
  });

  return {
    notes: `${agentHome(headAgentName(parseActorKey(entry.storageKey).id))}/notes.md`,
    input: {
      id,
      rootId: 'alpha',
      parentId: null,
      depth: 0,
      task: `write your own note as ${id}`,
      mode: 'build',
      rationale: `the ${id} angle`,
      inheritedContext: [],
      budget: { maxDepth: 0, spawnedAt: Date.now() },
      mergeStrategy: 'synthesize',
      // Pinned, so no route lookup can fail inside the run.
      model: 'test/model',
      // Builtin, not `inherit`: scaffold code needs the workerd loader binding this harness lacks.
      loop: { kind: 'builtin' },
    },
  };
}

/** One model for both runs: the head is read off its task line, the step off whether a tool result came back. */
function writingModel(heads: readonly HeadFixture[], arrive: () => Promise<void>) {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-head',
    doGenerate: async (options): Promise<ScriptedTurnResult> => {
      const prompt = JSON.stringify(options.prompt);
      const head = heads.find((candidate) => prompt.includes(candidate.input.task));

      if (!head) throw new Error('the head prompt named no task this fixture scripted');

      if (options.prompt.some((message) => message.role === 'tool')) {
        return {
          content: [{ type: 'text' as const, text: `wrote ${head.notes}` }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE, warnings: [],
        };
      }

      await arrive();

      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: `write-${head.input.id}`,
          toolName: 'file',
          input: JSON.stringify({
            action: 'write', path: head.notes, content: `${head.input.id} was here\n`,
          }),
        }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: USAGE, warnings: [],
      };
    },
  });
}

test('two heads writing at the same time each report only their own file', async () => {
  const workspace = orchestratorHarness();
  const alphaHead = await headFixture(workspace, 'alpha');
  const betaHead = await headFixture(workspace, 'beta');
  const model = writingModel([alphaHead, betaHead], barrier(2));
  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });
  const seams = workspace.agent.observeExplorationSeams();

  const [alpha, beta]: HeadReport[] = await Promise.all([
    (await hostHead(seams, alphaHead.input)).run(),
    (await hostHead(seams, betaHead.input)).run(),
  ]);

  expect(alpha.fileChanges).toEqual([
    { path: alphaHead.notes, status: 'added', added: 1, removed: 0 },
  ]);
  expect(beta.fileChanges).toEqual([
    { path: betaHead.notes, status: 'added', added: 1, removed: 0 },
  ]);
  // And not the sibling's, which no end-of-split diff can recover.
  expect(alpha.fileChanges.map((change) => change.path)).not.toContain(betaHead.notes);
  expect(beta.fileChanges.map((change) => change.path)).not.toContain(alphaHead.notes);
});
