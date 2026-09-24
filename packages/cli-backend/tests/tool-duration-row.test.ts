/** The ledger's `tool_call_end` row carries `durationMs`, read back off `run_events` through `LocalAgentSession`. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import { initWorkspaceSchema, type LLMProviderConfig } from '@kinu.run/core';
import type { LanguageModelV2Usage } from '@ai-sdk/provider';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';
import * as v from 'valibot';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/** Calls the memory tool once, then answers. */
function searchingModel(): TestLanguageModelV2 {
  let calls = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      const step = calls++;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (step === 0) {
              controller.enqueue({
                type: 'tool-call', toolCallId: 'call-search', toolName: 'memory',
                input: JSON.stringify({ action: 'search', query: 'probe' }),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'nothing stored' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

describe('tool_call_end', () => {
  test('carries the call\'s duration on the shared loop', async () => {
    const db = new Database(scratchPath('tool-duration-row', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
    const session = new LocalAgentSession({ rt, db, model: searchingModel(), noAutoEvolve: true, onEvent: () => {} });

    await session.send('What do you remember?', { id: crypto.randomUUID() });
    await session.end();

    const rows = db.query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'tool_call_end' ORDER BY rowid").all()
      .map((row) => v.parse(v.object({ name: v.string(), durationMs: v.optional(v.number()) }), JSON.parse(row.payload)));

    expect(rows.map((row) => row.name)).toEqual(['memory']);
    // Whether the row has a duration is the property, not how long the fake took.
    expect(rows[0]?.durationMs).toBeNumber();
    expect(Number.isFinite(rows[0]?.durationMs)).toBe(true);
    db.close();
  });
});
