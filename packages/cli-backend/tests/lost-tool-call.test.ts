/**
 * A reset between a claimed call's effect and its result: the next process keeps the step the call belongs to, runs
 * the effect no second time, and tells the model the call may have taken effect (DESIGN reds 1 and 3; the owner's
 * approved item 6). The effect is an MCP tool, reached through `eval`, that marks a file and never answers, so the first
 * process dies inside it.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { initWorkspaceSchema, mcpToolKey, type LLMProviderConfig } from '@kinu.run/core';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider';
import { scratchPath } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

const SERVERS = { marker: { command: 'node', args: [new URL('./fixtures/mark-mcp-server.mjs', import.meta.url).pathname] } };

type Prompt = LanguageModelV2CallOptions['prompt'];

function model(steps: readonly (() => LanguageModelV2StreamPart[])[], prompts: Prompt[]): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ prompt }) => {
      // Past its script the model answers, so a turn never loops (a turn has no step bound).
      const parts = (steps[prompts.length] ?? answer)();
      prompts.push(prompt);

      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }), response: { headers: {} } };
    },
  });
}

const markCall = (path: string) => (): LanguageModelV2StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  {
    type: 'tool-call', toolCallId: 'call-mark', toolName: 'eval',
    input: JSON.stringify({ code: `return await tools[${JSON.stringify(mcpToolKey('marker', 'mark'))}](${JSON.stringify({ path })});` }),
  },
  { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
];

const answer = (): LanguageModelV2StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'checked' },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: 'stop', usage: USAGE },
];

async function until(holds: () => boolean): Promise<void> {
  while (!holds()) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

test('a call cut off after its effect runs once, and the model is told it may have taken effect', async () => {
  const db = new Database(scratchPath('lost-tool-call', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { llm: DUMMY_LLM });
  const marks = scratchPath('lost-tool-call', 'marks.txt');
  const lines = () => existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0;

  rt.actor.config.setLearning(false);
  let dyingEnded = false;

  const dying = new LocalAgentSession({
    rt, db, model: model([markCall(marks)], []),
    onEvent: (event) => { dyingEnded ||= event.type === 'turn-end'; },
  });

  await dying.connectMcp(SERVERS);
  const dead = dying.send('mark the file', { id: crypto.randomUUID() });
  // Ends on the mark, or on the dying turn's own end if its call never ran, so a mismatch fails instead of spinning.
  await until(() => lines() === 1 || dyingEnded);
  expect(lines()).toBe(1);

  const prompts: Prompt[] = [];
  const events: SessionEvent[] = [];
  const next = new LocalAgentSession({ rt, db, model: model([answer], prompts), onEvent: (event) => events.push(event) });
  await next.connectMcp(SERVERS);
  await until(() => events.some((event) => event.type === 'turn-end'));
  await next.end();

  expect(lines()).toBe(1);
  const results = (prompts[0] ?? []).flatMap((message) => message.role === 'tool' ? message.content : []);
  // The provider sees the call under its portable id; the refusal names the original.
  expect(results).toEqual([expect.objectContaining({
    toolName: 'eval',
    output: { type: 'error-text', value: expect.stringMatching(/may or may not have taken effect\..*the call is call-mark/u) },
  })]);

  // Ending the dead process's session disconnects its server, which fails the open call.
  await dying.end();
  await Promise.race([dead, Promise.resolve()]);
  db.close();
});
