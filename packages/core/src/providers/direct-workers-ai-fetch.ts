// OpenAI-compatible fetch over the direct Workers AI binding. `Ai.run` stores its options on the shared binding and
// rereads them after awaiting upstream, so a concurrent call can pick this call's return shape: accept every shape.
import { JsonObjectSchema, type JsonObject } from '../utils/json';
import { asFetchFunction } from './fetch-shim';
import { toolCallIdFor } from './tool-call-id';
import { withRateLimitRetry, type RateLimitRetryOptions } from './rate-limit-retry';
import { diagnostics, renderCauseChain, toKinuError, tolerate } from '../obs/index';
import * as v from 'valibot';
import { errorResponse } from './cloudflare-ai-fetch';
import { createCachedUsageRepair } from './stream-usage-repair';
import { watchSseTerminal } from './sse-terminal';
import { REAL_CLOCK } from '../types/clock';

/** Only the fields this adapter reads; everything else travels through untouched. */
const ChatCompletionRequestSchema = v.looseObject({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
  stream: v.optional(v.boolean(), false),
  messages: v.optional(v.array(JsonObjectSchema)),
});

type ChatCompletionRequest = v.InferOutput<typeof ChatCompletionRequestSchema>;

/** `response` and `tool_calls` are nullable because a usage-only streamed delta sets neither. */
const NativeOutputSchema = v.looseObject({
  response: v.optional(v.nullable(v.string()), ''),
  tool_calls: v.optional(v.nullable(v.array(v.looseObject({
    id: v.optional(v.string()),
    name: v.string(),
    arguments: v.optional(v.union([v.string(), JsonObjectSchema]), ''),
  }))), []),
  usage: v.optional(JsonObjectSchema),
});

/** `choices` is required: its presence tells the two dialects apart; an empty one is a usage report. */
const ChunkSchema = v.looseObject({
  choices: v.array(v.looseObject({
    finish_reason: v.optional(v.nullable(v.string())),
  })),
  usage: v.optional(JsonObjectSchema),
});

/** The two error shapes `ai-api.ts` `_parseError` reads. */
const UpstreamErrorSchema = v.looseObject({
  internalCode: v.optional(v.number()),
  description: v.optional(v.string()),
  message: v.optional(v.string()),
  errors: v.optional(v.array(v.looseObject({
    code: v.optional(v.number()),
    message: v.optional(v.string()),
  }))),
});

interface DirectWorkersAIRunOptions {
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  returnRawResponse?: boolean;
}

/** Every arm is reachable: the returned shape depends on binding state a concurrent call also writes. */
interface DirectWorkersAIRunner {
  run(
    model: string,
    inputs: JsonObject,
    options?: DirectWorkersAIRunOptions,
  ): Promise<Response | ReadableStream<Uint8Array> | JsonObject>;
}

/** Rate limits are waited out via Retry-After, as on the OAuth fetch; the SDK's own retries give up too soon. */
export function createDirectWorkersAIFetch(
  binding: DirectWorkersAIRunner,
  retry: RateLimitRetryOptions = {},
): typeof globalThis.fetch {
  return withRateLimitRetry(directWorkersAIFetch(binding), retry);
}

function directWorkersAIFetch(binding: DirectWorkersAIRunner): typeof globalThis.fetch {
  return asFetchFunction(async (input, init) => {
    // Narrowed to a string URL: workers-types `Request` rejects a `string | URL` union.
    const request = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init);
    const body = v.parse(JsonObjectSchema, JSON.parse(await request.text()));
    const route = v.parse(ChatCompletionRequestSchema, body);

    const options: DirectWorkersAIRunOptions = {
      signal: request.signal,
      returnRawResponse: true,
    };

    const affinity = request.headers.get('x-session-affinity');

    if (affinity) options.extraHeaders = { 'x-session-affinity': affinity };

    const startedAt = Date.now();
    let answer: Response | ReadableStream<Uint8Array> | JsonObject;

    try {
      answer = await binding.run(route.model, bindingInputs(body, route), options);
    } catch (caught) {
      const failure = toKinuError({
        doing: `Workers AI binding inference for ${route.model}`,
        cause: caught,
        otherwise: 'io',
      });

      // A cancelled call is the caller's decision, not a provider failure.
      if (failure.code === 'cancelled') throw caught;
      diagnostics.failure('workers_ai.direct_call_failed', failure, { model: route.model });

      return errorResponse(502, renderCauseChain(failure));
    }

    return route.stream
      ? streamedResponse(answer, route.model, startedAt)
      : completedResponse(answer, route.model);
  });
}

/** Tool-call ids are forwarded as-is: the upstream pairs on equality and re-keying would split pairs.
 *  Null `content` becomes `''` because the binding's message schema rejects null (AiError on tool-only turns). */
function bindingInputs(body: JsonObject, route: ChatCompletionRequest): JsonObject {
  const inputs: JsonObject = { ...body, stream: route.stream };
  delete inputs.model;

  if (route.messages) inputs.messages = route.messages.map(withoutNullContent);

  // The SDK only requests stream usage via `includeUsage`, which workers-ai.ts does not set; without this no tokens are reported.
  if (route.stream && inputs.stream_options === undefined) {
    inputs.stream_options = { include_usage: true };
  }

  return inputs;
}

function withoutNullContent(message: JsonObject): JsonObject {
  return message.content === null ? { ...message, content: '' } : message;
}

/** A request that asked for a whole completion. */
async function completedResponse(
  answer: Response | ReadableStream<Uint8Array> | JsonObject,
  model: string,
): Promise<Response> {
  if (answer instanceof Response && !answer.ok) return upstreamRefusal(answer, model);

  if (!(answer instanceof Response) && !(answer instanceof ReadableStream)) {
    return openAICompletion(answer, model);
  }

  // A raw body arrives only because `shell` matches `application/json` by equality (a charset defeats it), never from streaming.
  const text = await (answer instanceof Response ? answer : new Response(answer)).text();

  return openAICompletion(v.parse(JsonObjectSchema, JSON.parse(text)), model);
}

/** A request that asked to stream. */
async function streamedResponse(
  answer: Response | ReadableStream<Uint8Array> | JsonObject,
  model: string,
  startedAt: number,
): Promise<Response> {
  if (answer instanceof Response) {
    if (!answer.ok) return upstreamRefusal(answer, model);
    const contentType = answer.headers.get('content-type') ?? '';

    if (!answer.body) return unstreamable(model, 'a bodyless response');

    if (!contentType.includes('text/event-stream')) return unstreamable(model, contentType);

    return sseResponse(answer.body, model, startedAt);
  }

  if (answer instanceof ReadableStream) return sseResponse(answer, model, startedAt);

  return unstreamable(model, 'a JSON completion');
}

/** The first read is awaited before responding so an empty or JSON head is refused with a status code, not a dying stream.
 *  The producer may never close after `data: [DONE]`; the terminal watcher ends the stream there. */
async function sseResponse(
  body: ReadableStream<Uint8Array>,
  model: string,
  startedAt: number,
): Promise<Response> {
  const reader = body.getReader();
  let first: Awaited<ReturnType<typeof reader.read>>;

  try {
    first = await reader.read();
  } catch (cause) {
    // Release the lock so the binding body never stays locked behind the error.
    reader.releaseLock();

    throw cause;
  }

  // Release in `finally` so even a cancel rejection cannot leave the lock held.
  const refuseEarly = async (reason: string): Promise<Response> => {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }

    return unstreamable(model, reason);
  };

  if (first.done) return refuseEarly('an empty stream');

  const head = new TextDecoder().decode(first.value).trimStart();

  if (head.startsWith('{') || head.startsWith('[')) return refuseEarly('a JSON completion');

  diagnostics.event('workers_ai.direct_stream_first_byte', {
    model,
    ms: Date.now() - startedAt,
    bytes: first.value.byteLength,
  });

  reader.releaseLock();

  return new Response(
    watchSseTerminal(body, REAL_CLOCK, first.value).pipeThrough(openAIChunkTransform(model)),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Upstream event-stream frames in, OpenAI chunk frames out. A frame with a live choice is forwarded verbatim;
 *  native payloads and choice-less usage reports are translated, with usage leaving once with the finish state. */
function openAIChunkTransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  /** Per response, so tool-call ids stay unique across the responses of one turn. */
  const toolCallScope = `call-${id}`;
  const created = Math.floor(Date.now() / 1000);
  const repairCachedUsage = createCachedUsageRepair();
  let buffer = '';
  let opened = false;
  let toolCalls = 0;
  let finished = false;
  let closed = false;
  let failed = false;
  /** Latest usage report not yet sent; a frame that reports usage clears it so a report never leaves twice. */
  let owedUsage: JsonObject | undefined;

  const frame = (choices: JsonObject[], usage?: JsonObject): Uint8Array => {
    const chunk: JsonObject = { id, object: 'chat.completion.chunk', created, model, choices };

    if (usage) chunk.usage = usage;

    return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const finalize = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (closed) return;

    // The final state leaves in one frame; if upstream already sent a finish reason, usage goes on a choice-less chunk.
    if (!finished) {
      controller.enqueue(frame(
        [{ index: 0, delta: {}, finish_reason: toolCalls > 0 ? 'tool_calls' : 'stop' }],
        owedUsage,
      ));
      finished = true;
    } else if (owedUsage) {
      controller.enqueue(frame([], owedUsage));
    }

    owedUsage = undefined;
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    closed = true;
  };

  const translate = (
    payload: JsonObject,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const parsed = v.safeParse(NativeOutputSchema, payload);

    if (!parsed.success) {
      failed = true;
      controller.error(new Error(
        `Workers AI ${model} streamed a frame that is neither an OpenAI chunk nor a native output`,
      ));

      return;
    }

    const output = parsed.output;

    if (output.usage) owedUsage = repairCachedUsage(output.usage) ?? output.usage;
    const text = output.response ?? '';

    if (text.length > 0) {
      const delta: JsonObject = opened ? { content: text } : { role: 'assistant', content: text };
      opened = true;
      controller.enqueue(frame([{ index: 0, delta, finish_reason: null }]));
    }

    const calls = output.tool_calls ?? [];

    if (calls.length > 0) {
      const deltas = calls.map((call, offset) => ({
        index: toolCalls + offset,
        id: toolCallIdFor({ scope: toolCallScope, native: call.id, index: toolCalls + offset }),
        type: 'function',
        function: { name: call.name, arguments: toolArguments(call.arguments) },
      }));

      toolCalls += calls.length;
      opened = true;
      controller.enqueue(frame([{ index: 0, delta: { tool_calls: deltas }, finish_reason: null }]));
    }
  };

  const onData = (
    payload: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (payload === '[DONE]') {
      finalize(controller);

      return;
    }

    // A non-object `data:` line can be neither forwarded nor dropped silently, so it ends the stream.
    const decoded = tolerate<unknown>(() => JSON.parse(payload), 'malformed-input');
    const object = v.safeParse(JsonObjectSchema, decoded);

    if (!object.success) {
      failed = true;
      controller.error(new Error(`Workers AI ${model} streamed a data frame that is not a JSON object`));

      return;
    }

    // A choice-less frame is only a usage report: forwarding it would end the response twice, and the SDK requires `choices`.
    const chunk = v.safeParse(ChunkSchema, object.output);

    if (!chunk.success || chunk.output.choices.length === 0) {
      translate(object.output, controller);

      return;
    }

    if (chunk.output.choices.some((choice) => (choice.finish_reason ?? null) !== null)) {
      finished = true;
    }

    const usage = chunk.output.usage;
    const repaired = usage ? repairCachedUsage(usage) : undefined;

    if (usage) owedUsage = undefined;
    const outgoing = repaired ? JSON.stringify({ ...object.output, usage: repaired }) : payload;
    controller.enqueue(encoder.encode(`data: ${outgoing}\n\n`));
  };

  const drain = (
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (failed) return;
    const field = line.trimEnd();

    if (!field.startsWith('data:')) return;
    onData(field.slice('data:'.length).trim(), controller);
  };

  // An error here reaches the watcher through the pipe, which cancels the producer.
  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) drain(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      drain(buffer, controller);

      if (!failed) finalize(controller);
    },
  });
}

function openAICompletion(raw: JsonObject, requestedModel: string): Response {
  if (Array.isArray(raw.choices)) return jsonResponse(raw);

  const output = v.parse(NativeOutputSchema, raw);
  // Also the response-unique scope of every tool-call id below.
  const responseId = `chatcmpl-${crypto.randomUUID()}`;

  const toolCalls = (output.tool_calls ?? []).map((call, index) => ({
    id: toolCallIdFor({ scope: `call-${responseId}`, native: call.id, index }),
    type: 'function',
    function: { name: call.name, arguments: toolArguments(call.arguments) },
  }));

  const message: JsonObject = { role: 'assistant', content: output.response ?? '' };

  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const completion: JsonObject = {
    id: responseId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
  };

  if (output.usage) completion.usage = output.usage;

  return jsonResponse(completion);
}

/** Both emitting sites must encode arguments the same way or the model cannot parse the tool call. */
function toolArguments(value: string | JsonObject): string {
  return v.is(v.string(), value) ? value : JSON.stringify(value);
}

function unstreamable(model: string, saw: string): Response {
  diagnostics.event('workers_ai.direct_stream_unsupported', { model, saw });

  return errorResponse(502, `Workers AI model ${model} did not stream over the direct binding: `
    + `the upstream answered ${saw}. A streamed request is refused rather than served from a `
    + 'buffered completion.');
}

/** The raw Cloudflare envelope is never forwarded. */
async function upstreamRefusal(response: Response, model: string): Promise<Response> {
  const body = await response.text();
  diagnostics.event('workers_ai.direct_call_refused', { model, status: response.status });
  const upstream = upstreamError(body);
  const message = upstream?.message ?? `Workers AI refused ${model} with HTTP ${String(response.status)}.`;

  const refusal = new Response(
    JSON.stringify({ error: upstream?.code === undefined ? { message } : { message, code: upstream.code } }),
    { status: response.status, headers: { 'content-type': 'application/json' } },
  );

  // Forward the mandated wait so the retry follows it instead of guessing.
  const retryAfter = response.headers.get('retry-after');

  if (retryAfter !== null) refusal.headers.set('retry-after', retryAfter);

  return refusal;
}

function upstreamError(body: string): { message: string; code?: number } | null {
  const decoded = tolerate<unknown>(() => JSON.parse(body), 'malformed-input');
  const parsed = v.safeParse(UpstreamErrorSchema, decoded);
  const head = body.trim();

  if (!parsed.success) return head === '' ? null : { message: head };
  const first = parsed.output.errors?.[0];
  const text = parsed.output.description ?? parsed.output.message ?? first?.message;

  if (text === undefined) return head === '' ? null : { message: head };
  const code = parsed.output.internalCode ?? first?.code;

  return code === undefined ? { message: text } : { message: `${String(code)}: ${text}`, code };
}

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}
