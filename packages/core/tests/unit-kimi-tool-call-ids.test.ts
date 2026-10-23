// Kimi K2 is sent its earlier tool calls as `functions.<tool>:<n>` (src/providers/middleware/kimi-tool-call-ids.ts):
// under ours it often spelled its next call after them, and Workers AI dropped what it could not parse (staging, 2026-10-23).
import { describe, expect, test } from 'bun:test';
import { generateText, jsonSchema, tool, type ModelMessage } from 'ai';
import { createWorkersAIProvider } from '../src/providers/workers-ai-provider';
import { withModelStack } from '../src/providers/wire-model';
import type { ModelCallDeps } from '../src/providers/types';

/** A turn's history after two steps, under the ids replay normalization sends every model (`kinu-i-<n>`). */
const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'Build a bakery page and hire a helper for the stylesheet.' },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'kinu-i-1', toolName: 'tasks', input: { op: 'add', titles: ['page'] } }],
  },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'kinu-i-1', toolName: 'tasks', output: { type: 'json', value: { added: 1 } } }],
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Writing the page and hiring the helper.' },
      { type: 'tool-call', toolCallId: 'kinu-i-2', toolName: 'file', input: { op: 'write', path: 'index.html', content: '<h1>Bakery</h1>' } },
      { type: 'tool-call', toolCallId: 'kinu-i-3', toolName: 'agents', input: { op: 'hire', role: 'task', message: 'styles.css' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'kinu-i-3', toolName: 'agents', output: { type: 'json', value: { hired: 'css-helper' } } },
      { type: 'tool-result', toolCallId: 'kinu-i-2', toolName: 'file', output: { type: 'json', value: { written: 'index.html' } } },
    ],
  },
  { role: 'user', content: 'Runtime state update.' },
];

const anyInput = () => tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }) });

const TOOLS = { tasks: anyInput(), file: anyInput(), agents: anyInput() };


interface SentMessage {
  readonly role: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly { readonly id: string }[];
}

/** The tool-call ids the deployment's binding was sent for `modelId`, in message order. */
async function sentIds(modelId: string): Promise<string[]> {
  const sent: SentMessage[] = [];

  const binding = {
    run: async (_model: string, inputs: { readonly messages: readonly SentMessage[] }) => {
      sent.push(...inputs.messages);

      return { response: 'Done.', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
    },
  };

  const deps: ModelCallDeps = { env: {}, sessionAffinity: 'kinu-stub', workspaceAffinity: 'kinu-stub', getAuth: async () => null, hasCredential: async () => false };
  const model = withModelStack(createWorkersAIProvider(Object.create(binding)).createModel(modelId, deps), { provider: 'workers-ai', lane: 'workers-ai|' });

  await generateText({ model, messages: HISTORY, tools: TOOLS, maxRetries: 0 });

  return sent.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? (message.tool_call_id === undefined ? [] : [message.tool_call_id]));
}

describe('a Kimi K2 model is sent its earlier tool calls under the ids its template numbers', () => {
  test('each call `functions.<tool>:<n>` in the order made, and each result under its own call\'s id', async () => {
    expect(await sentIds('@cf/moonshotai/kimi-k2.6')).toEqual([
      'functions.tasks:0', 'functions.tasks:0',
      'functions.file:1', 'functions.agents:2',
      'functions.agents:2', 'functions.file:1',
    ]);
  });

  test('another model is sent them as they came', async () => {
    expect(await sentIds('@cf/zai-org/glm-5.3')).toEqual(['kinu-i-1', 'kinu-i-1', 'kinu-i-2', 'kinu-i-3', 'kinu-i-3', 'kinu-i-2']);
  });
});
