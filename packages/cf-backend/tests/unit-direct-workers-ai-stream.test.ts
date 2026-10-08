// The deployment's Workers AI binding through workers-ai-provider (patched, `patches/workers-ai-provider@4.0.0.patch`):
// parts stream before the completion exists, concurrent turns on one binding stay apart whatever shape `Ai.run` hands
// each (workerd rereads its options after awaiting), and a refusal keeps the status the stack's retry reads.
import { describe, test, expect } from 'bun:test';
import { APICallError, generateText, stepCountIs, streamText, tool, jsonSchema, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai';
import { JsonObjectSchema, type JsonObject } from '@kinu.run/core';
import * as v from 'valibot';
import { bindingModel, DONE, eventStream, eventStreamOf, sharedBindingModels, sse, type BindingAnswer, type RecordedRun } from './helpers/workers-ai-model';

/** What every provider family round-trips verbatim in a JSON id field: ASCII letters, digits and `_.:-`. */
const PORTABLE = /^[A-Za-z0-9_.:-]+$/u;

const MODEL = '@cf/moonshotai/kimi-k2.6';

const PROMPT = 'the exact words the person typed';

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

/** Content frames, a usage-only frame, then [DONE]; fresh body per call. */
function textThenUsage(first: string, second: string, usage: JsonObject): () => Response {
  return () => eventStreamOf([sse({ response: first }), sse({ response: second }), sse({ response: '', usage }), DONE].join(''));
}

async function parts(model: Parameters<typeof streamText>[0]['model'], tools?: ToolSet): Promise<TextStreamPart<ToolSet>[]> {
  const collected: TextStreamPart<ToolSet>[] = [];

  for await (const part of streamText({ model, prompt: PROMPT, maxRetries: 0, ...(tools !== undefined && { tools }) }).stream) collected.push(part);

  return collected;
}

const shellTool = {
  shell: tool({
    description: 'Run a shell command in the workspace.',
    inputSchema: jsonSchema<{ cmd: string }>({ type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' } } }),
  }),
};

/** The ids one streamed response minted for its tool calls, in order. */
async function streamedCallIds(model: Parameters<typeof streamText>[0]['model']): Promise<string[]> {
  const result = streamText({ model, tools: shellTool, prompt: PROMPT, maxRetries: 0 });

  return (await result.toolCalls).map((call) => call.toolCallId);
}

async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (cause) {
    return v.parse(v.instance(Error), cause);
  }

  return new Error('the call succeeded');
}

async function refusalOf(run: Promise<unknown>): Promise<APICallError> {
  const failure = await failureOf(run);
  const error = APICallError.isInstance(failure) ? failure : v.parse(v.object({ lastError: v.unknown() }), failure).lastError;

  if (!APICallError.isInstance(error)) throw new Error(`not an APICallError: ${String(failure)}`);

  return error;
}

describe('Workers AI binding — a refusal keeps what the retry reads', () => {
  // Measured on staging 2026-09-06: the binding answered `3021: rate limiting`; the stack's retry waits on the status.
  test('a 429 envelope is a retryable failure carrying its status and Retry-After', async () => {
    const { model, runs } = bindingModel(() => new Response(
      JSON.stringify({ errors: [{ code: 3021, message: 'rate limiting: inference request per min rate reached' }] }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
    ));

    const failure = await refusalOf(generateText({ model, prompt: PROMPT, maxRetries: 0 }));

    expect(runs).toHaveLength(1);
    expect(failure.statusCode).toBe(429);
    expect(failure.isRetryable).toBe(true);
    expect(failure.responseHeaders?.['retry-after']).toBe('1');
    expect(failure.responseBody).toContain('3021');
  });

  // A spent daily allocation (3036) is read off the envelope by the retry, which must not wait it out.
  test.each([
    [3036, 'You have used up your daily free allocation of 10,000 neurons.', 429],
    [3040, 'Upstream unavailable', 502],
  ])('a %d refusal keeps its status, its own message and its envelope', async (code, message, status) => {
    const { model } = bindingModel(() => new Response(JSON.stringify({ errors: [{ code, message }] }), {
      status, headers: { 'content-type': 'application/json' },
    }));

    const failure = await refusalOf(generateText({ model, prompt: PROMPT, maxRetries: 0 }));

    expect(failure.statusCode).toBe(status);
    expect(failure.message).toContain(message);
    expect(v.parse(v.object({ errors: v.array(v.object({ code: v.number() })) }), JSON.parse(failure.responseBody ?? '')).errors[0]?.code)
      .toBe(code);
  });

  test('the binding internal-code envelope reaches the caller with its status', async () => {
    const { model } = bindingModel(() => new Response(
      JSON.stringify({ internalCode: 3006, description: 'Invalid or incomplete input', name: 'InferenceUpstreamError' }),
      { status: 400 },
    ));

    const failure = await refusalOf(generateText({ model, prompt: PROMPT, maxRetries: 0 }));

    expect(failure.statusCode).toBe(400);
    expect(failure.message).toContain('3006');
    expect(failure.message).toContain('Invalid or incomplete input');
  });

  test('a thrown binding failure becomes an APICallError carrying the binding message', async () => {
    const { model } = bindingModel(() => {
      throw new Error('3040: capacity temporarily exceeded');
    });

    const failure = await refusalOf(generateText({ model, prompt: PROMPT, maxRetries: 0 }));

    expect(failure.message).toContain('3040: capacity temporarily exceeded');
    expect(failure.statusCode).toBe(429);
  });
});

describe('Workers AI binding — incremental streaming', () => {
  test('the first part reaches the caller while the upstream stream is still open', async () => {
    const upstream = manualStream();
    const { model, runs } = bindingModel(() => eventStream(upstream.stream));
    const reader = streamText({ model, prompt: PROMPT, maxRetries: 0 }).textStream.getReader();

    upstream.push(sse({ response: 'first' }));
    expect(await reader.read()).toEqual({ done: false, value: 'first' });
    expect(upstream.closed()).toBe(false);

    upstream.push(sse({ response: ' second' }));
    expect(await reader.read()).toEqual({ done: false, value: ' second' });

    upstream.push(sse({ response: '', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    upstream.close();
    expect((await reader.read()).done).toBe(true);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.inputs.stream).toBe(true);
    expect(runs[0]?.inputs.stream_options).toEqual({ include_usage: true });
    expect(runs[0]?.options?.returnRawResponse).toBe(true);
  });

  test('a [DONE] ends a stream the binding holds open behind it, and cancels the body', async () => {
    const upstream = manualStream();
    const { model } = bindingModel(() => eventStream(upstream.stream));
    const result = streamText({ model, prompt: PROMPT, maxRetries: 0 });

    upstream.push(`${sse({ response: 'held' })}${sse({ response: '', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}${DONE}`);

    expect(await result.text).toBe('held');
    expect(await result.finishReason).toBe('stop');
    expect(upstream.closed()).toBe(false);
    expect(upstream.cancelled()).toBe(true);
  });

  // workerd's `Ai.run` keeps its options on the shared binding and rereads `returnRawResponse` after awaiting upstream,
  // so whichever call entered last decides every overlapping call's return shape; the content stays each call's own.
  test.each([
    ['a raw-response call entered last, alpha answered first', false, ['kinu-alpha', 'kinu-beta', 'other']],
    ['a raw-response call entered last, beta answered first', false, ['kinu-beta', 'other', 'kinu-alpha']],
    ['a call wanting no raw response entered last, alpha answered first', true, ['kinu-alpha', 'other', 'kinu-beta']],
    ['a call wanting no raw response entered last, beta answered first', true, ['other', 'kinu-beta', 'kinu-alpha']],
  ] as const)('two turns on one binding keep their own frames and calls: %s', async (_case, otherLast, release) => {
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>(release.map((key) => [key, Promise.withResolvers<undefined>()]));
    const keyOf = (run: RecordedRun) => run.options?.extraHeaders?.['x-session-affinity'] ?? 'other';

    const answer = (run: RecordedRun) => new Response([
      sse({ response: `${keyOf(run)} says` }),
      sse({ tool_calls: [{ id: `call-${keyOf(run)}`, name: 'shell', arguments: { cmd: keyOf(run) } }] }),
      DONE,
    ].join('')).body ?? new ReadableStream();

    const { models, binding, runs } = sharedBindingModels(['kinu-alpha', 'kinu-beta'], answer, async (run) => { await gates.get(keyOf(run))?.promise; });
    const other = () => binding.run('@cf/baai/bge-m3', { text: ['x'] });
    const otherCall = otherLast ? undefined : other();
    const turns = new Map(models.map((model, at) => [at === 0 ? 'kinu-alpha' : 'kinu-beta', streamText({ model, prompt: PROMPT, tools: shellTool, maxRetries: 0 })]));

    while (runs.length < (otherLast ? 2 : 3)) await Promise.resolve();
    const lastCall = otherLast ? other() : otherCall;

    while (runs.length < 3) await Promise.resolve();

    for (const key of release) gates.get(key)?.resolve(undefined);
    await lastCall;

    for (const [affinity, result] of turns) {
      expect(await result.text).toBe(`${affinity} says`);
      expect((await result.toolCalls).map((call) => call.input)).toEqual([{ cmd: affinity }]);
    }
  });

  test('an aborted turn stops the provider work', async () => {
    const upstream = manualStream();
    const controller = new AbortController();
    const { model, runs } = bindingModel(() => eventStream(upstream.stream));
    const result = streamText({ model, prompt: PROMPT, maxRetries: 0, abortSignal: controller.signal });
    const reader = result.textStream.getReader();

    upstream.push(sse({ response: 'partial' }));
    await reader.read();

    const seen = runs[0]?.options?.signal;
    expect(seen?.aborted).toBe(false);
    expect(upstream.cancelled()).toBe(false);

    // The binding's subrequest carries this signal: aborting it ends the upstream body, or the model keeps generating.
    controller.abort();
    await reader.cancel();

    expect(seen?.aborted).toBe(true);
  });

  test('a cancelled binding call is rethrown as the cancellation, never as a provider failure', async () => {
    const { model } = bindingModel(() => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const failure = await failureOf(generateText({ model, prompt: PROMPT, maxRetries: 0 }));

    expect(APICallError.isInstance(failure)).toBe(false);
    expect(String(failure)).toContain('The operation was aborted');
  });
});

describe('Workers AI binding — usage and finish', () => {
  test('a native stream ends with one finish reason and its usage', async () => {
    const { model } = bindingModel(textThenUsage('one', ' two', { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }));
    const streamed = await parts(model);

    expect(streamed.flatMap((part) => (part.type === 'text-delta' ? [part.text] : [])).join('')).toBe('one two');
    const finishes = streamed.filter((part) => part.type === 'finish');
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.type === 'finish' && finishes[0].finishReason).toBe('stop');
    expect(finishes[0]?.type === 'finish' && finishes[0].totalUsage).toMatchObject({ inputTokens: 9, outputTokens: 4 });
  });

  test('OpenAI-shaped chunks are read, and their finish reason is not duplicated', async () => {
    const upstreamChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{"role":"assistant","content":"hi","reasoning_content":"because"}}]}';

    const finishChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}';

    // No upstream [DONE]: the finish reason is the terminal state.
    const { model } = bindingModel(() => eventStreamOf(`data: ${upstreamChunk}\n\ndata: ${finishChunk}\n\n`));
    const result = streamText({ model, prompt: PROMPT, maxRetries: 0 });

    expect(await result.text).toBe('hi');
    expect(await result.reasoningText).toBe('because');
    expect(await result.finishReason).toBe('stop');
    expect(await result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });
  });

  test('a usage-only frame that omits choices still reports its usage after an upstream finish', async () => {
    // KINU-049: a usage-only frame without `choices` must still be reported after an OpenAI finish reason.
    const finishChunk = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m",'
      + '"choices":[{"index":0,"delta":{"role":"assistant","content":"counted"},"finish_reason":"stop"}]}';

    const { model } = bindingModel(() => eventStreamOf(
      `data: ${finishChunk}\n\n${sse({ usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 } })}${DONE}`,
    ));

    const result = streamText({ model, prompt: PROMPT, maxRetries: 0 });

    expect(await result.text).toBe('counted');
    expect(await result.finishReason).toBe('stop');
    expect(await result.usage).toMatchObject({ inputTokens: 31, outputTokens: 7 });
  });

  test('a usage-only frame with empty choices ends the response once', async () => {
    const head = '{"id":"chatcmpl-upstream","object":"chat.completion.chunk","created":7,"model":"m"';
    const delta = `${head},"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}`;
    const usageOnly = `${head},"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}`;
    const { model } = bindingModel(() => eventStreamOf(`data: ${delta}\n\ndata: ${usageOnly}\n\n${DONE}`));
    const streamed = await parts(model);

    expect(streamed.filter((part) => part.type === 'finish')).toHaveLength(1);
    const finish = streamed.find((part) => part.type === 'finish');
    expect(finish?.type === 'finish' && finish.finishReason).toBe('stop');
    expect(finish?.type === 'finish' && finish.totalUsage).toMatchObject({ inputTokens: 8, outputTokens: 2 });
  });

  // An unreadable frame is an error part; dropping it would lose content while reporting success.
  test.each([
    ['is not JSON at all', 'data: {oops\n\n'],
    ['is JSON but not an object', 'data: 3\n\n'],
  ])('a data frame that %s fails the stream loudly', async (_case, frame) => {
    const { model } = bindingModel(() => eventStreamOf(`${sse({ response: 'kept' })}${frame}${DONE}`));
    const streamed = await parts(model);
    const errors = streamed.flatMap((part) => (part.type === 'error' ? [String(part.error)] : []));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not a JSON object');
    const finish = streamed.find((part) => part.type === 'finish');
    expect(finish?.type === 'finish' && finish.finishReason).toBe('error');
  });

  test.each([
    ['an event stream that carries nothing', (): BindingAnswer => eventStreamOf('')],
    ['a JSON body under an event-stream content type', (): BindingAnswer => eventStreamOf(JSON.stringify({ response: 'whole' }))],
    ['a body under some other content type', (): BindingAnswer => new Response('pong', { headers: { 'content-type': 'text/plain' } })],
  ])('%s fails the stream with an error part, never an empty success', async (_case, answer) => {
    const { model } = bindingModel(answer);
    const streamed = await parts(model);

    // A consumer reads a failed step off an error part; a finish reason alone reads as a completed, empty step.
    expect(streamed.filter((part) => part.type === 'error').map((part) => part.type === 'error' && APICallError.isInstance(part.error) && part.error.isRetryable)).toEqual([true]);
    const finish = streamed.find((part) => part.type === 'finish');
    expect(finish?.type === 'finish' && finish.finishReason).toBe('error');
  });

  test('OpenAI-shaped calls started together keep each argument stream until the response ends', async () => {
    const call = (index: number, delta: JsonObject) => sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...delta }] } }] });

    const { model } = bindingModel(() => eventStreamOf([
      call(0, { id: 'call_a', type: 'function', function: { name: 'shell', arguments: '' } }),
      call(1, { id: 'call_b', type: 'function', function: { name: 'shell', arguments: '' } }),
      call(0, { function: { arguments: '{"cmd":"ls"}' } }),
      call(1, { function: { arguments: '{"cmd":"pwd"}' } }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ].join('')));

    const result = streamText({ model, prompt: PROMPT, tools: shellTool, maxRetries: 0 });

    expect((await result.toolCalls).map((each) => each.input)).toEqual([{ cmd: 'ls' }, { cmd: 'pwd' }]);
  });

  test('a whole completion answering a streamed request arrives as one synthetic stream', async () => {
    // The provider's own degradation for a model that does not stream; the stack's silence bound still applies.
    const { model } = bindingModel(() => ({ response: 'whole answer', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    const result = streamText({ model, prompt: PROMPT, maxRetries: 0 });

    expect(await result.text).toBe('whole answer');
    expect(await result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });
});

describe('Workers AI binding — tool-call ids', () => {
  test('native tool calls stream as calls whose ids are portable and unique within the response', async () => {
    const { model } = bindingModel(() => eventStreamOf([
      sse({ response: '' }),
      sse({ tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }, { name: 'shell', arguments: { cmd: 'pwd' } }] }),
      sse({ tool_calls: [{ id: 'call-upstream', name: 'shell', arguments: '{"cmd":"id"}' }] }),
      DONE,
    ].join('')));

    const result = streamText({ model, tools: shellTool, prompt: PROMPT, maxRetries: 0 });
    const calls = await result.toolCalls;

    expect(calls.map((call) => call.input)).toEqual([{ cmd: 'ls' }, { cmd: 'pwd' }, { cmd: 'id' }]);
    expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(3);
    expect(calls.every((call) => PORTABLE.test(call.toolCallId))).toBe(true);
    expect(calls[2]?.toolCallId).toContain('-n-call-upstream');
    expect(await result.finishReason).toBe('tool-calls');
  });

  test('two responses whose native tool-call ids are both "0" cannot produce the same id', async () => {
    // KINU-N002: a per-response id repeated across steps paired results with the wrong call.
    const { model } = bindingModel(() => eventStreamOf([
      sse({ tool_calls: [{ id: '0', name: 'shell', arguments: { cmd: 'ls' } }] }),
      DONE,
    ].join('')));

    const [first] = await streamedCallIds(model);
    const [second] = await streamedCallIds(model);

    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });

  test('an empty or unusable native tool-call id never becomes the pairing key', async () => {
    // Spaces or `/` do not round-trip as ids; `read file/1` degrades to the position.
    const { model } = bindingModel(() => eventStreamOf([
      sse({ tool_calls: [
        { id: '', name: 'shell', arguments: { cmd: 'ls' } },
        { id: '   ', name: 'shell', arguments: { cmd: 'pwd' } },
        { id: 'read file/1', name: 'shell', arguments: { cmd: 'id' } },
      ] }),
      DONE,
    ].join('')));

    const ids = await streamedCallIds(model);

    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => PORTABLE.test(id))).toBe(true);
    expect(ids[2]).toMatch(/-i-3$/u);
  });

  // KINU-N002 inside one turn: both responses name their call "0", and the third request replays both results.
  test('a tool result pairs back to its own call across two responses in one turn', async () => {
    const commands = [{ cmd: 'ls' }, { cmd: 'pwd' }];
    let step = 0;

    const { model, runs } = bindingModel(() => {
      const command = commands[step++];

      return eventStreamOf([sse(command === undefined ? { response: 'done' } : { tool_calls: [{ id: '0', name: 'shell', arguments: command }] }), DONE].join(''));
    });

    const tools = {
      shell: tool({
        description: 'Run a shell command in the workspace.',
        inputSchema: jsonSchema<{ cmd: string }>({ type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' } } }),
        execute: async ({ cmd }) => ({ ran: cmd }),
      }),
    };

    expect(await streamText({ model, tools, prompt: PROMPT, maxRetries: 0, stopWhen: stepCountIs(3) }).text).toBe('done');

    const sent = v.parse(v.array(JsonObjectSchema), runs[2]?.inputs.messages);
    const CallSchema = v.object({ id: v.string(), function: v.object({ arguments: v.string() }) });

    const asked = new Map(sent.flatMap((message) => v.parse(v.optional(v.array(CallSchema), []), message.tool_calls))
      .map((call) => [call.id, v.parse(v.object({ cmd: v.string() }), JSON.parse(call.function.arguments)).cmd]));

    const answered = sent.filter((message) => message.role === 'tool').map((message) => [
      asked.get(v.parse(v.string(), message.tool_call_id)),
      v.parse(v.object({ ran: v.string() }), JSON.parse(v.parse(v.string(), message.content))).ran,
    ]);

    expect(asked.size).toBe(2);
    expect(answered).toEqual([['ls', 'ls'], ['pwd', 'pwd']]);
  });
});

describe('Workers AI binding — whole completions', () => {
  test('a native output becomes text, tool calls and usage', async () => {
    const { model, runs } = bindingModel(() => ({
      response: 'done',
      tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }));

    const result = await generateText({ model, tools: shellTool, prompt: PROMPT, maxRetries: 0 });

    expect(result.text).toBe('done');
    expect(result.toolCalls.map((call) => call.input)).toEqual([{ cmd: 'ls' }]);
    expect(result.toolCalls.every((call) => PORTABLE.test(call.toolCallId))).toBe(true);
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(runs[0]?.inputs.stream).toBeUndefined();
    expect(v.parse(v.array(JsonObjectSchema), runs[0]?.inputs.messages)).toEqual([{ role: 'user', content: PROMPT }]);
  });

  test('two non-streamed responses in one turn cannot produce the same tool-call id', async () => {
    const { model } = bindingModel(() => ({ response: '', tool_calls: [{ name: 'shell', arguments: { cmd: 'ls' } }] }));
    const first = await generateText({ model, tools: shellTool, prompt: PROMPT, maxRetries: 0 });
    const second = await generateText({ model, tools: shellTool, prompt: PROMPT, maxRetries: 0 });

    expect(first.toolCalls[0]?.toolCallId).not.toBe(second.toolCalls[0]?.toolCallId);
  });

  test('an OpenAI-shaped output is read', async () => {
    const { model } = bindingModel(() => ({
      id: 'chatcmpl-direct', object: 'chat.completion', created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'passed' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));

    expect((await generateText({ model, prompt: PROMPT, maxRetries: 0 })).text).toBe('passed');
  });

  test('a raw body under a charset-bearing JSON content type is still one completion', async () => {
    // `Ai.run` compares the content type for equality with `application/json`, so a charset suffix yields the raw body.
    const { model } = bindingModel(() => new Response(JSON.stringify({ response: 'raw body' })).body ?? {});

    expect((await generateText({ model, prompt: PROMPT, maxRetries: 0 })).text).toBe('raw body');
  });

  test('a raw Response answering a call that did not ask for one is still read', async () => {
    const { model } = bindingModel(() => Response.json({ response: 'raced shape' }));

    expect((await generateText({ model, prompt: PROMPT, maxRetries: 0 })).text).toBe('raced shape');
  });
});

describe('Workers AI binding — what reaches `Ai.run`', () => {
  test('a replayed assistant turn that only called tools reaches the binding with string content and its own id', async () => {
    // KINU-085: the binding validator refuses `content: null` beside `tool_calls` (AiError 5006, staging 2026-09-05).
    const { model, runs } = bindingModel(() => ({ response: '999' }));

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
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-kinu-i-0', toolName: 'add', input: { a: 142, b: 857 } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-kinu-i-0', toolName: 'add', output: { type: 'json', value: 999 } }] },
      { role: 'user', content: 'Use the completed tool result. Give only the sum.' },
    ];

    expect((await generateText({ model, tools, messages: history, maxRetries: 0 })).text).toBe('999');
    const sent = v.parse(v.array(JsonObjectSchema), runs[0]?.inputs.messages);
    expect(sent[1]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-kinu-i-0', type: 'function', function: { name: 'add', arguments: '{"a":142,"b":857}' } }],
    });
    expect(sent[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-kinu-i-0', content: '999' });
  });
});
