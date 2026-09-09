/**
 * A HOSTED HEAD REPORTS THE FILES IT CHANGED — and only those.
 *
 * `HeadReport.fileChanges` is `HeadCapture.files.snapshot()` and nothing else
 * fills it, so the whole of a head's file attribution on this backend is
 * whether that capture's observer reached the plane the head's writes land on.
 * It did not: `hostHead` created the capture INSIDE `host.run`, and acquiring
 * the actor is what BUILDS its runtime — so `CFRuntimeHooks.workspaceObserver`
 * was read by `createCFRuntime` and supplied by nobody, and every head on this
 * backend reported that it had changed nothing however much it wrote. The cli
 * attributed per actor throughout (`head-runtime.ts`'s `runLocalHead` hands
 * `capture.files` to the seat it asks for), which is what made this a backend
 * asymmetry rather than a missing feature.
 *
 * WHY THE SIBLING HALF IS THE POINT. Attribution has to happen where a write
 * lands, because forks run concurrently over one tree: an end-of-split diff
 * smears every head's work into one pile and hands all of it to whoever is
 * asked — `heads/file-changes.ts` states the rule this suite measures. So the
 * two heads below write AT THE SAME TIME, each one's model held at a barrier
 * until the other has also issued its write, and each report must name its own
 * file alone. Exactness under concurrency is the property; a sequential pair
 * would pass with one observer shared by the whole workspace.
 *
 * A head writes into its OWN home, because that is where a hosted actor's
 * credential lets it write — one tree, one database, a uid boundary inside them
 * (tests/unit-head-fork.test.ts pins that half). The home is derived from the
 * identity the DIRECTORY issued, which is why the fixture registers the actor
 * row before the run and reads the storage key back: production's `hostHead`
 * re-finds that same row, and a home keyed on anything else would be a home no
 * other reader can derive.
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

/** A rendezvous for `count` arrivals. What makes the two writes CONCURRENT
 *  rather than merely both-eventually-present: neither head's write is issued
 *  until both heads are holding one. */
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
  /** The file this head writes, in the workspace's own path space. */
  readonly notes: string;
}

/**
 * One head's row and the file it will write.
 *
 * The row is registered through the production directory operation, which is
 * the same idempotent register `hostHead` makes: it re-finds this row rather
 * than creating a second one. Registering is NOT acquiring — the runtime is
 * still built by the run, which is the ordering the fix is about.
 */
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
      // PINNED, so the run resolves no route: what is under test is the plane a
      // head's writes land on, and a tier lookup would be a second thing that
      // can fail inside it.
      model: 'test/model',
      // BUILTIN, not the head default of `inherit`: an inherited loop runs the
      // parent's scaffold, and scaffold code needs the workerd loader binding
      // this harness has no equivalent of. The builtin arm is the shared
      // inference loop — the one that calls tools.
      loop: { kind: 'builtin' },
    },
  };
}

/**
 * A head that writes ONE file through the `file` tool and then answers.
 *
 * ONE model for both runs, as two forks of one workspace share one route:
 * which head is calling is read off its own task line in the prompt, and which
 * step it is on is read off whether a tool result has come back — the same way
 * the sibling delegated-turn suite reads both.
 */
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

  // Its own file, at its own status and line count — the read that came back
  // empty for every hosted head while the capture watched nothing.
  expect(alpha.fileChanges).toEqual([
    { path: alphaHead.notes, status: 'added', added: 1, removed: 0 },
  ]);
  expect(beta.fileChanges).toEqual([
    { path: betaHead.notes, status: 'added', added: 1, removed: 0 },
  ]);
  // And NOT the sibling's, which is the half no end-of-split diff can recover.
  expect(alpha.fileChanges.map((change) => change.path)).not.toContain(betaHead.notes);
  expect(beta.fileChanges.map((change) => change.path)).not.toContain(alphaHead.notes);
});
