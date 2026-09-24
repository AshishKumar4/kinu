/** A turn a dead process left open is re-opened once, under the dead process's run, so a later restart finds nothing open. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import { initWorkspaceSchema, workspaceSkillPath, WORKSPACE_SKILLS_DIR, type LLMProviderConfig } from '@kinu.run/core';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

type PromptMessage = LanguageModelV2CallOptions['prompt'][number];

type Step = (abortSignal: AbortSignal | undefined) => ReadableStream<LanguageModelV2StreamPart>;

/** Streams `delta`, then holds the step open until the process running it dies. */
const parked = (delta: string): Step => (abortSignal) => new ReadableStream({
  async start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({ type: 'text-start', id: '0' });
    controller.enqueue({ type: 'text-delta', id: '0', delta });
    await new Promise<void>((resolve) => { abortSignal?.addEventListener('abort', () => resolve(), { once: true }); });
  },
});

const answer = (text: string): Step => () => new ReadableStream({
  start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({ type: 'text-start', id: '0' });
    controller.enqueue({ type: 'text-delta', id: '0', delta: text });
    controller.enqueue({ type: 'text-end', id: '0' });
    controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
    controller.close();
  },
});

const memoryCall = (toolCallId: string): Step => () => new ReadableStream({
  start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({ type: 'tool-call', toolCallId, toolName: 'memory', input: '{}' });
    controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
    controller.close();
  },
});

/** Call n streams `steps[n]`, or the last step once the list runs out; every prompt is kept. */
function scriptedModel(steps: readonly Step[], prompts: PromptMessage[][] = []): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ prompt, abortSignal }) => {
      const step = steps[Math.min(prompts.length, steps.length - 1)];
      prompts.push(prompt);

      if (step === undefined) throw new Error('a scripted model needs a step');

      return { stream: step(abortSignal), response: { headers: {} } };
    },
  });
}

function messageText(message: PromptMessage): string {
  if (message.role === 'system') return message.content;

  return message.content.map((part) => part.type === 'text' ? part.text : JSON.stringify(part)).join('');
}

async function waitFor(pred: () => boolean): Promise<void> {
  const until = Date.now() + 5000;

  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor: condition not met');
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 5);
    await tick.promise;
  }
}

describe('AN INTERRUPTED TURN CONTINUES — once', () => {
  test('the continuation seals the run it re-opened, so a third process re-opens nothing', async () => {
    const db = new Database(scratchPath('turn-continuation', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });

    const eventsA: SessionEvent[] = [];
    const a = new LocalAgentSession({ rt, db, model: scriptedModel([parked('part-')]), noAutoEvolve: true, onEvent: (event) => eventsA.push(event) });
    const dying = a.send('continue me', { id: crypto.randomUUID() });
    await waitFor(() => eventsA.some((event) => event.type === 'text-delta'));

    const eventsB: SessionEvent[] = [];
    const promptsB: PromptMessage[][] = [];
    const b = new LocalAgentSession({ rt, db, model: scriptedModel([answer('one')], promptsB), noAutoEvolve: true, onEvent: (event) => eventsB.push(event) });
    await waitFor(() => eventsB.some((event) => event.type === 'turn-end'));
    await b.end();
    expect(eventsB.filter((event) => event.type === 'background' && event.event === 'turn_reopened')).toHaveLength(1);
    expect(promptsB).toHaveLength(1);

    const runs = db.query<{ run_id: string; type: string }, []>("SELECT run_id, type FROM run_events WHERE type IN ('run_start', 'run_end') ORDER BY rowid").all();
    expect(runs.map((row) => row.type)).toEqual(['run_start', 'run_end']);
    expect(new Set(runs.map((row) => row.run_id)).size).toBe(1);

    const eventsC: SessionEvent[] = [];
    const promptsC: PromptMessage[][] = [];
    const c = new LocalAgentSession({ rt, db, model: scriptedModel([answer('never')], promptsC), noAutoEvolve: true, onEvent: (event) => eventsC.push(event) });
    await c.end();
    expect(eventsC.filter((event) => event.type === 'background' && event.event === 'turn_reopened')).toHaveLength(0);
    expect(promptsC).toHaveLength(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM conversation_entries WHERE role = 'assistant'").get()?.n).toBe(1);

    // The dead process is never resumed; racing its landing against the last close lets the test end without awaiting it.
    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });

  test('a re-opened turn keeps the person\u2019s request after this turn\u2019s runtime context on every step', async () => {
    const db = new Database(scratchPath('turn-continuation', 'agent.db'));
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
    await rt.storage.vfs.mkdir(`${WORKSPACE_SKILLS_DIR}/focused`, { recursive: true });
    await rt.storage.vfs.writeFile(workspaceSkillPath('focused'), '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n');

    // The dead process keeps one finished step and dies inside the next.
    const promptsA: PromptMessage[][] = [];
    const a = new LocalAgentSession({ rt, db, model: scriptedModel([memoryCall('kept'), parked('part-')], promptsA), noAutoEvolve: true, onEvent: () => {} });
    const dying = a.send('/focused remember this', { id: crypto.randomUUID() });
    await waitFor(() => promptsA.length === 2);

    const eventsB: SessionEvent[] = [];
    const promptsB: PromptMessage[][] = [];
    const b = new LocalAgentSession({ rt, db, model: scriptedModel([memoryCall('resumed'), answer('done')], promptsB), noAutoEvolve: true, onEvent: (event) => eventsB.push(event) });
    await waitFor(() => eventsB.some((event) => event.type === 'turn-end'));
    await b.end();
    expect(eventsB.filter((event) => event.type === 'background' && event.event === 'turn_reopened')).toHaveLength(1);
    expect(promptsB).toHaveLength(2);

    for (const prompt of promptsB) {
      const roles = prompt.map((message) => message.role);
      const users = prompt.flatMap((message) => message.role === 'user' ? [messageText(message)] : []);
      const activation = users.findIndex((text) => text.includes('## Skills activated this turn'));

      // The kept steps follow the request; the dynamic block and the activation ride before it, never after them.
      expect(activation).toBeGreaterThanOrEqual(0);
      expect(users.slice(activation + 1)).toEqual(['/focused remember this']);
      expect(roles.lastIndexOf('user')).toBeLessThan(roles.indexOf('tool'));
    }

    await Promise.race([dying, Promise.resolve()]);
    db.close();
  });
});
