/**
 * KINU-085, the hosted half. A conversation whose durable history was produced
 * by one provider is replayed to another the moment the owner (or a role tier)
 * resolves a different model, and the tool-call identifiers in that history were
 * minted by the provider that is no longer on the other end.
 *
 * Core owns the rewrite (`prompting/replay-normalization.ts`) and `runChat`
 * supplies it with the destination, so the CLI has done this since the module
 * landed. THIS backend does not run `runChat`: Think drives the loop and the
 * actor's `beforeStep` composes the same shared pipeline — so the pipeline's
 * destination input is the actor's to supply, and it was the one input the cloud
 * call site omitted. Every unit of the rewrite stayed green while no hosted
 * request was ever normalized.
 *
 * Driven through `beforeStep`, the real Think hook streamText calls, with this
 * actor's real registered extensions — the same entry point
 * `unit-mid-turn-steer.test.ts` drives. The harness cannot run a model turn and
 * does not need to: the request boundary is the assertion.
 */
import { describe, expect, test } from 'bun:test';
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { PrepareStepContext } from '@cloudflare/think';
import { isPortableToolCallId } from '@kinu.run/core';
import * as v from 'valibot';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** What the SOURCE provider named this call — Anthropic's own grammar, which no
 *  other family mints, so its presence on a request is unambiguous. */
const SOURCE_ID = 'toolu_01SourceMinted';
const SOURCE_REASONING = 'I should look this up.';
const SOURCE_REASONING_SIGNATURE = 'anthropic-source-signature';

/** The provider handle a live streamText also passes. `beforeStep` forwards only
 *  `stepNumber` and `messages` to the shared pipeline, so this is supplied as
 *  the model a step carries rather than asserted away. */
const HARNESS_MODEL = new MockLanguageModelV3();

/** The override half of a `PrepareStepResult`. `v.custom` keeps the element
 *  type without restating the SDK's message union, which is the same treatment
 *  `unit-mid-turn-steer.test.ts` gives the same value. */
const StepOverrideSchema = v.object({
  messages: v.array(v.custom<ModelMessage>(() => true)),
});

/** A completed call and its result, exactly as the previous turn persisted
 *  them: joined by the id the provider that ran them chose. */
const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'what is the answer' },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: SOURCE_REASONING,
        providerOptions: { anthropic: { signature: SOURCE_REASONING_SIGNATURE } },
      },
      { type: 'tool-call', toolCallId: SOURCE_ID, toolName: 'look', input: { topic: 'life' } },
    ],
  } satisfies AssistantModelMessage,
  {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: SOURCE_ID, toolName: 'look',
      output: { type: 'text', value: 'the answer is 41' },
    }],
  } satisfies ToolModelMessage,
  { role: 'assistant', content: 'the answer is 41' },
  { role: 'user', content: 'are you sure' },
];

/**
 * The messages one step actually carries.
 *
 * Awaited: the shared pipeline is promoted to a Promise whenever a registered
 * extension must finish I/O before the model sees its rewrite, and this actor
 * registers three. Reading the result synchronously would take a pending
 * Promise for "nothing changed" and pass whatever the input was.
 */
async function stepMessages(
  agent: HarnessOrchestratorAgent, messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const context: PrepareStepContext = {
    stepNumber: 0, messages, steps: [], model: HARNESS_MODEL, experimental_context: undefined,
  };
  const rewritten = v.safeParse(StepOverrideSchema, await agent.beforeStep(context));
  return rewritten.success ? rewritten.output.messages : messages;
}

/** Both halves of every tool call on a request, in wire order. */
function pairing(messages: readonly ModelMessage[]) {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') calls.push(part.toolCallId);
      if (part.type === 'tool-result') results.push(part.toolCallId);
    }
  }
  return { calls, results } as const;
}

describe('a hosted step whose history came from another provider', () => {
  test('is handed destination-neutral ids, still paired', async () => {
    const { agent } = orchestratorHarness();

    const carried = pairing(await stepMessages(agent, [...HISTORY]));

    // One call, one result, joined — the property a destination reads to decide
    // the call is finished rather than pending.
    expect(carried.calls).toHaveLength(1);
    expect(carried.results).toEqual(carried.calls);
    for (const id of carried.calls) expect(isPortableToolCallId(id)).toBe(true);
    // And the id belongs to the request, not to the provider that is no longer
    // answering it.
    expect(carried.calls).not.toContain(SOURCE_ID);
  });

  test('converts source reasoning to portable text and removes its signature', async () => {
    const { agent } = orchestratorHarness();

    const messages = await stepMessages(agent, [...HISTORY]);
    const assistant = messages.find((message) =>
      message.role === 'assistant' && Array.isArray(message.content));
    const content = assistant?.role === 'assistant' && Array.isArray(assistant.content)
      ? assistant.content
      : [];

    expect(content.some((part) => part.type === 'text' && part.text === SOURCE_REASONING)).toBe(true);
    expect(content.some((part) => part.type === 'reasoning')).toBe(false);
    expect(JSON.stringify(messages)).not.toContain(SOURCE_REASONING_SIGNATURE);
    expect(JSON.stringify(HISTORY)).toContain(SOURCE_REASONING_SIGNATURE);
  });

  test('pairs the same way on every step, so a re-issued request is stable', async () => {
    const { agent } = orchestratorHarness();

    const first = pairing(await stepMessages(agent, [...HISTORY]));
    const second = pairing(await stepMessages(agent, [...HISTORY]));

    expect(second).toEqual(first);
  });
});
