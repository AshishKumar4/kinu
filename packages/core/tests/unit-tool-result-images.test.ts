/**
 * An image a tool returns reaches a model that takes images, on every wire API; a model that takes none, or one
 * whose media are unknown on Chat Completions, gets a note in its place and never the base64 as text.
 */
import { describe, expect, test } from 'bun:test';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Message } from '@ai-sdk/provider';
import { createProviderRegistry, type ModelInputModality, type ModelCallDeps } from '../src/index';
import { present } from '@kinu.run/test-utils';
import { toolImages, withToolResultImages } from '../src/providers/tool-result-images';

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
async function sentPrompt(provider: string, accepts?: ReadonlySet<ModelInputModality>, messages: ModelMessage[] = HISTORY, spec?: string): Promise<LanguageModelV4Message[]> {
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
  const deps: ModelCallDeps = { env: {}, sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false };
  const resolved = registry.resolve('probe/m', deps);

  await generateText({ model: accepts === undefined ? resolved : withToolResultImages(resolved, accepts, spec), messages });

  return sent[0]?.prompt ?? [];
}

const toolPart = (prompt: readonly LanguageModelV4Message[]) => prompt.find((message) => message.role === 'tool')?.content[0];

/** A PNG's header naming `width` x `height`, base64: what a provider and `rasterImage` read a size from. */
function png(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);

  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);

  return Buffer.from(bytes).toString('base64');
}

/** `count` turns, each a user image and a screenshot the agent took; the first user image is a Mac screenshot. */
function imageTurns(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, at): ModelMessage[] => [
    { role: 'user', content: [{ type: 'text', text: `look ${String(at)}` }, { type: 'image', image: at === 0 ? png(3456, 2234) : png(800, 600), mediaType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${String(at)}`, toolName: 'web', input: { op: 'screenshot' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${String(at)}`, toolName: 'web', output: { type: 'content', value: [{ ...IMAGE, data: { type: 'data' as const, data: png(1280, 800) } }] } }] },
  ]).flat();
}

/** How many images the request carries, and whether the Mac screenshot (the first message's) is one of them. */
function carried(prompt: readonly LanguageModelV4Message[]) {
  const images = prompt.map((message) => {
    if (message.role === 'user') return message.content.filter((part) => part.type === 'file').length;

    if (message.role !== 'tool') return 0;

    return message.content.reduce((sum, part) => sum + (part.type === 'tool-result' && part.output.type === 'content' ? part.output.value.filter((item) => item.type === 'file').length : 0), 0);
  });

  return { images: images.reduce((sum, count) => sum + count, 0), screenshot: (images[0] ?? 0) > 0 };
}

// Owner's workspace, 2026-11-08: in a request of more than 20 images, Claude refused a 3,456 px screenshot with a 400,
// and every later turn of the chat repeated it. On every route to Claude, only that image is left out.
test.each([
  ['anthropic.messages', 'claude/claude-opus-4-7', 21, false],
  ['openrouter.chat', 'openrouter/anthropic/claude-sonnet-4.5', 21, false],
  ['my-gateway', 'my-gateway/anthropic/claude-opus-4-7', 21, false],
  ['opencode-go.chat', 'opencode-go/claude-haiku-5-5', 21, false],
  ['workers-ai.chat', 'workers-ai/@cf/anthropic/claude-sonnet-4-5', 21, false],
  ['openrouter.chat', 'openrouter/other-vendor/claude-distill', 22, true],
  ['openai.responses', 'openai/gpt-5', 22, true],
])('a request of 22 images through %s for %s carries %i, the oversized screenshot: %p', async (provider, spec, images, screenshot) => {
  expect(carried(await sentPrompt(provider, new Set(['image']), imageTurns(11), spec))).toEqual({ images, screenshot });
});

// A turn's screenshots rotate (compaction's step images): with 17 earlier images, the request crosses 20 and back
// each rotation. An image left out stays out while the call holds it, so the prompt's prefix does not flip.
test('an oversized image left out once stays out as the turn rotates its screenshots across 20', async () => {
  const image = (data: string): LanguageModelV4Message => ({ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data } }] });
  const earlier = [image(png(3456, 2234)), ...Array.from({ length: 16 }, () => image(png(800, 600)))];
  const middleware = toolImages(new Set(['image']), 'claude/claude-opus-4-7');
  const transform = present(middleware.transformParams, 'the middleware transforms params');

  const sent = async (current: number) => {
    const params = await transform({ type: 'stream', params: { prompt: [...earlier, ...Array.from({ length: current }, () => image(png(1280, 800)))] }, model: new MockLanguageModelV4({ provider: 'anthropic.messages' }) });

    return params.prompt[0]?.role === 'user' && params.prompt[0].content[0]?.type === 'file';
  };

  expect([await sent(3), await sent(7), await sent(3), await sent(7), await sent(3)]).toEqual([true, false, false, false, false]);
});

test('a request to Claude of 20 images carries the oversized screenshot too', async () => {
  expect(carried(await sentPrompt('anthropic.messages', new Set(['image']), imageTurns(10), 'claude/claude-opus-4-7'))).toEqual({ images: 20, screenshot: true });
});

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
    expect(JSON.stringify(prompt)).not.toContain(IMAGE.data.data);
  });
});
