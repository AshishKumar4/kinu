/**
 * OpenAI-compatible fetch over Cloudflare's direct Workers AI binding.
 *
 * Development and staging have no user OAuth credential, so the binding is
 * their inference boundary. This adapter turns an AI SDK chat-completions
 * request into one `binding.run()` call and turns the answer back into the
 * OpenAI wire shape the SDK and the CLI proxy both parse.
 *
 * Three facts about `Ai.run` decide the whole design. All three are read from
 * the shipped implementation, workerd v1.20260820.1
 * `src/cloudflare/internal/ai-api.ts`:
 *
 *  1. `run` streams. With `inputs.stream = true` the upstream answers
 *     `text/event-stream` and `run` returns the untouched `res.body`, so bytes
 *     reach the caller as the model produces them. There is no reason to buffer
 *     a completion and replay it as one synthetic frame, which is what this
 *     adapter used to do.
 *  2. `options.returnRawResponse` is the only way to get the HTTP envelope.
 *     Without it `run` throws `InferenceUpstreamError` for any non-ok status and
 *     the status code is lost, and it decides JSON by comparing the content type
 *     for EQUALITY with `application/json`, so a `charset` parameter alone makes
 *     it hand back a raw body instead of a parsed object. The envelope carries
 *     the status and the content type, which is what a fetch seam needs.
 *  3. `run` stores its options on the BINDING (`this.#options = options`) and
 *     reads them again AFTER awaiting the upstream fetch, to choose between
 *     returning the `Response`, the parsed JSON and the raw body. One binding
 *     instance serves every concurrent turn, so a second call in flight can
 *     decide the first call's return shape. Per-call values that are read before
 *     that await, `extraHeaders` and `signal`, are safe.
 *
 * Fact 3 is why this adapter accepts every shape `run` can return rather than
 * the one it asked for. Trusting the requested shape is how a parallel turn
 * turns into an empty stream.
 *
 * When streaming was requested and the upstream answered one whole completion,
 * that model does not stream over this binding and the request is refused with
 * that reason. It is never buffered into a synthetic stream: a stream that only
 * arrives once the answer is finished is a lie about latency, and it hid this
 * defect for as long as it was the fallback.
 */
import {
  JsonObjectSchema,
  asFetchFunction,
  toolCallIdFor,
  type JsonObject,
} from '@kinu.run/core';
import { diagnostics, renderCauseChain, toKinuError, tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { errorResponse } from './cloudflare-ai-fetch';
import { createCachedUsageRepair } from './stream-usage-repair';

/** The route this adapter reads off a chat-completions request: the model the
 *  binding takes as its own argument, whether the caller asked to stream, and
 *  the transcript, typed here so {@link bindingInputs} can rewrite one spelling
 *  in it without re-establishing what a message is. Everything else travels
 *  through untouched. */
const ChatCompletionRequestSchema = v.looseObject({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
  stream: v.optional(v.boolean(), false),
  messages: v.optional(v.array(JsonObjectSchema)),
});

type ChatCompletionRequest = v.InferOutput<typeof ChatCompletionRequestSchema>;

/** A native text-generation payload: one whole answer when the request was not
 *  streamed, one delta when it was. `response` and `tool_calls` are nullable
 *  because a streamed delta that carries only usage sets neither. */
const NativeOutputSchema = v.looseObject({
  response: v.optional(v.nullable(v.string()), ''),
  tool_calls: v.optional(v.nullable(v.array(v.looseObject({
    id: v.optional(v.string()),
    name: v.string(),
    arguments: v.optional(v.union([v.string(), JsonObjectSchema]), ''),
  }))), []),
  usage: v.optional(JsonObjectSchema),
});

/** An OpenAI-shaped streamed chunk, as far as this adapter reads one: whether a
 *  finish reason has already gone out, whether the frame has a live choice at
 *  all, and the usage it reports. `choices` is REQUIRED — its presence is what
 *  tells the two dialects apart — and an empty one is a usage report rather
 *  than a delta. The payload itself is forwarded verbatim. */
const ChunkSchema = v.looseObject({
  choices: v.array(v.looseObject({
    finish_reason: v.optional(v.nullable(v.string())),
  })),
  usage: v.optional(JsonObjectSchema),
});

/** The Workers AI error envelope, in the two shapes `ai-api.ts` `_parseError`
 *  itself reads: `{internalCode, description}` and `{errors: [{code, message}]}`. */
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

/** The one binding method this adapter calls, typed by every shape workerd's
 *  `run` can hand back. The union is not caution: each arm is reachable, and
 *  which one arrives is decided by binding state a concurrent call also writes. */
interface DirectWorkersAIRunner {
  run(
    model: string,
    inputs: JsonObject,
    options?: DirectWorkersAIRunOptions,
  ): Promise<Response | ReadableStream<Uint8Array> | JsonObject>;
}

export function createDirectWorkersAIFetch(binding: Ai): typeof globalThis.fetch {
  // Assignable without an assertion: the binding really does own this method,
  // and every arm of the union is narrowed below before use.
  const runner: DirectWorkersAIRunner = binding;
  return asFetchFunction(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
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
      answer = await runner.run(route.model, bindingInputs(body, route), options);
    } catch (caught) {
      const failure = toKinuError({
        doing: `Workers AI binding inference for ${route.model}`,
        cause: caught,
        otherwise: 'io',
      });
      // A cancelled call is the caller's own decision, not a provider failure.
      // Reporting it as one would turn every aborted turn into an error frame.
      if (failure.code === 'cancelled') throw caught;
      diagnostics.failure('workers_ai.direct_call_failed', failure, { model: route.model });
      return errorResponse(502, renderCauseChain(failure));
    }
    return route.stream
      ? streamedResponse(answer, route.model, startedAt)
      : completedResponse(answer, route.model);
  });
}

/** The binding takes the model separately and the rest of the OpenAI body as
 *  its inputs.
 *
 *  The replayed transcript inside `messages` travels as it came, tool-call ids
 *  included. Their one requirement here is EQUALITY between an assistant
 *  message's `tool_calls[].id` and the `tool_call_id` of the `tool` message
 *  answering it, which is what the upstream pairs on, and forwarding preserves
 *  it exactly. Re-keying them could not: the call sits at a position inside its
 *  assistant message's array while its result is alone on a message of its own,
 *  so a position-derived key would differ between the two sites and split a
 *  pair that currently matches. Nothing between here and the wire re-encodes
 *  the string either — the body is serialized as JSON, which carries any id
 *  losslessly. Minting is where the id has to be made unique and portable
 *  ({@link toolCallIdFor}), and that happens on the way out.
 *
 *  One spelling is rewritten. The binding validates `messages[].content` as a
 *  string or an array of text parts — the "Messages" branch of every text
 *  model's input schema — and an OpenAI chat request writes `null` there for
 *  an assistant turn that only called tools: `@ai-sdk/openai-compatible` emits
 *  `content: text || null` beside `tool_calls`, and OpenAI's own endpoint
 *  accepts it. The binding refuses the whole request instead, AiError 5006
 *  "Type mismatch of '/messages/1/content', 'string' not in 'null'", the same
 *  on @cf/qwen/qwen3-30b-a3b-fp8 and @cf/openai/gpt-oss-20b (staging,
 *  2026-09-05), so every replay of a tool-calling turn over this binding was
 *  refused. `null` and `''` both say the turn carried no text; the empty string
 *  is that message in the spelling the schema admits, with its `tool_calls`
 *  and `reasoning_content` untouched. Text-part arrays are accepted as they
 *  are and stay as they are. */
function bindingInputs(body: JsonObject, route: ChatCompletionRequest): JsonObject {
  const inputs: JsonObject = { ...body, stream: route.stream };
  delete inputs.model;
  if (route.messages) inputs.messages = route.messages.map(withoutNullContent);
  // @ai-sdk/openai-compatible asks for stream usage only when its `includeUsage`
  // config is set, and workers-ai.ts does not set it. This adapter used to read
  // usage off a buffered completion, which always carries it; a real stream
  // carries it only when asked, so without this a streamed turn would report no
  // tokens at all. `stream_options.include_usage` is declared on the
  // chat-completions input the binding accepts (@cloudflare/workers-types
  // `ChatCompletionsStreamOptions`), and a caller that states its own keeps it.
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
  // A `Response` carries the whole completion. A raw body reaches here through
  // the content-type equality quirk of fact 2, never because anything streamed,
  // so reading it whole is what was asked for.
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
  // A parsed object is one whole completion for a request that asked to stream.
  return unstreamable(model, 'a JSON completion');
}

/** Forward the upstream event stream, translated into OpenAI chunks.
 *
 *  The first read is awaited here so the head of the stream can be checked
 *  before any byte is promised to the caller: an empty stream and a JSON body
 *  under an event-stream content type are both refusals, and refusing them
 *  before the response exists gives the caller a status code instead of a
 *  stream that dies. It is one read, so the rest still arrives incrementally. */
async function sseResponse(
  body: ReadableStream<Uint8Array>,
  model: string,
  startedAt: number,
): Promise<Response> {
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done) {
    await reader.cancel();
    return unstreamable(model, 'an empty stream');
  }
  const head = new TextDecoder().decode(first.value).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    await reader.cancel();
    return unstreamable(model, 'a JSON completion');
  }
  diagnostics.event('workers_ai.direct_stream_first_byte', {
    model,
    ms: Date.now() - startedAt,
    bytes: first.value.byteLength,
  });

  let pending: Uint8Array | undefined = first.value;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = undefined;
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    // A cancelled reader is what stops the upstream request, so an abandoned
    // turn stops costing neurons.
    cancel: () => reader.cancel(),
  });
  // One pass over the bytes. The translation below already splits every line
  // and parses every `data:` payload, so the cached-usage repair applies inside
  // it as a rule rather than as a second transform doing the same work again.
  return new Response(
    source.pipeThrough(openAIChunkTransform(model)),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/**
 * Byte to byte: upstream event-stream frames in, OpenAI `chat.completion.chunk`
 * frames out.
 *
 * Two upstream dialects reach here, the same two the non-streamed path already
 * handles. A payload with a live choice is already an OpenAI chunk and is
 * forwarded verbatim, so reasoning fields, annotations and incremental tool-call
 * deltas survive untouched. Everything else is translated: a native payload
 * carrying `response`, `tool_calls` and `usage`, and — from either dialect — a
 * usage report with no live choice, which the platform spells `choices: []` and
 * the native runtime spells with no `choices` at all. The two converge because
 * such a frame carries nothing but the report, so both are absorbed rather than
 * forwarded and the final usage leaves with the finish state, once.
 *
 * Framing is rebuilt rather than forwarded. Only `data:` lines carry anything
 * this transport needs, so comments and keep-alives are dropped and every
 * emitted frame is one `data:` line and a blank line.
 */
function openAIChunkTransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  /** Minted once per RESPONSE — every frame carries it — so it is also the
   *  scope that keeps a tool-call id unique across the responses of one turn. */
  const toolCallScope = `call-${id}`;
  const created = Math.floor(Date.now() / 1000);
  const repairCachedUsage = createCachedUsageRepair();
  let buffer = '';
  /** An assistant delta has gone out, so `role` has been announced. */
  let opened = false;
  /** Tool calls seen, which is the next delta's `index` and the finish reason. */
  let toolCalls = 0;
  /** A finish reason has gone out, upstream's or ours. */
  let finished = false;
  /** `data: [DONE]` has gone out. */
  let closed = false;
  /** The stream has been errored, so nothing more may be enqueued on it. */
  let failed = false;
  /** The response's latest usage report, repaired, until a frame carries it to
   *  the caller. A frame that reports usage itself clears it, so one report
   *  never leaves twice and a later report supersedes an earlier one. */
  let owedUsage: JsonObject | undefined;

  const frame = (choices: JsonObject[], usage?: JsonObject): Uint8Array => {
    const chunk: JsonObject = { id, object: 'chat.completion.chunk', created, model, choices };
    if (usage) chunk.usage = usage;
    return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const finalize = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (closed) return;
    // The final state leaves in exactly ONE frame. A finish reason that has not
    // gone out yet takes the usage with it. When the upstream already announced
    // one, the usage travels on a chunk with no choice, which is the OpenAI wire
    // shape for a usage report: `choices[0]` is what carries a finish state, so
    // this adds no second one, and `usage` is read off any chunk.
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

  /** The frames this adapter translates rather than forwards: a native delta,
   *  and a usage report with no live choice in either dialect. */
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
    // A `data:` line that is not a JSON object cannot be forwarded as a chunk
    // and cannot be dropped without losing whatever it said, so it ends the
    // stream loudly.
    const decoded = tolerate<unknown>(() => JSON.parse(payload), 'malformed-input');
    const object = v.safeParse(JsonObjectSchema, decoded);
    if (!object.success) {
      failed = true;
      controller.error(new Error(`Workers AI ${model} streamed a data frame that is not a JSON object`));
      return;
    }
    // Either the frame is not OpenAI-shaped, or it has no live choice — and a
    // frame with no live choice is a usage report and nothing else, whichever
    // dialect spelled it. One path for both: forwarding one would end the
    // response a second time, and the AI SDK's own chunk schema requires
    // `choices`, so the dialect that omits it cannot be forwarded at all.
    const chunk = v.safeParse(ChunkSchema, object.output);
    if (!chunk.success || chunk.output.choices.length === 0) {
      translate(object.output, controller);
      return;
    }
    if (chunk.output.choices.some((choice) => (choice.finish_reason ?? null) !== null)) {
      finished = true;
    }
    const usage = chunk.output.usage;
    // This frame reports its own usage, so nothing is owed after it. Its bytes
    // are rebuilt only when the cache repair has a maximum to restore.
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

/** Both dialects of a whole answer, as one OpenAI completion. An answer that is
 *  already OpenAI-shaped is passed through. */
function openAICompletion(raw: JsonObject, requestedModel: string): Response {
  if (Array.isArray(raw.choices)) return jsonResponse(raw);

  const output = v.parse(NativeOutputSchema, raw);
  // Minted once per RESPONSE and used twice: as the completion's own id, and as
  // the response-unique scope of every tool-call id below.
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

/** A native tool call's arguments, as the OpenAI wire spells them: the native
 *  field is either an already-serialized string or a JSON object, and the two
 *  sites that emit a tool call have to agree on the encoding. One encoding one
 *  way and one the other is a tool call the model cannot parse. */
function toolArguments(value: string | JsonObject): string {
  return v.is(v.string(), value) ? value : JSON.stringify(value);
}

/** Streaming was requested and the upstream answered something else. */
function unstreamable(model: string, saw: string): Response {
  diagnostics.event('workers_ai.direct_stream_unsupported', { model, saw });
  return errorResponse(502, `Workers AI model ${model} did not stream over the direct binding: `
    + `the upstream answered ${saw}. A streamed request is refused rather than served from a `
    + 'buffered completion.');
}

/** An upstream failure, with its status kept and its own message extracted. The
 *  raw Cloudflare envelope is never forwarded. */
async function upstreamRefusal(response: Response, model: string): Promise<Response> {
  const body = await response.text();
  diagnostics.event('workers_ai.direct_call_refused', { model, status: response.status });
  return errorResponse(
    response.status,
    upstreamMessage(body) ?? `Workers AI refused ${model} with HTTP ${String(response.status)}.`,
  );
}

function upstreamMessage(body: string): string | null {
  const decoded = tolerate<unknown>(() => JSON.parse(body), 'malformed-input');
  const parsed = v.safeParse(UpstreamErrorSchema, decoded);
  const head = body.trim();
  if (!parsed.success) return head === '' ? null : head;
  const first = parsed.output.errors?.[0];
  const text = parsed.output.description ?? parsed.output.message ?? first?.message;
  if (text === undefined) return head === '' ? null : head;
  const code = parsed.output.internalCode ?? first?.code;
  return code === undefined ? text : `${String(code)}: ${text}`;
}

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}
