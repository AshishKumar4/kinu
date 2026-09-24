import { describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { Database } from 'bun:sqlite';
import { generateText, streamText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { LLMProviderConfig } from '@kinu.run/core';
import {
  createClaudeCliProvider,
  buildClaudePrompt,
  type ClaudeSpawn,
  type SpawnedClaude,
} from '../src/claude-cli-provider';
import { createLocalModelResolver } from '../src/model-resolver';
import { createCLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider';
import { present, scratchPath } from '@kinu.run/test-utils';

/** Anthropic `usage`: input, cache reads and cache writes are disjoint. `null` means unreported and must not become zeros. */
interface UsageFixture { inputTokens?: number; outputTokens?: number; cacheRead?: number }

function streamJsonLines(text: string, usage: UsageFixture | null = {}): string {
  const startLine = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });

  const deltaLines = chunk(text).map((piece) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
    }));

  const base = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: text,
    stop_reason: 'end_turn',
  };

  const resultLine = JSON.stringify(usage
    ? {
      ...base,
      usage: {
        input_tokens: usage.inputTokens ?? 11,
        output_tokens: usage.outputTokens ?? 7,
        cache_read_input_tokens: usage.cacheRead ?? 2131,
      },
    }
    : base);

  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', tools: [] }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
    startLine,
    ...deltaLines,
    resultLine,
  ].join('\n') + '\n';
}

function chunk(text: string): string[] {
  if (text.length <= 2) return [text];
  const mid = Math.ceil(text.length / 2);

  return [text.slice(0, mid), text.slice(mid)];
}

interface FakeProc {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  hangUntilAbort?: boolean;
}

interface FakeSpawn {
  spawn: ClaudeSpawn;
  readonly calls: string[][];
  readonly killed: number;
}

function fakeSpawn(handler: (args: string[]) => FakeProc): FakeSpawn {
  const calls: string[][] = [];
  const state = { killed: 0 };

  const spawn: ClaudeSpawn = (args, opts) => {
    calls.push(args);
    const proc = handler(args);
    let killed = false;

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      if (proc.hangUntilAbort) {
        opts.signal?.addEventListener('abort', () => {
          killed = true;
          state.killed++;
          resolve({ code: null, signal: 'SIGTERM' });
        });

        return;
      }

      queueMicrotask(() => resolve({
        code: proc.code === undefined ? 0 : proc.code,
        signal: proc.signal ?? null,
      }));
    });

    async function* lines(value: string | undefined): AsyncGenerator<Uint8Array> {
      if (proc.hangUntilAbort) {
        await exit;

        return;
      }

      const enc = new TextEncoder();

      for (const line of (value ?? '').split(/(?<=\n)/)) {
        if (line) yield enc.encode(line);
      }
    }

    return {
      stdout: lines(proc.stdout),
      stderr: lines(proc.stderr),
      stdin: { end() {} },
      kill() { if (!killed) { killed = true; state.killed++; } },
      exit,
    } satisfies SpawnedClaude;
  };

  return { spawn, get calls() { return calls; }, get killed() { return state.killed; } };
}

function availableSpawn(text = 'Hello from Claude.', usage?: UsageFixture | null) {
  return fakeSpawn((args) => {
    if (args[0] === '--version') return { stdout: '2.1.174 (Claude Code)\n', code: 0 };

    if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }), code: 0 };

    return { stdout: streamJsonLines(text, usage), code: 0 };
  });
}

/** The provider's finish part before ai's v2→v3 conversion re-derives the total. */
async function finishUsage(model: LanguageModelV2): Promise<LanguageModelV2Usage> {
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    includeRawChunks: false,
  });

  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) throw new Error('stream ended without a finish part');

    if (value.type === 'finish') return value.usage;
  }
}

function probeSpawn(loggedIn: boolean): FakeSpawn {
  return fakeSpawn((args) => args[0] === '--version'
    ? { stdout: '2.1.174\n', code: 0 }
    : { stdout: JSON.stringify({ loggedIn }), code: 0 });
}

function deps() { return { env: {}, getAuth: async () => null, hasCredential: async () => false }; }


describe('claude-cli provider — doStream', () => {
  test('parses stream-json into text deltas and a finish part with usage', async () => {
    const { spawn, calls } = availableSpawn('PONG.', { inputTokens: 3, outputTokens: 7 });
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });

    const result = streamText({ model, prompt: 'ping' });
    let text = '';

    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('PONG.');

    // `input_tokens` excludes the cached prefix, so the prompt is 3 + 2131, the fold @ai-sdk/anthropic performs.
    const usage = await result.usage;
    expect(usage.inputTokens).toBe(2134);
    expect(usage.inputTokenDetails.cacheReadTokens).toBe(2131);
    expect(usage.outputTokens).toBe(7);
    expect(await result.finishReason).toBe('stop');

    const pCall = present(calls.find((a) => a[0] === '-p'), 'the `claude -p` invocation');
    expect(pCall).toContain('--output-format');
    expect(pCall).toContain('stream-json');
    expect(pCall).toContain('--tools');
    const toolsIdx = pCall.indexOf('--tools');
    expect(pCall[toolsIdx + 1]).toBe('');
    const modelIdx = pCall.indexOf('--model');
    expect(pCall[modelIdx + 1]).toBe('opus');
  });

  test('a result event with no usage block reports no counts and no total', async () => {
    const provider = createClaudeCliProvider({ spawn: availableSpawn('PONG.', null).spawn });
    const usage = await finishUsage(provider.createModel('claude-opus-4-x'));

    // Unreported usage must not become a confident total of 0.
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
  });

  test('the finish part totals the cache-inclusive prompt plus the completion', async () => {
    const provider = createClaudeCliProvider({ spawn: availableSpawn('PONG.', { inputTokens: 3, outputTokens: 7 }).spawn });
    const usage = await finishUsage(provider.createModel('claude-opus-4-x'));

    expect(usage.inputTokens).toBe(2134);
    expect(usage.cachedInputTokens).toBe(2131);
    expect(usage.outputTokens).toBe(7);
    expect(usage.totalTokens).toBe(2141);
  });

  test('doGenerate wraps doStream and returns the full text', async () => {
    const { spawn } = availableSpawn('The answer is 42.');
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-sonnet-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });
    const { text } = await generateText({ model, prompt: 'q' });
    expect(text).toBe('The answer is 42.');
  });

  test('passes the system prompt via --system-prompt and the user turn bare', async () => {
    const { spawn, calls } = availableSpawn('ok');
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-haiku-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });
    await generateText({ model, system: 'You are terse.', prompt: 'hi' });
    const pCall = present(calls.find((a) => a[0] === '-p'), 'the `claude -p` invocation');
    const sysIdx = pCall.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThan(-1);
    expect(pCall[sysIdx + 1]).toBe('You are terse.');
    expect(pCall[1]).toBe('hi');
    expect(pCall[pCall.indexOf('--model') + 1]).toBe('haiku');
  });

  test('a non-zero exit with a login error surfaces an actionable message', async () => {
    const spawn = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '2.1.174\n', code: 0 };

      if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }), code: 0 };

      return { stdout: '', stderr: 'Error: Not logged in. Please run claude login.', code: 1 };
    }).spawn;

    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });
    await expect(generateText({ model, prompt: 'q' })).rejects.toThrow(/sign in to your Claude subscription/i);
  });

  test('a signal-killed process surfaces the signal and stderr', async () => {
    const spawn = fakeSpawn(() => ({
      stderr: 'fatal: process exceeded its memory limit',
      code: null,
      signal: 'SIGKILL',
    })).spawn;

    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });

    await expect(generateText({ model, prompt: 'q' })).rejects.toThrow(
      /SIGKILL.*process exceeded its memory limit/i,
    );
  });

  test('a result error event surfaces a clean error', async () => {
    const errLine = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 'overloaded_error', result: '' });

    const spawn = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '2.1.174\n', code: 0 };

      if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }), code: 0 };

      return { stdout: errLine + '\n', code: 0 };
    }).spawn;

    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });
    await expect(generateText({ model, prompt: 'q' })).rejects.toThrow(/overloaded_error/i);
  });
});


describe('claude-cli provider — abort', () => {
  test('aborting mid-stream kills the child and the stream finishes', async () => {
    const fake = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '2.1.174\n', code: 0 };

      if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }), code: 0 };

      return { hangUntilAbort: true };
    });

    const provider = createClaudeCliProvider({ spawn: fake.spawn });
    const model = provider.createModel('claude-opus-4-x');
    const controller = new AbortController();

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      includeRawChunks: false,
      abortSignal: controller.signal,
    });

    const reader = stream.getReader();
    queueMicrotask(() => controller.abort());
    const types: string[] = [];

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      types.push(value.type);
    }

    expect(fake.killed).toBeGreaterThanOrEqual(1);
    expect(types).toContain('finish');
    expect(types).not.toContain('error');
  });
});


describe('claude-cli provider — availability', () => {
  test('available when the binary is present and logged in', async () => {
    const provider = createClaudeCliProvider({ probe: async () => ({ binary: true, loggedIn: true }) });
    expect(await provider.isAvailable(deps())).toBe(true);
    const reason = present(provider.unavailableReason, 'the provider unavailable reason hook');
    expect(await reason(deps())).toBeUndefined();
  });

  const probed = [
    { name: 'binary absent → honest install hint', binary: false, hint: /Install Claude Code/i },
    { name: 'logged out → actionable sign-in hint', binary: true, hint: /sign in to your Claude subscription/i },
  ];

  for (const c of probed) {
    test(c.name, async () => {
      const provider = createClaudeCliProvider({ probe: async () => ({ binary: c.binary, loggedIn: false }) });
      expect(await provider.isAvailable(deps())).toBe(false);
      const reason = present(provider.unavailableReason, 'the provider unavailable reason hook');
      expect(await reason(deps())).toMatch(c.hint);
    });
  }

  test('default probe: binary present + auth status loggedIn → available', async () => {
    const { spawn } = availableSpawn();
    const provider = createClaudeCliProvider({ spawn });
    expect(await provider.isAvailable(deps())).toBe(true);
  });

  test('default probe: version fails → binary absent', async () => {
    const spawn = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '', code: 127 };

      return { stdout: '', code: 0 };
    }).spawn;

    const provider = createClaudeCliProvider({ spawn });
    expect(await provider.isAvailable(deps())).toBe(false);
    const reason = present(provider.unavailableReason, 'the provider unavailable reason hook');
    expect(await reason(deps())).toMatch(/Install Claude Code/i);
  });

  test('default probe: auth status not loggedIn → logged out', async () => {
    const provider = createClaudeCliProvider({ spawn: probeSpawn(false).spawn });
    expect(await provider.isAvailable(deps())).toBe(false);
    const reason = present(provider.unavailableReason, 'the provider unavailable reason hook');
    expect(await reason(deps())).toMatch(/sign in/i);
  });

  test('probes `claude auth status` with no unsupported flags', async () => {
    const fake = probeSpawn(true);

    const provider = createClaudeCliProvider({ spawn: fake.spawn });
    await provider.isAvailable(deps());
    const authCall = present(fake.calls.find((a) => a[0] === 'auth'), 'the `claude auth` invocation');
    // `claude auth status` prints JSON by default; --output-format is rejected.
    expect(authCall).toEqual(['auth', 'status']);
  });

  test('lists the three subscription model families', () => {
    const provider = createClaudeCliProvider({ probe: async () => ({ binary: true, loggedIn: true }) });
    const ids = provider.listModels(deps()).map((m) => m.id);
    expect(ids).toEqual(['claude-opus-4-x', 'claude-sonnet-4-x', 'claude-haiku-4-x']);
  });
});


describe('buildClaudePrompt', () => {
  function opts(prompt: LanguageModelV2CallOptions['prompt']): LanguageModelV2CallOptions {
    return { prompt };
  }

  test('single user turn is bare; system is separated', () => {
    const built = buildClaudePrompt(opts([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]));

    expect(built.system).toBe('sys');
    expect(built.prompt).toBe('hello');
  });

  test('multi-turn carries prior context with role labels and a bare final turn', () => {
    const built = buildClaudePrompt(opts([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'text', value: 'file contents' } }] },
      { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
    ]));

    expect(built.prompt).toContain('first');
    expect(built.prompt).toContain('Assistant: reply');
    expect(built.prompt).toContain('Tool results:\nfile contents');
    expect(built.prompt.endsWith('follow up')).toBe(true);
  });
});


describe('claude-cli provider — tool loop composition', () => {
  test('the model is a drop-in LanguageModel for the ai-SDK tool loop', async () => {
    const { spawn } = availableSpawn('Working on it.');
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });

    const result = await generateText({
      model,
      prompt: 'use the tool',
      tools: { noop: tool({ description: 'noop', inputSchema: z.object({}), execute: async () => 'ran' }) },
      stopWhen: stepCountIs(2),
    });

    expect(result.text).toBe('Working on it.');
  });

  test('a LocalAgentSession turn on claude/* runs Kinu\'s loop with the model answering', async () => {
    const openaiLlm: LLMProviderConfig = {
      name: 'openai', baseURL: 'https://api.openai.com/v1', headers: { Authorization: 'Bearer sk' }, model: 'gpt-4o-mini',
    };

    const { spawn, calls } = availableSpawn('The capital of France is Paris.');

    const resolver = createLocalModelResolver({
      llm: openaiLlm,
      credentials: {},
      fetch: asFetchFunction(async () => new Response('{}')),
      claudeCli: { spawn },
    });

    const db = new Database(scratchPath('claude-cli-provider', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: openaiLlm });
    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db,
      model: resolver.resolveModel('claude/claude-opus-4-x'),
      modelResolver: resolver,
      onEvent: (e) => events.push(e),
      noAutoEvolve: true,
    });

    expect(session.setModel('claude/claude-opus-4-x')).toEqual({ ok: true, spec: 'claude/claude-opus-4-x' });
    await session.send('What is the capital of France?', { id: crypto.randomUUID() });

    const turnEnd = events.find((event) => event.type === 'turn-end');

    if (!turnEnd || turnEnd.type !== 'turn-end') throw new Error('turn-end event was not emitted');
    expect(turnEnd.turn.assistantResponse).toBe('The capital of France is Paris.');

    const pCall = present(calls.find((a) => a[0] === '-p'), 'the `claude -p` invocation');
    expect(pCall[pCall.indexOf('--model') + 1]).toBe('opus');
    await session.end();
  });
});


describe('claude-cli provider — tool calls', () => {
  /** A Claude model with no formal tool parameter emits its trained call block inline in the text stream. */
  const FC_BLOCK = [
    'Let me look that up.',
    '<function_calls>',
    '<invoke name="lookup">',
    '<parameter name="query">capital of France</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n');

  test('a function_calls block becomes a real tool call the SDK executes', async () => {
    const { spawn } = availableSpawn(FC_BLOCK);
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', deps());

    let executed: { query: string } | undefined;

    const result = await generateText({
      model,
      prompt: 'what is the capital of France?',
      tools: {
        lookup: tool({
          description: 'look up a fact',
          inputSchema: z.object({ query: z.string() }),
          execute: async (args) => {
            executed = args;

            return 'Paris';
          },
        }),
      },
      stopWhen: stepCountIs(2),
    });

    expect(executed).toEqual({ query: 'capital of France' });
    expect(result.text).not.toContain('<function_calls>');
    expect(result.text).toContain('Let me look that up.');
  });

  test('doStream emits tool-call parts and finishes tool-calls', async () => {
    const { spawn } = availableSpawn(FC_BLOCK);
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', deps());

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      includeRawChunks: false,
    });

    const parts: LanguageModelV2StreamPart[] = [];
    const reader = stream.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      parts.push(value);
    }

    const calls = parts.filter((p) => p.type === 'tool-call');
    expect(calls).toHaveLength(1);

    if (calls[0].type !== 'tool-call') throw new Error('unreachable');
    expect(calls[0].toolName).toBe('lookup');
    expect(JSON.parse(calls[0].input)).toEqual({ query: 'capital of France' });
    expect(calls[0].toolCallId.length).toBeGreaterThan(0);

    const finish = parts.find((p) => p.type === 'finish');

    if (!finish || finish.type !== 'finish') throw new Error('no finish part');
    expect(finish.finishReason).toBe('tool-calls');

    const deltas = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('');
    expect(deltas).not.toContain('<function_calls>');
    expect(deltas).toContain('Let me look that up.');
  });

  test('text after a closed block still streams, and two blocks yield two calls', async () => {
    const twoBlocks = [
      '<function_calls>',
      '<invoke name="lookup">',
      '<parameter name="query">first</parameter>',
      '</invoke>',
      '</function_calls>',
      'Checking the second one now.',
      '<function_calls>',
      '<invoke name="lookup">',
      '<parameter name="query">second</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');

    const { spawn } = availableSpawn(twoBlocks);
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', deps());

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      includeRawChunks: false,
    });

    const parts: LanguageModelV2StreamPart[] = [];
    const reader = stream.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      parts.push(value);
    }

    const calls = parts.filter((p) => p.type === 'tool-call');
    expect(calls).toHaveLength(2);
    const deltas = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('');
    expect(deltas).toContain('Checking the second one now.');
    expect(deltas).not.toContain('<function_calls>');
  });

  test('the prompt teaches the exact block format the parser reads', () => {
    const built = buildClaudePrompt({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [{
        type: 'function',
        name: 'lookup',
        description: 'look up a fact',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
    });

    expect(built.system).toContain('lookup');
    expect(built.system).toContain('<function_calls>');
    expect(built.system).toContain('<invoke name="TOOL_NAME">');
    expect(built.system).toContain('<parameter name="PARAM_NAME">');
  });
});
