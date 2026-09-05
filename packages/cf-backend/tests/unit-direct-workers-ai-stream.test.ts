// The direct Workers AI binding transport (src/providers/direct-workers-ai-fetch.ts).
//
// This adapter used to run every call non-streaming and replay the finished
// completion as one synthetic SSE frame, so a streamed turn produced no byte
// until the answer was complete. The suite below pins the streaming contract
// that replaced it, and the three properties the synthetic frame was hiding:
//
//   * bytes leave for the caller while the upstream stream is still open;
//   * two turns in flight on ONE binding instance do not read each other's
//     frames, headers or return shape (workerd's `Ai.run` keeps its options on
//     the binding and re-reads them after awaiting, so the shape a call gets
//     back is decided by whichever call wrote last);
//   * a model that will not stream is refused by name instead of being served
//     from a buffer, which is the failure the buffering hid.
import { describe, test, expect, afterEach } from 'bun:test';
import { generateText, streamText, tool, jsonSchema, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink, type RecordingLogger } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { createDirectWorkersAIFetch } from '../src/providers/direct-workers-ai-fetch';

const MODEL = '@cf/moonshotai/kimi-k2.6';
const ENDPOINT = 'https://kinu-direct-workers-ai.invalid/chat/completions';
const PROMPT = 'the exact words the person typed';
/** Model output a refusal must not replay back to the caller. */
const WITHHELD = 'the completion the buffering used to replay';
const DONE = 'data: [DONE]\n\n';

/** Everything workerd's `Ai.run` can hand back, which is what the adapter has
 *  to accept because a concurrent call decides which one arrives. */
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

/** A binding whose only member is `run`, answering with whatever the test
 *  returns. Any other member the adapter reached for would fail loudly here
 *  rather than becoming a silent undefined. */
function directFetch(answer: (run: RecordedRun) => BindingAnswer) {
  const runs: RecordedRun[] = [];
  const ai = {
    run(model: string, inputs: JsonObject, options?: RunOptions): Promise<BindingAnswer> {
      const recorded: RecordedRun = { model, inputs, options };
      runs.push(recorded);
      return Promise.resolve(answer(recorded));
    },
  };
  // SAFETY: this constructed fixture provides `Ai.run`, and the adapter under
  // test calls no other member of the binding.
  return { fetch: createDirectWorkersAIFetch(ai as Ai), runs };
}

function chatBody(extra: JsonObject = {}): string {
  return JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], ...extra });
}

/** An upstream body the test drives frame by frame, so "before the completion
 *  exists" is a state the test can be in rather than a race it hopes for. */
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

/** A body whose bytes are already known, as the upstream would deliver them. */
function eventStreamOf(text: string): Response {
  const body = new Response(text).body;
  if (!body) throw new Error('fixture response carried no body');
  return eventStream(body);
}

/** One emitted SSE frame at a time, so a test can read the head of a stream
 *  without draining it. */
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

/** Every emitted frame parsed as the chunk shape the AI SDK requires, so a
 *  malformed frame fails here instead of reading as a missing field. */
function chunks(payloads: readonly string[]): Chunk[] {
  return payloads
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => v.parse(ChunkSchema, JSON.parse(payload)));
}

/** One streamed response, drained. Every frame of one response carries the SAME
 *  id, and that id is the response-unique half of a synthesized tool-call id.
 *  Holding it here makes that property true of every test that reads a call. */
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
    // The proof: a decoded chunk is in the caller's hands and the upstream has
    // neither closed nor sent a finish frame. A buffered adapter cannot be here.
    expect(deltaOf(await reader.next())).toEqual({ role: 'assistant', content: 'first' });
    expect(upstream.closed()).toBe(false);

    upstream.push(sse({ response: ' second' }));
    expect(deltaOf(await reader.next())).toEqual({ content: ' second' });

    upstream.push(sse({ response: '', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    upstream.close();
    expect((await reader.rest()).at(-1)).toBe('[DONE]');

    // The binding was asked to stream, and asked for usage it would otherwise
    // not report.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.inputs.stream).toBe(true);
    expect(runs[0]?.inputs.stream_options).toEqual({ include_usage: true });
    expect(runs[0]?.options?.returnRawResponse).toBe(true);

    // First-byte evidence, carrying no prompt and no credential.
    const ttft = logger.emitted.filter((line) => line.event === 'workers_ai.direct_stream_first_byte');
    expect(ttft).toHaveLength(1);
    expect(Object.keys(ttft[0]!.fields).sort()).toEqual(['bytes', 'model', 'ms']);
    expect(ttft[0]!.fields.model).toBe(MODEL);
    expect(Number.isInteger(ttft[0]!.fields.ms)).toBe(true);
    expect(ttft[0]!.fields.bytes).toBe(sse({ response: 'first' }).length);
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
    // Nothing has been pushed, so no first byte exists. The adapter cannot have
    // answered, and the assertion holds however many microtasks have run: it is
    // a statement about the upstream having produced nothing, not about elapsed
    // time.
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
    // Different return shapes on purpose: `Ai.run` re-reads
    // `options.returnRawResponse` off the binding AFTER awaiting upstream, so a
    // concurrent call can hand this adapter the shape it did not ask for.
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
    // Sentinels carry a non-hex letter ON PURPOSE: the adapter mints random
    // chunk ids (`chatcmpl-<uuid>`), and a hex uuid can spell any [0-9a-f]
    // run — the hammer caught `chatcmpl-4faaa370…` satisfying a bare 'aaa'.
    alpha.push(sse({ response: 'AXAXA' }));
    beta.push(sse({ response: 'BXBXB' }));

    const alphaFrames = frames((await alphaPending).body);
    const betaFrames = frames((await betaPending).body);

    // Interleave the reads, which is what two turns in one isolate really do.
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

    // The binding holds the caller's own signal, so the upstream request is
    // cancellable at the source.
    expect(runs[0]?.options?.signal).toBe(controller.signal);
    expect(upstream.cancelled()).toBe(false);

    // Cancelling the delivered body is what the AI SDK does on abort, and it
    // has to reach the upstream reader or the model keeps generating.
    controller.abort();
    await reader.cancel();
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
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ response: 'one' }),
      sse({ response: ' two' }),
      sse({ response: '', usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }),
      DONE,
    ].join('')));

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
        { name: 'run', arguments: { cmd: 'ls' } },
        { id: 'call-upstream', name: 'run', arguments: '{"cmd":"pwd"}' },
      ] }),
      DONE,
    ].join('')));

    const streamed = await drainStreamed(direct);

    // The index keeps counting across frames, so a synthesized id is stable and
    // unique within the response however the upstream split its deltas. The
    // other half is the response id `drainStreamed` held to one value, so the
    // name is unique across responses too. A usable upstream id stays readable
    // INSIDE the key rather than being replaced by a position, and it is scoped
    // like every other one: an upstream id can itself be a per-response counter
    // that repeats on the next response.
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
        function: { name: 'run', arguments: '{"cmd":"ls"}' },
      },
      {
        index: 3, id: `call-${streamed.responseId}-n-call-upstream`, type: 'function',
        function: { name: 'run', arguments: '{"cmd":"pwd"}' },
      },
    ]);
    expect(streamed.chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  test('two streamed responses in one turn cannot produce the same tool-call id', async () => {
    // KINU-N002: the fallback was `call-${index + 1}`, so a turn whose second
    // step also opened with an unnamed tool call produced a second `call-1`.
    // Every consumer keys on that string: the durable transcript pairs a result
    // with a call by it, and the surface renders a row by it — so the second
    // step's result could land against the first step's call.
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [{ name: 'run', arguments: { cmd: 'ls' } }] }),
      DONE,
    ].join('')));

    const first = await drainStreamed(direct);
    const second = await drainStreamed(direct);

    // Same tool, same arguments, same index — and still two distinct names,
    // because the response is half of the identity.
    expect(first.responseId).not.toBe(second.responseId);
    expect(first.toolCalls[0]?.id).toBe(`call-${first.responseId}-i-1`);
    expect(second.toolCalls[0]?.id).toBe(`call-${second.responseId}-i-1`);
  });

  test('two responses whose native tool-call ids are both "0" cannot produce the same id', async () => {
    // A native id is not an identity on its own. A provider that numbers calls
    // per RESPONSE hands back `"0"` again on the next response of the same
    // turn, so forwarding it verbatim reproduced exactly the collision the
    // position had — and `??` never fired, because the id was present.
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [{ id: '0', name: 'run', arguments: { cmd: 'ls' } }] }),
      DONE,
    ].join('')));

    const first = await drainStreamed(direct);
    const second = await drainStreamed(direct);

    expect(first.toolCalls[0]?.id).not.toBe(second.toolCalls[0]?.id);
    // The provider's own name for the call survives inside each key.
    expect(first.toolCalls[0]?.id).toBe(`call-${first.responseId}-n-0`);
    expect(second.toolCalls[0]?.id).toBe(`call-${second.responseId}-n-0`);
  });

  test('an empty or unusable native tool-call id never becomes the pairing key', async () => {
    // An empty id pairs with every other empty id, so an empty id is the worst
    // case of all: it pairs everything with everything. A space or a `/` is not
    // a character every family's JSON id field round-trips. Both degrade to the
    // position, which is unique within the response.
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [
        { id: '', name: 'run', arguments: { cmd: 'ls' } },
        { id: '   ', name: 'run', arguments: { cmd: 'pwd' } },
        { id: 'read file/1', name: 'run', arguments: { cmd: 'id' } },
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
    // KINU-049: a usage report can arrive as a frame of its own with no
    // `choices` at all, which parses in neither chunk shape. It was recorded
    // and then dropped, because the synthesized frame that carried the recorded
    // usage was emitted only when NO finish reason had gone out — and an
    // OpenAI-shaped stream sends one. The turn then reported no tokens.
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
    // One finish state on the wire, and the usage reported exactly once.
    expect(emitted.filter((chunk) => (chunk.choices[0]?.finish_reason ?? null) !== null)).toHaveLength(1);
    const reported = emitted.filter((chunk) => chunk.usage !== undefined);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 });
    expect(payloads.filter((payload) => payload === '[DONE]')).toHaveLength(1);
  });

  test('a usage-only frame with empty choices does not put two terminal frames on the wire', async () => {
    // The same report in the shape that DOES parse as an OpenAI chunk. Forwarded
    // verbatim it marked no finish, so the synthesized finish frame followed it
    // and one response ended twice.
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

  // A frame this adapter cannot translate cannot be forwarded either, and
  // dropping it would lose whatever it said while the turn still reported
  // success. Ending the stream is the only honest answer.
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
    // A body the JSON sniff cannot recognise, so only the content type says it
    // is not an event stream. Without that check it would be streamed as a
    // stream of nothing.
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
    // refusal that leaked the completion would be the buffering again by
    // another route.
    expect(message).not.toContain(WITHHELD);
    expect(logger.emitted.map((line) => line.event)).toContain('workers_ai.direct_stream_unsupported');
  });

  test('an upstream failure keeps its status and carries its own message', async () => {
    const { fetch: direct } = directFetch(() => new Response(
      JSON.stringify({ errors: [{ code: 3040, message: 'Too many requests' }] }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody({ stream: true }) });

    expect(response.status).toBe(429);
    expect(v.parse(MessageErrorSchema, JSON.parse(await response.text())).error.message)
      .toBe('3040: Too many requests');
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

    // A request for one whole answer never asks for stream usage, and the model
    // travels as the binding's own argument rather than inside the inputs.
    expect(runs[0]?.inputs).toEqual({
      messages: [{ role: 'user', content: PROMPT }],
      stream: false,
    });
  });

  test('a completion indexes its synthesized tool-call ids within its own id', async () => {
    const { fetch: direct } = directFetch(() => ({
      response: '',
      tool_calls: [
        { name: 'run', arguments: { cmd: 'ls' } },
        { name: 'run', arguments: { cmd: 'pwd' } },
      ],
    }));

    const response = await direct(ENDPOINT, { method: 'POST', body: chatBody() });

    // The response half is the completion's OWN id, which is minted once and
    // carried on the wire — so the persisted id is the id the caller read, and
    // replay reproduces it rather than minting a new one.
    const completion = v.parse(CompletionSchema, await response.json());
    expect(completion.choices[0]?.message.tool_calls?.map((call) => call.id)).toEqual([
      `call-${completion.id}-i-1`,
      `call-${completion.id}-i-2`,
    ]);
  });

  test('two non-streamed responses in one turn cannot produce the same tool-call id', async () => {
    const { fetch: direct } = directFetch(() => ({
      response: '',
      tool_calls: [{ name: 'run', arguments: { cmd: 'ls' } }],
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
    // `Ai.run` compares the content type for EQUALITY with `application/json`,
    // so `application/json; charset=utf-8` makes it hand back the raw body for a
    // request that asked for a whole answer.
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
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ response: 'streamed' }),
      sse({ response: ' through' }),
      sse({ response: '', usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
      DONE,
    ].join('')));
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
    // The end of KINU-049: an OpenAI-shaped stream announces its finish reason
    // on a content frame and the platform reports usage on a frame of its own.
    // The recorded usage reached no frame at all, so the SDK saw none and the
    // whole turn was accounted at zero tokens.
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
    // The id is a PAIRING KEY: a tool result travels as `{ toolCallId, output }`
    // and the transcript finds the call it answers by that string. Two steps of
    // one turn that both open with an unnamed tool call used to mint the same
    // `call-1`, so the second step's result resolved against the first's call.
    const commands = [{ cmd: 'ls' }, { cmd: 'pwd' }];
    let step = 0;
    const { fetch: direct } = directFetch(() => eventStreamOf([
      sse({ tool_calls: [{ name: 'run', arguments: commands[step++] ?? {} }] }),
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

    // Two calls, two keys. A colliding id would leave ONE entry here, and the
    // second step's result would answer the first step's call.
    expect(answered.size).toBe(2);
    expect([...answered.values()]).toEqual(commands);
  });

  test('a replayed assistant turn that only called tools reaches the binding with string content', async () => {
    // KINU-085, the wire half. An OpenAI chat request spells that turn as
    // `content: null` beside `tool_calls` and OpenAI's endpoint takes it; the
    // binding's validator refuses the whole request instead — AiError 5006,
    // "Type mismatch of '/messages/1/content', 'string' not in 'null'" — on
    // @cf/qwen/qwen3-30b-a3b-fp8 and @cf/openai/gpt-oss-20b alike (staging,
    // 2026-09-05), so every replay of a tool-calling turn was refused. The
    // empty string is the same message in the spelling the schema admits.
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
