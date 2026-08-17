import { describe, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model.js';
import type { LLMProviderConfig } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

function workspaceRuntime() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db, { dbPath: `/tmp/proteus-scratch-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM });
  return { db, rt };
}

function runThenAnswerModel(confirmWith: 'text' | 'tool' = 'text'): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;
  const answer = (controller: ReadableStreamDefaultController, text: string) => {
    controller.enqueue({ type: 'text-start', id: '0' });
    controller.enqueue({ type: 'text-delta', id: '0', delta: text });
    controller.enqueue({ type: 'text-end', id: '0' });
    controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
  };
  const call = (controller: ReadableStreamDefaultController, id: string, command: string) => {
    controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: 'run', input: JSON.stringify({ command }) });
    controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
  };
  return new TestLanguageModelV2({
    provider: 'fake', modelId: 'fake-model',
    doStream: async () => {
      step += 1;
      const at = step;
      console.log('[scratch] doStream step', at);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (at === 1) call(controller, 'call-1', 'echo working');
            else if (at === 2) answer(controller, 'all done, the task is complete');
            else if (at === 3 && confirmWith === 'tool') call(controller, 'call-2', 'echo fixing');
            else answer(controller, 'confirmed');
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

describe('scratch', () => {
  test('gate run dump', async () => {
    const { db, rt } = workspaceRuntime();
    const events: SessionEvent[] = [];
    const session = new LocalAgentSession({
      rt, db, model: runThenAnswerModel('tool'), onEvent: (e) => events.push(e),
      noAutoEvolve: true, oneShot: true,
    });
    await session.send('write the report');
    await session.settleBackgroundWork();
    for (const r of session.listRuns()) {
      console.log('[scratch] run', r.runId, JSON.stringify(session.getRunEvents(r.runId), null, 1));
    }
    console.log('[scratch] session events', JSON.stringify(
      events.filter((e) => e.type === 'error' || e.type === 'turn-end'), null, 1).slice(0, 4000));
    await session.end();
  });
});
