/**
 * An image a tool returns reaches the model only on a wire API that carries one in a tool result. Chat Completions
 * sends a `content` tool output as its JSON text, so without the rewrite a screenshot arrives as base64 characters.
 */
import { describe, expect, test } from 'bun:test';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { createProviderRegistry, type ProviderDeps } from '../src/index';

const IMAGE = { type: 'image-data' as const, data: 'iVBORw0KGgo=', mediaType: 'image/png' };

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'screenshot example.com' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'web', input: { action: 'screenshot', url: 'https://example.com/' } }] },
  {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: 'c1', toolName: 'web',
      output: { type: 'content', value: [{ type: 'text', text: 'Screenshot of https://example.com/' }, IMAGE] },
    }],
  },
];

/** The tool-result parts of the prompt a model resolved as `provider` receives. */
async function sentToolResult(provider: string) {
  const sent: LanguageModelV3CallOptions[] = [];

  const model = new MockLanguageModelV3({
    provider,
    doGenerate: async (options) => {
      sent.push(options);

      return { content: [{ type: 'text', text: 'seen' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    },
  });

  const registry = createProviderRegistry();
  registry.register({ id: 'probe', isAvailable: () => true, listModels: () => [], createModel: (): LanguageModel => model });
  const deps: ProviderDeps = { env: {}, getAuth: async () => null, hasCredential: async () => false };

  await generateText({ model: registry.resolve('probe/m', deps), messages: HISTORY });
  const tool = sent[0]?.prompt.find((message) => message.role === 'tool');

  return tool?.role === 'tool' ? tool.content : [];
}

describe('a tool result image', () => {
  test.each(['anthropic.messages', 'openai.responses'])('reaches a %s model as an image', async (provider) => {
    const [part] = await sentToolResult(provider);

    expect(part).toMatchObject({ output: { type: 'content', value: [{ type: 'text' }, IMAGE] } });
  });

  test.each(['workers-ai.chat', 'openai.chat'])('reaches a %s model as a note that it was left out, never as base64', async (provider) => {
    const [part] = await sentToolResult(provider);

    expect(part).toMatchObject({
      output: { type: 'content', value: [{ type: 'text' }, { type: 'text', text: expect.stringContaining('image omitted') }] },
    });
    expect(JSON.stringify(part)).not.toContain(IMAGE.data);
  });
});
