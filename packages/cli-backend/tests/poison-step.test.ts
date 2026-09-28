/**
 * A step that resets the workspace every time it runs is not run a third time: the turn closes with the cause, and
 * the model is not called again. Each "reset" here is a session abandoned while its model call hangs.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initWorkspaceSchema, type LLMProviderConfig } from '@kinu.run/core';
import { scratchPath } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

/** Polls `holds`; a turn that re-runs its step instead of closing never satisfies the last wait. */
async function until(holds: () => boolean): Promise<void> {
  for (let lap = 0; !holds(); lap += 1) {
    if (lap > 20_000) throw new Error('the awaited state never came');
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

test('a step that reset the workspace on each of its runs closes, naming the cause, and is not run again', async () => {
  const db = new Database(scratchPath('poison-step', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { llm: DUMMY_LLM });
  let calls = 0;

  // The step never returns: the process running it dies first.
  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: () => {
      calls += 1;

      return new Promise(() => {});
    },
  });

  const first = new LocalAgentSession({ rt, db, model, noAutoEvolve: true, onEvent: () => {} });
  const cut = first.send('rebuild the index', { id: crypto.randomUUID() });
  await until(() => calls === 1);

  // The next process resumes the open turn, and its step resets the workspace again.
  const second = new LocalAgentSession({ rt, db, model, noAutoEvolve: true, onEvent: () => {} });
  await until(() => calls === 2);

  const events: SessionEvent[] = [];
  const third = new LocalAgentSession({ rt, db, model, noAutoEvolve: true, onEvent: (event) => events.push(event) });
  await until(() => events.some((event) => event.type === 'turn-end'));

  expect(calls).toBe(2);
  expect(JSON.stringify(events)).toContain('reset the workspace 3 times');
  await Promise.all([first.end(), second.end(), third.end(), Promise.race([cut, Promise.resolve()])]);
  db.close();
});
