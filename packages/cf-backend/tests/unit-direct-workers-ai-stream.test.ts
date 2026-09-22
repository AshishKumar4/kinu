// Direct Workers AI binding transport (src/providers/direct-workers-ai-fetch.ts): bytes stream before completion,
// concurrent turns on one binding stay isolated (workerd's `Ai.run` re-reads binding options after awaiting),
// and a model that will not stream is refused by name.
import { describe, test, expect, afterEach } from 'bun:test';
import { generateText, streamText, tool, jsonSchema, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink, type RecordingLogger } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { createDirectWorkersAIFetch } from '@kinu.run/core';
import { ProviderPacer, type RateLimitRetryOptions } from '@kinu.run/core';

const MODEL = '@cf/moonshotai/kimi-k2.6';

const ENDPOINT = 'https://kinu-direct-workers-ai.invalid/chat/completions';

const PROMPT = 'the exact words the person typed';

const WITHHELD = 'the completion a buffered replay would hand back';

const DONE = 'data: [DONE]\n\n';

/** Every shape workerd's `Ai.run` can return; a concurrent call decides which arrives. */
type BindingAnswer = Response | ReadableStream<Uint8Array> | JsonObject;

const UsageSchema = v.record(v.string(), v.number());

const ToolCallDeltaSchema = v.looseObject({
  index: v.optional(v.number()),
  id: v.optional(v.string()),
  type: v.optional(v.string()),
  function: v.optional(v.looseObject({
    name: v.optional(v.string()),
    arguments: v.optional(v.string()),
  })),
});

const ChunkSchema = v.looseObject({
  id: v.string(),
  object: v.optional(v.string()),
  model: v.optional(v.string()),
  choices: v.array(v.looseObject({
    index: v.optional(v.number()),
    delta: v.optional(v.looseObject({
      role: v.optional(v.string()),
      content: v.optional(v.string()),
      tool_calls: v.optional(v.array(ToolCallDeltaSchema)),
    })),
    finish_reason: v.optional(v.nullable(v.string())),
  })),
  usage: v.optional(UsageSchema),
});

const CompletionSchema = v.looseObject({
  id: v.string(),
  object: v.string(),
  model: v.string(),
  choices: v.array(v.looseObject({
    index: v.number(),
    message: v.looseObject({
      role: v.string(),
      content: v.string(),
      tool_calls: v.optional(v.array(v.looseObject({
        id: v.string(),
        type: v.string(),
        function: v.looseObject({ name: v.string(), arguments: v.string() }),
      }))),
    }),
    finish_reason: v.string(),
  })),
  usage: v.optional(UsageSchema),
});

const MessageErrorSchema = v.object({ error: v.object({ message: v.string() }) });

interface RunOptions {
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  returnRawResponse?: boolean;
}

interface RecordedRun {
  model: string;
  inputs: JsonObject;
  options: RunOptions | undefined;
}

/** Any binding member the adapter reached for beyond the fixture fails loudly. */
function directFetch(answer: (run: RecordedRun) => BindingAnswer, retry: RateLimitRetryOptions = {}) {
  const runs: RecordedRun[] = [];

  const ai = {
    run(model: string, inputs: JsonObject, options?: RunOptions): Promise<BindingAnswer> {
      const recorded: RecordedRun = { model, inputs, options };
      runs.push(recorded);

      return Promise.resolve(answer(recorded));
    },
  };

  // SAFETY: the fixture provides `Ai.run`, the only member the adapter calls.
  return { fetch: createDirectWorkersAIFetch(ai, retry), runs };
}

function chatBody(extra: JsonObject = {}): string {
  return JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], ...extra });
}

/** An upstream body driven frame by frame, so "before the completion exists" is a state, not a race. */
function manualStream() {
  const encoder = new TextEncoder();
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    cancel() {
      cancelled = true;
    },
  });

  if (!sink) throw new Error('ReadableStream did not start synchronously');
  const controller = sink;

  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => {
      closed = true;
      controller.close();
    },
    closed: () => closed,
    cancelled: () => cancelled,
  };
}

function sse(payload: JsonObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function eventStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function eventStreamOf(text: string): Response {
  const body = new Response(text).body;

  if (!body) throw new Error('fixture response carried no body');

  return eventStream(body);
}

/** Content frames, a usage-only frame, then [DONE]; fresh body per call. */
function textThenUsage(first: string, second: string, usage: JsonObject): () => Response {
  return () => eventStreamOf([
    sse({ response: first }),
    sse({ response: second }),
    sse({ response: '', usage }),
    DONE,
  ].join(''));
}

function frames(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new Error('response carried no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const next = async (): Promise<string | null> => {
    for (;;) {
      const cut = buffer.indexOf('\n\n');

      if (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);

        return frame.startsWith('data: ') ? frame.slice('data: '.length) : frame;
      }

      const read = await reader.read();

      if (read.done) return null;
      buffer += decoder.decode(read.value, { stream: true });
    }
  };

  return {
    next,
    rest: async () => {
      const collected: string[] = [];

      for (let frame = await next(); frame !== null; frame = await next()) collected.push(frame);

      return collected;
    },
    cancel: async () => {
      await reader.cancel();
    },
  };
}

type Chunk = v.InferOutput<typeof ChunkSchema>;

function chunks(payloads: readonly string[]): Chunk[] {
  return payloads
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => v.parse(ChunkSchema, JSON.parse(payload)));
}

/** Every frame of one response carries the same id, the response-unique half of a synthesized tool-call id. */
async function drainStreamed(direct: typeof globalThis.fetch) {
  const emitted = chunks(await frames((await direct(ENDPOINT, {
    method: 'POST',
    body: chatBody({ stream: true }),
  })).body).rest());

  const ids = [...new Set(emitted.map((chunk) => chunk.id))];
  const [responseId] = ids;

  if (ids.length !== 1 || responseId === undefined) {
    throw new Error(`one streamed response carried ${String(ids.length)} chunk ids`);
  }

  return {
    responseId,
    chunks: emitted,
    toolCalls: emitted.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []),
  };
}

function deltaOf(payload: string | null): Chunk['choices'][number]['delta'] {
  if (payload === null) throw new Error('the stream ended before the expected frame');

  return chunks([payload])[0]?.choices[0]?.delta;
}

let restoreSink: (() => void) | undefined;

function recordDiagnostics(): RecordingLogger {
  const logger = createRecordingLogger();
  restoreSink = setDiagnosticsSink(logger);

  return logger;
}

afterEach(() => {
  restoreSink?.();
  restoreSink = undefined;
});

describe('direct Workers AI binding — a rate limit is waited out, never surrendered', () => {
  // Measured on staging 2026-09-06: binding answered `3021: rate limiting` and the turn failed after the SDK retries;
  // the binding path must wrap withRateLimitRetry like the OAuth path.
  test('a 429 envelope from the binding is retried until the completion arrives', async () => {
    const waits: number[] = [];
    let attempt = 0;

    const { fetch, runs } = directFetch(() => {
      attempt += 1;

      if (attempt < 3) {
        return new Response(JSON.stringify({ errors: [{ code: 3021, message: 'rate limiting: inference request per min rate reached' }] }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      }

      return { response: 'OK', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
    }, {
      sleep: async (ms) => { waits.push(ms); },
      pacer: new ProviderPacer({ sleep: async () => {} }),
      warn: () => {},
    });

    const response = await fetch(ENDPOINT, { method: 'POST', body: chatBody() });
    expect(response.status).toBe(200);
    expect(runs).toHaveLength(3);
    expect(waits).toEqual([1_000, 1_000]);
  });
});

describe('direct Workers AI binding — incremental streaming', () => {
  test('the first frame reaches the caller while the upstream stream is still open', async () => {
    const logger = recordDiagnostics();
    const upstream = manualStream();
    const { fetch: direct, runs } = directFetch(() => eventStream(upstream.stream));

    const pending = direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) });
    upstream.push(sse({ response: 'first' }));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = frames(response.body);
    // A decoded chunk is delivered while upstream is still open; a buffered adapter cannot be here.
    expect(deltaOf(await reader.next())).toEqual({ role: 'assistant', content: 'first' });
    expect(upstream.closed()).toBe(false);

    upstream.push(sse({ response: ' second' }));
    expect(deltaOf(await reader.next())).toEqual({ content: ' second' });

    upstream.push(sse({ response: '', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    upstream.close();
    expect((await reader.rest()).at(-1)).toBe('[DONE]');

    expect(runs).toHaveLength(1);
    expect(runs[0]?.inputs.stream).toBe(true);
    expect(runs[0]?.inputs.stream_options).toEqual({ include_usage: true });
    expect(runs[0]?.options?.returnRawResponse).toBe(true);

    const ttft = logger.emitted.filter((line) => line.event === 'workers_ai.direct_stream_first_byte');
    expect(ttft).toHaveLength(1);
    expect(Object.keys(ttft[0].fields).sort()).toEqual(['bytes', 'model', 'ms']);
    expect(ttft[0].fields.model).toBe(MODEL);
    expect(Number.isInteger(ttft[0].fields.ms)).toBe(true);
    expect(ttft[0].fields.bytes).toBe(sse({ response: 'first' }).length);
    expect(JSON.stringify(logger.emitted)).not.toContain(PROMPT);
  });

  test('the response exists only once the first byte does, so the measurement is of the byte', async () => {
    const logger = recordDiagnostics();
    const upstream = manualStream();
    const { fetch: direct } = directFetch(() => eventStream(upstream.stream));

    let settled = false;

    const pending = direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) })
      .then((response) => {
        settled = true;

        return response;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(logger.emitted).toHaveLength(0);

    upstream.push(sse({ response: 'now' }));
    const response = await pending;
    expect(settled).toBe(true);
    expect(logger.emitted.map((line) => line.event)).toEqual(['workers_ai.direct_stream_first_byte']);

    upstream.close();
    expect((await frames(response.body).rest()).at(-1)).toBe('[DONE]');
  });

  test('two turns on one binding do not read each other frames, headers or shapes', async () => {
    const alpha = manualStream();
    const beta = manualStream();

    // Different return shapes on purpose: `Ai.run` re-reads `options.returnRawResponse` after awaiting upstream.
    const { fetch: direct, runs } = directFetch((run) =>
      run.options?.extraHeaders?.['x-session-affinity'] === 'kinu-alpha'
        ? eventStream(alpha.stream)
        : beta.stream);

    const alphaPending = direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
      headers: { 'x-session-affinity': 'kinu-alpha' },
    });

    const betaPending = direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
      headers: { 'x-session-affinity': 'kinu-beta' },
    });

    // Sentinels carry a non-hex letter: random `chatcmpl-<uuid>` ids can contain any hex run.
    alpha.push(sse({ response: 'AXAXA' }));
    beta.push(sse({ response: 'BXBXB' }));

    const alphaFrames = frames((await alphaPending).body);
    const betaFrames = frames((await betaPending).body);

    expect(deltaOf(await alphaFrames.next())?.content).toBe('AXAXA');
    expect(deltaOf(await betaFrames.next())?.content).toBe('BXBXB');
    alpha.push(sse({ response: 'axaxa' }));
    beta.push(sse({ response: 'bxbxb' }));
    expect(deltaOf(await betaFrames.next())?.content).toBe('bxbxb');
    expect(deltaOf(await alphaFrames.next())?.content).toBe('axaxa');

    alpha.close();
    beta.close();
    const alphaText = (await alphaFrames.rest()).join('');
    const betaText = (await betaFrames.rest()).join('');
    expect(alphaText).not.toContain('BXBXB');
    expect(alphaText).not.toContain('bxbxb');
    expect(betaText).not.toContain('AXAXA');
    expect(betaText).not.toContain('axaxa');

    expect(runs.map((run) => run.options?.extraHeaders?.['x-session-affinity']))
      .toEqual(['kinu-alpha', 'kinu-beta']);
  });

  test('an aborted turn stops the provider work', async () => {
    const upstream = manualStream();
    const controller = new AbortController();
    const { fetch: direct, runs } = directFetch(() => eventStream(upstream.stream));

    const pending = direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
      signal: controller.signal,
    });

    upstream.push(sse({ response: 'partial' }));
    const reader = frames((await pending).body);
    await reader.next();

    expect(runs[0]?.options?.signal).toBe(controller.signal);
    expect(upstream.cancelled()).toBe(false);

    // Cancelling the delivered body must reach the upstream reader or the model keeps generating.
    controller.abort();
    await reader.cancel();

    // Cancellation propagates in microtasks; bounded so a broken chain fails instead of hanging.
    for (let i = 0; i < 100 && !upstream.cancelled(); i++) await Promise.resolve();

    expect(upstream.cancelled()).toBe(true);
  });

  test('a cancelled binding call is rethrown, never reported as a provider failure', async () => {
    const logger = recordDiagnostics();

    const { fetch: direct } = directFetch(() => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    await expect(direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) }))
      .rejects.toThrow('The operation was aborted');
    expect(logger.emitted.map((line) => line.event)).not.toContain('workers_ai.direct_call_failed');
  });
});

describe('direct Workers AI binding — usage and finish frames', () => {
  test('a native stream ends with exactly one finish reason, its usage, then [DONE]', async () => {
    const { fetch: direct } = directFetch(textThenUsage('one', ' two', {
      prompt_tokens: 9, completion_tokens: 4, total_tokens: 13,
    }));

    const payloads = await frames((await direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
    })).body).rest();

    expect(payloads.at(-1)).toBe('[DONE]');
    expect(payloads.filter((payload) => payload === '[DONE]')).toHaveLength(1);
    const emitted = chunks(payloads);
    expect(emitted.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    expect(emitted.every((chunk) => chunk.model === MODEL)).toBe(true);
    expect(emitted.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe('one two');
    const finished = emitted.filter((chunk) => (chunk.choices[0]?.finish_reason ?? null) !== null);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.choices[0]?.finish_reason).toBe('stop');
    expect(finished[0]?.usage).toEqual({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
  });

  test('native tool calls stream as indexed deltas that share one response id', async () => {
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ response: '' }),
      sse({ tool_calls: [
        { name: 'read_file', arguments: { path: 'AGENTS.md' } },
        { name: 'read_file', arguments: { path: 'README.md' } },
      ] }),
      sse({ tool_calls: [
        { name: 'shell', arguments: { cmd: 'ls' } },
        { id: 'call-upstream', name: 'shell', arguments: '{"cmd":"pwd"}' },
      ] }),
      DONE,
    ].join('')));

    const streamed = await drainStreamed(direct);

    // Synthesized ids are unique within the response (index) and across responses (response id); upstream ids stay scoped.
    expect(streamed.toolCalls).toEqual([
      {
        index: 0, id: `call-${streamed.responseId}-i-1`, type: 'function',
        function: { name: 'read_file', arguments: '{"path":"AGENTS.md"}' },
      },
      {
        index: 1, id: `call-${streamed.responseId}-i-2`, type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
      {
        index: 2, id: `call-${streamed.responseId}-i-3`, type: 'function',
        function: { name: 'shell', arguments: '{"cmd":"ls"}' },
      },
      {
        index: 3, id: `call-${streamed.responseId}-n-call-upstream`, type: 'function',
        function: { name: 'shell', arguments: '{"cmd":"pwd"}' },
      },
    ]);
    expect(streamed.chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('two streamed responses in one turn cannot produce the same tool-call id', async () => {
    // KINU-N002: a `call-${index + 1}` fallback repeated `call-1` across steps, pairing results with the wrong call.
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }] }),
      DONE,
    ].join('')));

    const first = await drainStreamed(direct);
    const second = await drainStreamed(direct);

    expect(first.responseId).not.toBe(second.responseId);
    expect(first.toolCalls[0]?.id).toBe(`call-${first.responseId}-i-1`);
    expect(second.toolCalls[0]?.id).toBe(`call-${second.responseId}-i-1`);
  });

  test('two responses whose native tool-call ids are both "0" cannot produce the same id', async () => {
    // A native id may be per-response (`"0"` again next response), so it is scoped too.
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [{ id: '0', name: 'shell', arguments: { cmd: 'ls' } }] }),
      DONE,
    ].join('')));

    const first = await drainStreamed(direct);
    const second = await drainStreamed(direct);

    expect(first.toolCalls[0]?.id).not.toBe(second.toolCalls[0]?.id);
    expect(first.toolCalls[0]?.id).toBe(`call-${first.responseId}-n-0`);
    expect(second.toolCalls[0]?.id).toBe(`call-${second.responseId}-n-0`);
  });

  test('an empty or unusable native tool-call id never becomes the pairing key', async () => {
    // Empty ids, spaces or `/` do not round-trip as ids; they degrade to the position.
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [
        { id: '', name: 'shell', arguments: { cmd: 'ls' } },
        { id: '   ', name: 'shell', arguments: { cmd: 'pwd' } },
        { id: 'read file/1', name: 'shell', arguments: { cmd: 'id' } },
      ] }),
      DONE,
    ].join('')));

    const streamed = await drainStreamed(direct);

    expect(streamed.toolCalls.map((call) => call.id)).toEqual([
      `call-${streamed.responseId}-i-1`,
      `call-${streamed.responseId}-i-2`,
      `call-${streamed.responseId}-i-3`,
    ]);
  });

  test('OpenAI-shaped chunks pass through verbatim and their finish reason is not duplicated', async () => {
    const upstreamChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{"role":"assistant","content":"hi","reasoning_content":"because"}}]}';

    const finishChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}';

    // No upstream [DONE]: the terminator is this adapter's responsibility.
    const { fetch: direct } = directFetch(() => eventStreamOf(
      `data: ${upstreamChunk}\n\ndata: ${finishChunk}\n\n`,
    ));

    const payloads = await frames((await direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
    })).body).rest();

    expect(payloads).toEqual([upstreamChunk, finishChunk, '[DONE]']);
  });

  test('a usage-only frame that omits choices still reports its usage after an upstream finish', async () => {
    // KINU-049: a usage-only frame without `choices` must still be reported after an OpenAI finish reason.
    const finishChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}';

    const { fetch: direct } = directFetch(() => eventStreamOf(
      `data: ${finishChunk}\n\n${sse({ usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 } })}${DONE}`,
    ));

    const payloads = await frames((await direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
    })).body).rest();

    const emitted = chunks(payloads);
    expect(emitted.filter((chunk) => (chunk.choices[0]?.finish_reason ?? null) !== null)).toHaveLength(1);
    const reported = emitted.filter((chunk) => chunk.usage !== undefined);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 });
    expect(payloads.filter((payload) => payload === '[DONE]')).toHaveLength(1);
  });

  test('a usage-only frame with empty choices does not put two terminal frames on the wire', async () => {
    // The same report shaped as an OpenAI chunk must not produce a second finish.
    const head = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m"';
    const delta = `${head},"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}`;
    const usageOnly = `${head},"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}`;

    const { fetch: direct } = directFetch(() => eventStreamOf(
      `data: ${delta}\n\ndata: ${usageOnly}\n\n${DONE}`,
    ));

    const payloads = await frames((await direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true }),
    })).body).rest();

    const emitted = chunks(payloads);

    const terminal = emitted.filter((chunk) =>
      (chunk.choices[0]?.finish_reason ?? null) !== null || chunk.usage !== undefined);

    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.choices[0]?.finish_reason).toBe('stop');
    expect(terminal[0]?.usage).toEqual({ prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
    expect(emitted[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'hi' });
    expect(payloads.filter((payload) => payload === '[DONE]')).toHaveLength(1);
  });

  // An untranslatable frame ends the stream; dropping it would lose content while reporting success.
  test.each([
    ['is not JSON at all', 'data: {oops\n\n', `Workers AI ${MODEL} streamed a data frame that is not a JSON object`],
    ['is JSON but not an object', 'data: 3\n\n', `Workers AI ${MODEL} streamed a data frame that is not a JSON object`],
    ['is an object in neither dialect', 'data: {"response":5}\n\n', `Workers AI ${MODEL} streamed a frame that is neither an OpenAI chunk nor a native output`],
  ])('a data frame that %s ends the stream loudly', async (_case, frame, expected) => {
    const { fetch: direct } = directFetch(() => eventStreamOf(`${frame}${DONE}`));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) });

    expect(response.status).toBe(200);
    await expect(frames(response.body).rest()).rejects.toThrow(expected);
  });
});

describe('direct Workers AI binding — refusals', () => {
  test.each([
    ['a whole JSON completion object', (): BindingAnswer => ({
      response: WITHHELD,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })],
    ['a JSON response', (): BindingAnswer => new Response(JSON.stringify({ response: WITHHELD }), {
      headers: { 'content-type': 'application/json' },
    })],
    ['a JSON body under an event-stream content type', (): BindingAnswer => eventStreamOf(
      JSON.stringify({ response: WITHHELD }),
    )],
    ['an event stream that carries nothing', (): BindingAnswer => eventStreamOf('')],
    // Only the content type says this is not an event stream.
    ['a body under some other content type', (): BindingAnswer => new Response('pong', {
      headers: { 'content-type': 'text/plain' },
    })],
  ])('a streamed request is refused when the binding answers %s', async (_case, answer) => {
    const logger = recordDiagnostics();
    const { fetch: direct } = directFetch(answer);

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) });

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/json');
    const message = v.parse(MessageErrorSchema, JSON.parse(await response.text())).error.message;
    expect(message).toContain(MODEL);
    expect(message).toContain('did not stream over the direct binding');
    expect(message).not.toContain(WITHHELD);
    expect(logger.emitted.map((line) => line.event)).toContain('workers_ai.direct_stream_unsupported');
  });

  test('an upstream failure keeps its status and carries its own message', async () => {
    // A 502, because a 429 is waited out, not surfaced.
    const { fetch: direct } = directFetch(() => new Response(
      JSON.stringify({ errors: [{ code: 3040, message: 'Upstream unavailable' }] }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    ));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) });

    expect(response.status).toBe(502);
    expect(v.parse(MessageErrorSchema, JSON.parse(await response.text())).error.message)
      .toBe('3040: Upstream unavailable');
  });

  test('the binding internal-code envelope is read the way the binding reads it', async () => {
    const { fetch: direct } = directFetch(() => new Response(
      JSON.stringify({ internalCode: 3006, description: 'Invalid or incomplete input', name: 'InferenceUpstreamError' }),
      { status: 400 },
    ));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });

    expect(response.status).toBe(400);
    expect(v.parse(MessageErrorSchema, JSON.parse(await response.text())).error.message)
      .toBe('3006: Invalid or incomplete input');
  });

  test('a thrown binding failure becomes a classified 502, not an opaque transport fault', async () => {
    const logger = recordDiagnostics();

    const { fetch: direct } = directFetch(() => {
      throw new Error('3036: capacity temporarily exceeded');
    });

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) });

    expect(response.status).toBe(502);
    expect(v.parse(MessageErrorSchema, JSON.parse(await response.text())).error.message)
      .toContain('3036: capacity temporarily exceeded');
    const failures = logger.emitted.filter((line) => line.event === 'workers_ai.direct_call_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('io');
    expect(failures[0]?.fields.model).toBe(MODEL);
  });
});

describe('direct Workers AI binding — whole completions', () => {
  test('a native output becomes an OpenAI completion with its tool calls and usage', async () => {
    const { fetch: direct, runs } = directFetch(() => ({
      response: 'done',
      tool_calls: [{ name: 'read_file', arguments: { path: 'README.md' } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });

    expect(response.headers.get('content-type')).toBe('application/json');
    const completion = v.parse(CompletionSchema, JSON.parse(await response.text()));
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe(MODEL);
    expect(completion.choices[0]?.message.role).toBe('assistant');
    expect(completion.choices[0]?.message.content).toBe('done');
    expect(completion.choices[0]?.message.tool_calls).toEqual([
      {
        id: `call-${completion.id}-i-1`, type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ]);
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls');
    expect(completion.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });

    expect(runs[0]?.inputs).toEqual({
      messages: [{ role: 'user', content: PROMPT }],
      stream: false,
    });
  });

  test('a completion indexes its synthesized tool-call ids within its own id', async () => {
    const { fetch: direct } = directFetch(() => ({
      response: '',
      tool_calls: [
        { name: 'shell', arguments: { cmd: 'ls' } },
        { name: 'shell', arguments: { cmd: 'pwd' } },
      ],
    }));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });

    // The response half is the completion's own id, so replay reproduces the id the caller read.
    const completion = v.parse(CompletionSchema, await response.json());
    expect(completion.choices[0]?.message.tool_calls?.map((call) => call.id)).toEqual([
      `call-${completion.id}-i-1`,
      `call-${completion.id}-i-2`,
    ]);
  });

  test('two non-streamed responses in one turn cannot produce the same tool-call id', async () => {
    const { fetch: direct } = directFetch(() => ({
      response: '',
      tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }],
    }));

    const completions = [];

    for (const _step of [1, 2]) {
      const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });
      completions.push(v.parse(CompletionSchema, await response.json()));
    }

    const [first, second] = completions;

    if (!first || !second) throw new Error('the turn produced fewer than two completions');
    expect(first.id).not.toBe(second.id);
    expect(first.choices[0]?.message.tool_calls?.[0]?.id).toBe(`call-${first.id}-i-1`);
    expect(second.choices[0]?.message.tool_calls?.[0]?.id).toBe(`call-${second.id}-i-1`);
  });

  test('an already OpenAI-shaped output passes through unchanged', async () => {
    const upstream: JsonObject = {
      id: 'chatcmpl-direct',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'passed' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    };

    const { fetch: direct } = directFetch(() => upstream);

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });

    expect(v.parse(JsonObjectSchema, JSON.parse(await response.text()))).toEqual(upstream);
  });

  test('a raw body under a charset-bearing JSON content type is still one completion', async () => {
    // `Ai.run` compares content type for equality with `application/json`, so a charset suffix yields the raw body.
    const { fetch: direct } = directFetch(() => {
      const body = new Response(JSON.stringify({ response: 'raw body' })).body;

      if (!body) throw new Error('fixture response carried no body');

      return body;
    });

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });

    expect(response.status).toBe(200);
    const completion = v.parse(CompletionSchema, JSON.parse(await response.text()));
    expect(completion.choices[0]?.message.content).toBe('raw body');
  });

  test('a caller that states its own stream_options keeps them', async () => {
    const { fetch: direct, runs } = directFetch(() => eventStreamOf(DONE));

    await direct(ENDPOINT, {
      method: 'POST',
      body: chatBody({ stream: true, stream_options: { include_usage: false } }),
    });

    expect(runs[0]?.inputs.stream_options).toEqual({ include_usage: false });
  });
});

describe('direct Workers AI binding — the AI SDK consumes it', () => {
  test('streamText reads a native binding stream as OpenAI SSE', async () => {
    const { fetch: direct } = directFetch(textThenUsage('streamed', ' through', {
      prompt_tokens: 4, completion_tokens: 2, total_tokens: 6,
    }));

    const model = createOpenAICompatible({
      name: 'workers-ai',
      baseURL: 'https://kinu-direct-workers-ai.invalid',
      fetch: direct,
    }).chatModel(MODEL);

    const result = streamText({ model, prompt: 'ping' });
    let text = '';

    for await (const delta of result.textStream) text += delta;

    expect(text).toBe('streamed through');
    expect(await result.finishReason).toBe('stop');
    const usage = await result.usage;
    expect(usage.inputTokens).toBe(4);
    expect(usage.outputTokens).toBe(2);
  });

  test('streamText reports the tokens of a usage-only frame that follows the finish', async () => {
    // KINU-049: usage on its own frame after a content-frame finish reason must reach the SDK.
    const finishChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{"role":"assistant","content":"counted"},"finish_reason":"stop"}]}';

    const { fetch: direct } = directFetch(() => eventStreamOf(
      `data: ${finishChunk}\n\n${sse({ usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 } })}${DONE}`,
    ));

    const model = createOpenAICompatible({
      name: 'workers-ai',
      baseURL: 'https://kinu-direct-workers-ai.invalid',
      fetch: direct,
    }).chatModel(MODEL);

    const result = streamText({ model, prompt: 'ping' });
    let text = '';

    for await (const delta of result.textStream) text += delta;

    expect(text).toBe('counted');
    expect(await result.finishReason).toBe('stop');
    const usage = await result.usage;
    expect(usage.inputTokens).toBe(31);
    expect(usage.outputTokens).toBe(7);
  });

  test('a tool result pairs back to its own call across two responses in one turn', async () => {
    // The id is a pairing key for `{ toolCallId, output }`; two steps must not both mint `call-1`.
    const commands = [{ cmd: 'ls' }, { cmd: 'pwd' }];
    let step = 0;

    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [{ name: 'shell', arguments: commands[step++] ?? {} }] }),
      DONE,
    ].join('')));

    const model = createOpenAICompatible({
      name: 'workers-ai',
      baseURL: 'https://kinu-direct-workers-ai.invalid',
      fetch: direct,
    }).chatModel(MODEL);

    const tools = {
      run: tool({
        description: 'Run a shell command in the workspace.',
        inputSchema: jsonSchema<{ cmd: string }>({
          type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' } },
        }),
      }),
    };

    const answered = new Map<string, unknown>();

    for (const _step of commands) {
      const result = streamText({ model, tools, prompt: 'ping' });
      await result.consumeStream();

      for (const call of await result.toolCalls) answered.set(call.toolCallId, call.input);
    }

    expect(answered.size).toBe(2);
    expect([...answered.values()]).toEqual(commands);
  });

  test('a replayed assistant turn that only called tools reaches the binding with string content', async () => {
    // KINU-085: the binding validator refuses `content: null` beside `tool_calls` (AiError 5006, staging 2026-09-05);
    // the empty string is the spelling the schema admits.
    const { fetch: direct, runs } = directFetch(() => ({ response: '999' }));

    const model = createOpenAICompatible({
      name: 'workers-ai',
      baseURL: 'https://kinu-direct-workers-ai.invalid',
      fetch: direct,
    }).chatModel(MODEL);

    const tools = {
      add: tool({
        description: 'Add two integers.',
        inputSchema: jsonSchema<{ a: number; b: number }>({
          type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } },
        }),
      }),
    };

    const history: ModelMessage[] = [
      { role: 'user', content: 'Call add for 142 and 857, then give the sum.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Adding them with the tool.' },
          { type: 'tool-call', toolCallId: 'call-kinu-i-0', toolName: 'add', input: { a: 142, b: 857 } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-kinu-i-0', toolName: 'add', output: { type: 'json', value: 999 } }],
      },
      { role: 'user', content: 'Use the completed tool result. Give only the sum.' },
    ];

    const result = await generateText({ model, tools, messages: history });

    expect(result.text).toBe('999');
    const sent = v.parse(v.array(JsonObjectSchema), runs[0]?.inputs.messages);
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'Adding them with the tool.',
      tool_calls: [{ id: 'call-kinu-i-0', type: 'function', function: { name: 'add', arguments: '{"a":142,"b":857}' } }],
    });
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call-kinu-i-0', content: '999' });
  });
});
