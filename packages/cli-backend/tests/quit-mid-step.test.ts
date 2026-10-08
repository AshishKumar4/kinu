/**
 * Quitting the CLI while a slow first model call is in flight, twice, does not end the owner's turn: the next session
 * resumes it and the step runs again. Each quit here is a session abandoned while its model call hangs.
 */
import { expect, test } from 'bun:test';
import { initWorkspaceSchema, type LLMProviderConfig } from '@kinu.run/core';
import { scratchPath, scratchDir, workspaceDatabase } from '@kinu.run/test-utils';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const ANSWER = 'The index is rebuilt.';

async function until(holds: () => boolean): Promise<void> {
  for (let lap = 0; !holds(); lap += 1) {
    if (lap > 20_000) throw new Error('the awaited state never came');
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

function answer(): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: '0' });
      controller.enqueue({ type: 'text-delta', id: '0', delta: ANSWER });
      controller.enqueue({ type: 'text-end', id: '0' });
      controller.enqueue({
        type: 'finish', finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      controller.close();
    },
  });
}

test('a turn whose slow first call was cut by two quits is resumed and answers', async () => {
  const db = workspaceDatabase(scratchPath('quit-mid-step', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
  let calls = 0;

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: () => {
      calls += 1;

      if (calls <= 2) return Promise.withResolvers<never>().promise;

      return Promise.resolve({ stream: answer() });
    },
  });

  rt.actor.config.setLearning(false);
  const first = new LocalAgentSession({ rt, db, model, onEvent: () => {} });
  const cut = first.send('rebuild the index', { id: crypto.randomUUID() });
  await until(() => calls === 1);

  rt.actor.config.setLearning(false);
  const second = new LocalAgentSession({ rt, db, model, onEvent: () => {} });
  await until(() => calls === 2);

  const events: SessionEvent[] = [];
  rt.actor.config.setLearning(false);
  const third = new LocalAgentSession({ rt, db, model, onEvent: (event) => events.push(event) });
  await until(() => events.some((event) => event.type === 'turn-end'));

  expect(calls).toBe(3);
  expect(JSON.stringify(events)).toContain(ANSWER);
  await Promise.all([first.end(), second.end(), third.end(), Promise.race([cut, Promise.resolve()])]);
  db.close();
});
