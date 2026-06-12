import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateText, streamText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { LLMProviderConfig } from '@proteus/core';
import {
  createClaudeCliProvider,
  buildClaudePrompt,
  type ClaudeSpawn,
  type SpawnedClaude,
} from '../src/claude-cli-provider.js';
import { createLocalModelResolver } from '../src/model-resolver.js';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';

// ─── stream-json fixtures (captured from the real `claude` binary) ───────────

/** Native streaming output: system/init → rate_limit → stream_event deltas →
 *  assistant → result. We keep just the lines doStream consumes. */
function streamJsonLines(text: string, opts: { inputTokens?: number; outputTokens?: number; cacheRead?: number } = {}): string {
  // The real stream emits content_block_start then incremental text_delta lines.
  const startLine = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  const deltaLines = chunk(text).map((piece) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
    }));
  const resultLine = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: text,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: opts.inputTokens ?? 11,
      output_tokens: opts.outputTokens ?? 7,
      cache_read_input_tokens: opts.cacheRead ?? 2131,
    },
  });
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', tools: [] }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
    startLine,
    ...deltaLines,
    resultLine,
  ].join('\n') + '\n';
}

function chunk(text: string): string[] {
  // Split into a couple of pieces to exercise incremental delta accumulation.
  if (text.length <= 2) return [text];
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}

/** A spawn seam over canned per-invocation stdout/stderr/exit. */
interface FakeProc {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Resolve only after the abort signal fires (to test cancellation). */
  hangUntilAbort?: boolean;
}

function fakeSpawn(handler: (args: string[]) => FakeProc): { spawn: ClaudeSpawn; calls: string[][]; killed: number } {
  const calls: string[][] = [];
  const state = { killed: 0 };
  const spawn: ClaudeSpawn = (args, opts) => {
    calls.push(args);
    const proc = handler(args);
    let killed = false;
    const exit = new Promise<number | null>((resolve) => {
      if (proc.hangUntilAbort) {
        opts.signal?.addEventListener('abort', () => { killed = true; state.killed++; resolve(null); });
        return;
      }
      queueMicrotask(() => resolve(proc.code ?? 0));
    });
    async function* lines(value: string | undefined): AsyncGenerator<Uint8Array> {
      if (proc.hangUntilAbort) {
        // Emit nothing until the process is aborted, then end the stream.
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

/** Probe-aware spawn: `--version` succeeds, `auth status` reports loggedIn,
 *  the `-p` call streams `text`. */
function availableSpawn(text = 'Hello from Claude.', usage?: { inputTokens?: number; outputTokens?: number }) {
  return fakeSpawn((args) => {
    if (args[0] === '--version') return { stdout: '2.1.174 (Claude Code)\n', code: 0 };
    if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }), code: 0 };
    return { stdout: streamJsonLines(text, usage), code: 0 };
  });
}

// ─── doStream parsing ────────────────────────────────────────────────────────

describe('claude-cli provider — doStream', () => {
  test('parses stream-json into text deltas and a finish part with usage', async () => {
    const { spawn, calls } = availableSpawn('PONG.', { inputTokens: 3, outputTokens: 7 });
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });

    const result = streamText({ model, prompt: 'ping' });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('PONG.');

    const usage = await result.usage;
    expect(usage.inputTokens).toBe(3);
    expect(usage.outputTokens).toBe(7);
    expect(await result.finishReason).toBe('stop');

    // The -p invocation uses the opus alias + tools off + stream-json.
    const pCall = calls.find((a) => a[0] === '-p')!;
    expect(pCall).toContain('--output-format');
    expect(pCall).toContain('stream-json');
    expect(pCall).toContain('--tools');
    const toolsIdx = pCall.indexOf('--tools');
    expect(pCall[toolsIdx + 1]).toBe('');
    const modelIdx = pCall.indexOf('--model');
    expect(pCall[modelIdx + 1]).toBe('opus');
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
    const pCall = calls.find((a) => a[0] === '-p')!;
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

// ─── abort ───────────────────────────────────────────────────────────────────

describe('claude-cli provider — abort', () => {
  test('aborting mid-stream kills the child and the stream finishes', async () => {
    const fake = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '2.1.174\n', code: 0 };
      if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true }), code: 0 };
      return { hangUntilAbort: true };
    });
    const provider = createClaudeCliProvider({ spawn: fake.spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });
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
  });
});

// ─── availability gating ───────────────────────────────────────────────────

describe('claude-cli provider — availability', () => {
  function deps() { return { env: {}, getAuth: async () => null, hasCredential: async () => false }; }

  test('available when the binary is present and logged in', async () => {
    const provider = createClaudeCliProvider({ probe: async () => ({ binary: true, loggedIn: true }) });
    expect(await provider.isAvailable(deps())).toBe(true);
    expect(await provider.unavailableReason!(deps())).toBeUndefined();
  });

  test('binary absent → honest install hint', async () => {
    const provider = createClaudeCliProvider({ probe: async () => ({ binary: false, loggedIn: false }) });
    expect(await provider.isAvailable(deps())).toBe(false);
    expect(await provider.unavailableReason!(deps())).toMatch(/Install Claude Code/i);
  });

  test('logged out → actionable sign-in hint', async () => {
    const provider = createClaudeCliProvider({ probe: async () => ({ binary: true, loggedIn: false }) });
    expect(await provider.isAvailable(deps())).toBe(false);
    expect(await provider.unavailableReason!(deps())).toMatch(/sign in to your Claude subscription/i);
  });

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
    expect(await provider.unavailableReason!(deps())).toMatch(/Install Claude Code/i);
  });

  test('default probe: auth status not loggedIn → logged out', async () => {
    const spawn = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '2.1.174\n', code: 0 };
      return { stdout: JSON.stringify({ loggedIn: false }), code: 0 };
    }).spawn;
    const provider = createClaudeCliProvider({ spawn });
    expect(await provider.isAvailable(deps())).toBe(false);
    expect(await provider.unavailableReason!(deps())).toMatch(/sign in/i);
  });

  test('probes `claude auth status` with no unsupported flags', async () => {
    const fake = fakeSpawn((args) => {
      if (args[0] === '--version') return { stdout: '2.1.174\n', code: 0 };
      return { stdout: JSON.stringify({ loggedIn: true }), code: 0 };
    });
    const provider = createClaudeCliProvider({ spawn: fake.spawn });
    await provider.isAvailable(deps());
    const authCall = fake.calls.find((a) => a[0] === 'auth')!;
    // `claude auth status` prints JSON by default; --output-format is rejected.
    expect(authCall).toEqual(['auth', 'status']);
  });

  test('lists the three subscription model families', () => {
    const provider = createClaudeCliProvider({ probe: async () => ({ binary: true, loggedIn: true }) });
    const ids = (provider.listModels(deps()) as { id: string }[]).map((m) => m.id);
    expect(ids).toEqual(['claude-opus-4-x', 'claude-sonnet-4-x', 'claude-haiku-4-x']);
  });
});

// ─── prompt translation ──────────────────────────────────────────────────────

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

// ─── composition with Proteus's tool loop ────────────────────────────────────

describe('claude-cli provider — tool loop composition', () => {
  test('the model is a drop-in LanguageModel for the ai-SDK tool loop', async () => {
    const { spawn } = availableSpawn('Working on it.');
    const provider = createClaudeCliProvider({ spawn });
    const model = provider.createModel('claude-opus-4-x', { env: {}, getAuth: async () => null, hasCredential: async () => false });

    // The harness still exposes a tool; the claude/* model just answers. The
    // point: a claude/* model composes with the SDK's own tool loop.
    const result = await generateText({
      model,
      prompt: 'use the tool',
      tools: { noop: tool({ description: 'noop', inputSchema: z.object({}), execute: async () => 'ran' }) },
      stopWhen: stepCountIs(2),
    });
    expect(result.text).toBe('Working on it.');
  });

  test('a LocalAgentSession turn on claude/* runs Proteus\'s loop with the model answering', async () => {
    const openaiLlm: LLMProviderConfig = {
      name: 'openai', baseURL: 'https://api.openai.com/v1', headers: { Authorization: 'Bearer sk' }, model: 'gpt-4o-mini',
    };
    const { spawn, calls } = availableSpawn('The capital of France is Paris.');
    const resolver = createLocalModelResolver({
      llm: openaiLlm,
      credentials: {},
      fetch: async () => new Response('{}'),
      claudeCli: { spawn },
    });

    const db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    const rt = createCLIRuntime(db as never, { dbPath: `/tmp/proteus-claude-${Math.floor(performance.now())}.db`, llm: openaiLlm });
    const events: SessionEvent[] = [];
    const session = new LocalAgentSession({
      rt, db,
      model: resolver.resolveModel('claude/claude-opus-4-x'),
      modelResolver: resolver,
      onEvent: (e) => events.push(e),
      noAutoEvolve: true,
    });

    expect(session.setModel('claude/claude-opus-4-x')).toEqual({ ok: true, spec: 'claude/claude-opus-4-x' });
    await session.send('What is the capital of France?');

    const turnEnd = events.find((e) => e.type === 'turn-end') as Extract<SessionEvent, { type: 'turn-end' }>;
    expect(turnEnd.turn.assistantResponse).toBe('The capital of France is Paris.');

    // The model was driven through the real `claude -p` invocation (opus alias).
    const pCall = calls.find((a) => a[0] === '-p')!;
    expect(pCall[pCall.indexOf('--model') + 1]).toBe('opus');
    session.end();
  });
});
