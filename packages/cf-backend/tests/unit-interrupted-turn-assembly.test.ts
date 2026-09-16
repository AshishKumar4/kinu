// The cf turn driver's own assembly must satisfy the AI SDK's tool-call pairing
// contract, because that is where the owner's session died: he interrupted a
// turn mid-tool-call and every later turn failed with
// `AI_MissingToolResultsError: Tool result is missing for tool call
// call_ed15d29f352a4735e6b01b5.` — thrown by `convertToLanguageModelPrompt`
// inside `streamText`, client-side, before any request leaves the isolate.
//
// The loop's runner assembles the request the model is called with (core
// chat.ts → assembleTurnMessages → settleUnpairedToolCalls), so the pairing
// invariant has to hold on THAT request, whatever the stored transcript looks
// like. This drives the real OrchestratorAgent's turn through the actor
// harness with a history that already holds an orphaned call — the shape a
// bricked workspace is in right now — and asserts what the model was handed.
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { INTERRUPTED_TOOL_RESULT } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns } from './helpers/actor-harness';

const ORPHAN_ID = 'call_ed15d29f352a4735e6b01b5';

/** A turn whose durable history was left mid-tool-call by an interrupt. */
const interruptedHistory: ModelMessage[] = [
  { role: 'user', content: 'check the repo' },
  { role: 'assistant', content: [
    { type: 'text', text: 'checking the tree' },
    { type: 'tool-call', toolCallId: ORPHAN_ID, toolName: 'run', input: { command: 'git status' } },
  ] },
  { role: 'user', content: 'hello?' },
];

describe('the cf turn over an interrupted history', () => {
  test('hands the model a terminal result for the orphaned call', async () => {
    const { agent } = orchestratorHarness();

    const config = await chatSessionTurns(agent).prepare({ messages: interruptedHistory });
    // What the model was actually called with at its first step.
    const assembled = config.prompt;
    expect(assembled.length).toBeGreaterThan(0);

    // Every non-provider-executed tool call in the assembled request has a
    // result — the exact condition `convertToLanguageModelPrompt` enforces.
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

    // And the result says the turn was cut, rather than pretending the call was
    // never made or that it definitely did not run.
    // The call is found by what it IS, not by the id it was stored under: the
    // request is re-keyed for its destination provider before the model sees
    // it, and the pairing rides the new ids.
    const orphan = assembled.flatMap((message) => message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap((part) => part.type === 'tool-call' && part.toolName === 'run' ? [part] : []) : []);

    expect(orphan).toHaveLength(1);

    const results = assembled.flatMap((message) => message.role === 'tool'
      ? message.content.filter((part) => part.type === 'tool-result') : []);

    expect(results.find((r) => r.toolCallId === orphan[0]?.toolCallId)?.output)
      .toEqual({ type: 'error-text', value: INTERRUPTED_TOOL_RESULT });

    // The stored history is not rewritten: assembly builds the request, and a
    // read path stays a read path.
    expect(interruptedHistory).toHaveLength(3);
    expect(interruptedHistory[1]?.role).toBe('assistant');
  });
});
