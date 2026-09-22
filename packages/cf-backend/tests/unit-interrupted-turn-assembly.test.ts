// Defends: an interrupted mid-tool-call turn bricking every later turn with
// `AI_MissingToolResultsError`; the assembled request must pair every tool call.
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { INTERRUPTED_TOOL_RESULT } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns } from './helpers/actor-harness';

const ORPHAN_ID = 'call_ed15d29f352a4735e6b01b5';

const interruptedHistory: ModelMessage[] = [
  { role: 'user', content: 'check the repo' },
  { role: 'assistant', content: [
    { type: 'text', text: 'checking the tree' },
    { type: 'tool-call', toolCallId: ORPHAN_ID, toolName: 'shell', input: { command: 'git status' } },
  ] },
  { role: 'user', content: 'hello?' },
];

describe('the cf turn over an interrupted history', () => {
  test('hands the model a terminal result for the orphaned call', async () => {
    const { agent } = orchestratorHarness();

    const config = await chatSessionTurns(agent).prepare({ messages: interruptedHistory });
    const assembled = config.prompt;
    expect(assembled.length).toBeGreaterThan(0);

    // The exact condition `convertToLanguageModelPrompt` enforces.
    const unpaired = new Set<string>();

    for (const message of assembled) {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'tool-call' && part.providerExecuted !== true) unpaired.add(part.toolCallId);
        }
      } else if (message.role === 'tool') {
        for (const part of message.content) {
          if (part.type === 'tool-result') unpaired.delete(part.toolCallId);
        }
      }
    }

    expect([...unpaired]).toEqual([]);

    // Found by what the call is, not its stored id: the request is re-keyed for
    // its destination provider before the model sees it.
    const orphan = assembled.flatMap((message) => message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === 'tool-call' && part.toolName === 'shell' ? [part] : []) : []);

    expect(orphan).toHaveLength(1);

    const results = assembled.flatMap((message) => message.role === 'tool'
      ? message.content.filter((part) => part.type === 'tool-result') : []);

    expect(results.find((r) => r.toolCallId === orphan[0]?.toolCallId)?.output)
      .toEqual({ type: 'error-text', value: INTERRUPTED_TOOL_RESULT });

    // The stored history is not rewritten: a read path stays a read path.
    expect(interruptedHistory).toHaveLength(3);
    expect(interruptedHistory[1]?.role).toBe('assistant');
  });
});
