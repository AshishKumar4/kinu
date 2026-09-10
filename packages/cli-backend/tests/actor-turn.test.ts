import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createTestRuntime, scriptedTurnModel } from '@kinu.run/test-utils';
import {
  startActorTurn, prepareActorProgram, inWorkMode, runHeadInference, HeadCapture,
  MissionGovernor, localMissionScope, initActorClaimTables,
} from '@kinu.run/core';
import { createSandboxedExecutor } from '../src/executor';
import { defaultLoopOrigin } from '@kinu.run/core';
import { headLoopSeams } from './actor-fixture';
import type { ChatEvent } from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import { jsonSchema, tool } from 'ai';

const OLD = 'async function run() { await host.emit({ type: "text_delta", text: "version one" }); }';

const NEW = 'async function run() { await host.emit({ type: "text_delta", text: "version two" }); }';

/** The two real phases a claim owner runs, as one call: pin the selected
 *  version's bytes, then start the turn on them. Production splits these at the
 *  durable claim write (ActorSession.execute); a test with no claim to write
 *  still has to run them in that order. */
async function admitActorTurn(input: Parameters<typeof startActorTurn>[0] extends infer _T
  ? Omit<Parameters<typeof startActorTurn>[0], 'program'> : never) {
  const program = await prepareActorProgram({
    runtime: input.runtime, mode: input.mode, version: input.loopVersion,
    signal: input.chat.signal, assertActive: input.assertActive,
  });

  return { program, events: startActorTurn({ ...input, program }) };
}

async function fixture() {
  const { rt } = createTestRuntime();
  // The claim/working-history plane, from the one initializer that owns it:
  // a seated head takes CLAIMED turns, and `ActorSession` reads and writes
  // `actor_turn_claims` plus the raw working revisions a mid-turn edit
  // rewrites. `createTestRuntime` bootstraps identity and the actor directory
  // only, so a fixture that seats an actor has to add this ledger — by calling
  // the production DDL rather than retyping a second copy of it.
  initActorClaimTables(rt.storage.execRaw);
  rt.executor = createSandboxedExecutor();
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(rt.identity.scaffold.path + '.v1', OLD);
  await files.writeFile(rt.identity.scaffold.path + '.v2', NEW);

  const chatModel = scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text: 'builtin answer' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });

  return { rt, files, chat: { model: chatModel, system: 'sys', history: [{ role: 'user', content: 'go' } satisfies ModelMessage], tools: {} }, chatModel };
}

async function text(events: AsyncIterable<ChatEvent>): Promise<string> {
  let answer = '';

  for await (const event of events) if (event.type === 'text-delta') answer += event.delta;

  return answer;
}

test('an admitted version keeps its actual bytes across live-alias and later version changes', async () => {
  const { rt, files, chat, chatModel } = await fixture();
  let aliasReads = 0;
  rt.identity.scaffold.read = async () => {
    aliasReads++;

    return NEW;
  };

  const admitted = await admitActorTurn({ runtime: rt, mode: 'build', task: 'go', loopVersion: 1, chat });
  Reflect.set(admitted.program, 'source', NEW);
  expect(admitted.program).toEqual({ kind: 'scaffold', version: 1, source: OLD,
    digest: createHash('sha256').update(OLD).digest('hex') });
  await files.writeFile(rt.identity.scaffold.path + '.v1', NEW);
  expect(await text(admitted.events)).toBe('version one');
  const next = await admitActorTurn({ runtime: rt, mode: 'build', task: 'go', loopVersion: 2, chat });
  expect(await text(next.events)).toBe('version two');
  expect(aliasReads).toBe(0);
  expect(chatModel.doStreamCalls).toHaveLength(0);
});

test('an actor Build turn does not inherit another actor\'s ambient Plan mode', async () => {
  const { rt, chat } = await fixture();
  const admitted = await inWorkMode('plan', () => admitActorTurn({ runtime: rt, mode: 'build', task: 'go', loopVersion: 1, chat }));
  expect(await inWorkMode('plan', () => text(admitted.events))).toBe('version one');
});

test('Plan uses the builtin loop without reading or evaluating a promoted initializer', async () => {
  const { rt, files, chat } = await fixture();
  await files.writeFile(rt.identity.scaffold.path + '.v1', 'throw new Error("promoted initializer ran");');
  const admitted = await admitActorTurn({ runtime: rt, mode: 'plan', task: 'go', loopVersion: 1, chat });
  expect(admitted.program).toEqual({ kind: 'builtin', version: 0 });
  expect(await text(admitted.events)).toBe('builtin answer');
});

test('cancellation while the selected source is being read prevents a later program start', async () => {
  const { rt, files, chat } = await fixture();
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readFile = files.readFile.bind(files);
  files.readFile = async (path, options) => {
    const bytes = await readFile(path, options);
    reading.resolve();
    await release.promise;

    return bytes;
  };

  const abort = new AbortController();

  const admission = admitActorTurn({ runtime: rt, mode: 'build', task: 'go', loopVersion: 1,
    chat: { ...chat, signal: abort.signal } });

  await reading.promise;
  const stopped = new Error('actor stopped during source admission');
  abort.abort(stopped);
  release.resolve();
  await expect(admission).rejects.toBe(stopped);
});

test('the real head caller executes its selected program and retains its produced conversation', async () => {
  const { rt, chat, chatModel } = await fixture();
  rt.identity.scaffold.version = async () => 1;
  const produced: ModelMessage[] = [];

  const report = await runHeadInference({
    id: 'head-one', rootId: 'origin', parentId: null, depth: 0, task: 'go', mode: 'build',
    rationale: 'exercise the selected program', inheritedContext: [],
    budget: { maxDepth: 0, spawnedAt: Date.now() }, mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  }, {
    ...headLoopSeams(rt), model: chat.model, tools: {}, capture: new HeadCapture(),
    workspaceLayout: 'private-scratch', isAborted: () => false,
    reportMessages: messages => { produced.push(...messages); },
  });

  expect(report.summary).toBe('version one');
  expect(produced).toEqual([{ role: 'assistant', content: 'version one' }]);
  expect(chatModel.doStreamCalls).toHaveLength(0);
});

test('separate model calls inside a selected head program share its real mission budget', async () => {
  const { rt, files, chat, chatModel } = await fixture();
  rt.identity.scaffold.version = async () => 1;
  await files.writeFile(rt.identity.scaffold.path + '.v1', 'async function run() { await host.llmStream({ system: "sys", messages: [{ role: "user", content: "first" }] }); await host.llmStream({ system: "sys", messages: [{ role: "user", content: "second" }] }); }');
  const governor = new MissionGovernor({ actor: rt.actor, storage: rt.storage });
  governor.declare('head-budget', { tokens: 1 }, {});
  const mission = localMissionScope(governor, ['head-budget']);

  if (mission === null) throw new Error('the declared mission must have a scope');

  const report = await runHeadInference({
    id: 'head-budgeted', rootId: 'origin', parentId: null, depth: 0, task: 'go', mode: 'build',
    rationale: 'exercise the selected program budget', inheritedContext: [],
    budget: { maxDepth: 0, spawnedAt: Date.now() }, mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  }, {
    ...headLoopSeams(rt), model: chat.model, tools: {}, capture: new HeadCapture(), mission,
    workspaceLayout: 'private-scratch', isAborted: () => false,
  });

  expect(report.status).toBe('budget_exceeded');
  expect(chatModel.doStreamCalls).toHaveLength(1);
  expect(governor.snapshot('head-budget')[0]).toMatchObject({ calls: 1, spent: { tokens: 2 } });
});

test('cancelling one actor interrupts its cooperative tool without cancelling the other actor', async () => {
  const first = await fixture();
  const second = await fixture();
  const source = 'async function run() { await host.emit({ type: "text_delta", text: await host.callTool("hold", {}) }); }';
  await first.files.writeFile(first.rt.identity.scaffold.path + '.v1', source);
  await second.files.writeFile(second.rt.identity.scaffold.path + '.v1', source);
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<string>();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const inputSchema = jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false });

  const firstTurn = await admitActorTurn({
    runtime: first.rt, mode: 'build', task: 'first', loopVersion: 1,
    chat: { ...first.chat, signal: firstAbort.signal, tools: { hold: tool({ inputSchema,
      execute: (_input, { abortSignal }) => {
        firstStarted.resolve();

        if (abortSignal === undefined) throw new Error('the tool has no actor cancellation signal');

        return new Promise<string>((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => { reject(abortSignal.reason); }, { once: true });
        });
      },
    }) } },
  });

  const secondTurn = await admitActorTurn({
    runtime: second.rt, mode: 'build', task: 'second', loopVersion: 1,
    chat: { ...second.chat, signal: secondAbort.signal, tools: { hold: tool({ inputSchema,
      execute: async (_input, { abortSignal }) => {
        secondStarted.resolve();
        const answer = await releaseSecond.promise;
        abortSignal?.throwIfAborted();

        return answer;
      },
    }) } },
  });

  const firstFailures: string[] = [];

  const firstDone = (async () => {
    for await (const event of firstTurn.events) if (event.type === 'tool-result' && !event.success) firstFailures.push(event.result);
  })();

  const secondDone = text(secondTurn.events);
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  firstAbort.abort(new Error('stopped actor one'));
  releaseSecond.resolve('other actor finished');
  await firstDone;
  expect(firstFailures.join('\n')).toContain('stopped actor one');
  expect(await secondDone).toBe('other actor finished');
  expect(secondAbort.signal.aborted).toBe(false);
});

test('the selected loop cancels its cooperative model request with the actor', async () => {
  const { rt, files, chat } = await fixture();
  await files.writeFile(rt.identity.scaffold.path + '.v1', 'async function run() { await host.llmStream({ system: "sys", messages: [{ role: "user", content: "wait" }] }); }');
  const started = Promise.withResolvers<void>();
  const request = Promise.withResolvers<never>();
  let providerStopped = false;

  const waitingModel = scriptedTurnModel({ doGenerate: options => {
    started.resolve();
    const signal = options.abortSignal;

    if (signal !== undefined) signal.addEventListener('abort', () => {
      providerStopped = true;
      request.reject(signal.reason);
    }, { once: true });

    return request.promise;
  } });

  const abort = new AbortController();

  const admitted = await admitActorTurn({ runtime: rt, mode: 'build', task: 'wait', loopVersion: 1,
    chat: { ...chat, model: waitingModel, signal: abort.signal } });

  const done = text(admitted.events);
  await started.promise;
  abort.abort(new Error('stop this actor model request'));

  try {
    expect(providerStopped).toBe(true);
  } finally {
    // A disconnected signal must fail without leaving a provider running.
    request.reject(new Error('release the test provider'));
    await done;
  }

  expect(await done).toBe('');
  expect(waitingModel.doStreamCalls).toHaveLength(1);
});
