/**
 * An image a tool returns reaches a model that takes images, on every wire API; a model that takes none, or one
 * whose media are unknown on Chat Completions, gets a note in its place and never the base64 as text.
 */
import { describe, expect, test } from 'bun:test';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Message } from '@ai-sdk/provider';
import { createProviderRegistry, type ModelInputModality, type ModelCallDeps } from '../src/index';
import { withToolResultImages } from '../src/providers/tool-result-images';

const IMAGE = { type: 'file' as const, data: { type: 'data' as const, data: 'iVBORw0KGgo=' }, mediaType: 'image/png' };

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'screenshot example.com' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'web', input: { op: 'screenshot', url: 'https://example.com/' } }] },
  {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: 'c1', toolName: 'web',
      output: { type: 'content', value: [{ type: 'text', text: 'Screenshot of https://example.com/' }, IMAGE] },
    }],
  },
];

/**
 * The prompt a model resolved through the registry as `provider` receives; `accepts` is the media the turn knows
 * the model takes, as chat.ts passes them, or undefined where it does not know.
 */
async function sentPrompt(provider: string, accepts?: ReadonlySet<ModelInputModality>): Promise<LanguageModelV4Message[]> {
  const sent: LanguageModelV4CallOptions[] = [];

  const model = new MockLanguageModelV4({
    provider,
    doGenerate: async (options) => {
      sent.push(options);

      return { content: [{ type: 'text', text: 'seen' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    },
  });

  const registry = createProviderRegistry();
  registry.register({ id: 'probe', isAvailable: () => true, listModels: () => [], createModel: (): LanguageModel => model });
  const deps: ModelCallDeps = { env: {}, sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false };
  const resolved = registry.resolve('probe/m', deps);

  await generateText({ model: accepts === undefined ? resolved : withToolResultImages(resolved, accepts), messages: HISTORY });

  return sent[0]?.prompt ?? [];
}

const toolPart = (prompt: readonly LanguageModelV4Message[]) => prompt.find((message) => message.role === 'tool')?.content[0];

describe('a tool result image', () => {
  test.each(['anthropic.messages', 'openai.responses'])('reaches a %s model inside the tool result', async (provider) => {
    const prompt = await sentPrompt(provider, new Set(['image']));

    expect(toolPart(prompt)).toMatchObject({ output: { type: 'content', value: [{ type: 'text' }, IMAGE] } });
  });

  test('reaches a Chat Completions model that takes images in a user message right after the tool results', async () => {
    const prompt = await sentPrompt('workers-ai.chat', new Set(['image']));

    expect(prompt.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(toolPart(prompt)).toMatchObject({ output: { type: 'text', value: expect.stringContaining('Screenshot of https://example.com/') } });
    expect(prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text' }, IMAGE] });
  });

  test.each([
    ['a Chat Completions model that takes no image', 'workers-ai.chat', new Set<ModelInputModality>()],
    ['a Chat Completions model whose media are unknown', 'openai.chat', undefined],
    ['an Anthropic model that takes no image', 'anthropic.messages', new Set<ModelInputModality>()],
  ])('reaches %s as a note that it was left out, never as base64', async (_name, provider, accepts) => {
    const prompt = await sentPrompt(provider, accepts);

    expect(prompt.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(toolPart(prompt))).toContain('image omitted');
    expect(JSON.stringify(prompt)).not.toContain(IMAGE.data.data);
  });
});
