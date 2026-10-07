/**
 * `@cf/` chat for the CLI relay on the deployment's binding, OpenAI chat-completions in and out. The binding takes the
 * request body as its inputs, and a chat-completions model answers in OpenAI chunks, which pass through; a model with
 * its own schema answers `{ response, tool_calls, usage }`, put into the same shape here. Retry, usage repair and
 * tool-call scoping belong to the caller's model stack.
 */
import { errorResponse, JsonObjectSchema, SESSION_AFFINITY_HEADER, sessionAffinityOf, toolCallIdFor } from '@kinu.run/core';
import type { JsonObject, WorkersAIRunBinding, WorkersAIRunOptions } from '@kinu.run/core';
import { toKinuError, tolerate } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import * as v from 'valibot';

const ChunkSchema = v.looseObject({ choices: v.array(v.looseObject({ finish_reason: v.optional(v.nullable(v.string())) })) });

const NativeOutputSchema = v.looseObject({
  response: v.optional(v.nullable(v.string())),
  tool_calls: v.optional(v.nullable(v.array(v.looseObject({
    id: v.optional(v.string()),
    name: v.string(),
    arguments: v.optional(v.union([v.string(), JsonObjectSchema]), ''),
  })))),
  usage: v.optional(JsonObjectSchema),
});

type NativeOutput = v.InferOutput<typeof NativeOutputSchema>;

const DONE = /^data:\s*\[DONE\]\s*$/u;

/** The two refusal envelopes `Ai.run` itself reads (workerd `ai-api.ts` `_parseError`). */
const RefusalSchema = v.looseObject({
  internalCode: v.optional(v.number()),
  description: v.optional(v.string()),
  errors: v.optional(v.array(v.looseObject({ code: v.optional(v.number()), message: v.optional(v.string()) }))),
});

export interface BindingCompletionRequest {
  readonly model: string;
  readonly body: JsonObject;
  readonly request: Request;
}

/** The raw answer keeps the refusal's status and Retry-After for the caller's retry; a cancelled call is the caller's. */
export function bindingCompletion(binding: WorkersAIRunBinding, { model, body, request }: BindingCompletionRequest): Effect.Effect<Response> {
  const affinity = sessionAffinityOf(request.headers);

  const options: WorkersAIRunOptions = {
    returnRawResponse: true,
    signal: request.signal,
    ...(affinity !== undefined && { extraHeaders: { [SESSION_AFFINITY_HEADER]: affinity } }),
  };

  const stream = body.stream === true;

  return Effect.tryPromise({ try: () => binding.run(model, bindingInputs(body, stream), options), catch: (cause) => cause }).pipe(
    Effect.matchEffect({
      onSuccess: (answer) => Effect.promise(() => relayed(answer, model, stream)),
      onFailure: (cause) => {
        const failure = toKinuError({ doing: `Workers AI binding inference for ${model}`, cause, otherwise: 'io' });

        return failure.code === 'cancelled' ? Effect.die(cause) : Effect.succeed(errorResponse(502, failure.message));
      },
    }),
  );
}

/** The binding refuses null `content`, which the SDK sends beside tool calls; it reports stream usage only when asked. */
function bindingInputs(body: JsonObject, stream: boolean): JsonObject {
  const { model: _model, ...inputs } = body;
  const messages = v.safeParse(v.array(JsonObjectSchema), body.messages);

  if (messages.success) inputs.messages = messages.output.map((message) => (message.content === null ? { ...message, content: '' } : message));

  if (stream && inputs.stream_options === undefined) inputs.stream_options = { include_usage: true };

  return inputs;
}

/** `Ai.run` rereads its options from the shared binding after awaiting, so a concurrent call can pick the shape. */
async function relayed(answer: Response | ReadableStream<Uint8Array> | JsonObject, model: string, stream: boolean): Promise<Response> {
  if (answer instanceof Response && !answer.ok) return refusal(answer);
  const body = answer instanceof Response ? answer.body : answer;
  const json = answer instanceof Response && (answer.headers.get('content-type') ?? '').includes('json');

  if (body instanceof ReadableStream && !json && stream) {
    return new Response(body.pipeThrough(openAIEvents(model)), { headers: { 'content-type': 'text/event-stream' } });
  }

  if (stream) return errorResponse(502, `Workers AI model ${model} did not stream: it answered a whole completion.`);

  return completion(body instanceof ReadableStream ? v.parse(JsonObjectSchema, await new Response(body).json()) : body ?? {}, model);
}

async function refusal(answer: Response): Promise<Response> {
  const text = await answer.text();
  const parsed = v.safeParse(RefusalSchema, tolerate<unknown>(() => JSON.parse(text), 'malformed-input'));
  const first = parsed.success ? parsed.output.errors?.[0] : undefined;
  const code = parsed.success ? parsed.output.internalCode ?? first?.code : undefined;
  const said = parsed.success ? parsed.output.description ?? first?.message : undefined;
  const head = text.trim();
  const message = said ?? (head === '' ? `Workers AI answered HTTP ${String(answer.status)}.` : head);

  return errorResponse(answer.status, code === undefined ? message : `${String(code)}: ${message}`, code, answer.headers);
}

function completion(raw: JsonObject, model: string): Response {
  const output = v.safeParse(NativeOutputSchema, raw);

  if (v.is(ChunkSchema, raw) || !output.success || !isNative(output.output)) return Response.json(raw);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const calls = toolCalls(output.output, `call-${id}`, 0);
  const message: JsonObject = { role: 'assistant', content: output.output.response ?? '' };

  if (calls.length > 0) message.tool_calls = calls;

  return Response.json({
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
    ...(output.output.usage !== undefined && { usage: output.output.usage }),
  });
}

function isNative(output: NativeOutput): boolean {
  return output.response !== undefined || output.tool_calls !== undefined || output.usage !== undefined;
}

function toolCalls(output: NativeOutput, scope: string, offset: number): JsonObject[] {
  return (output.tool_calls ?? []).map((call, at) => ({
    index: offset + at,
    id: toolCallIdFor({ scope, native: call.id, index: offset + at }),
    type: 'function',
    function: { name: call.name, arguments: v.is(v.string(), call.arguments) ? call.arguments : JSON.stringify(call.arguments) },
  }));
}

/** Line by line: OpenAI chunks, comments and separators pass verbatim; a native frame becomes chunks; `[DONE]` ends the
 *  stream, because the binding may hold its body open behind it. */
function openAIEvents(model: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  // Native content was translated, and no finish has reached the caller: the one finish is ours to send.
  let native = false;
  let finished = false;
  let calls = 0;

  const chunk = (choices: JsonObject[], usage?: JsonObject): string =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...(usage !== undefined && { usage }) })}\n\n`;

  const finish = (): string => (native && !finished ? chunk([{ index: 0, delta: {}, finish_reason: calls > 0 ? 'tool_calls' : 'stop' }]) : '');

  const translated = (line: string): string | null => {
    const data = line.startsWith('data:') ? tolerate<unknown>(() => JSON.parse(line.slice('data:'.length)), 'malformed-input') : undefined;
    const openAI = v.safeParse(ChunkSchema, data);

    if (openAI.success) {
      finished ||= openAI.output.choices.some((choice) => choice.finish_reason != null);

      return null;
    }

    const output = v.safeParse(NativeOutputSchema, data);

    if (!output.success || !isNative(output.output)) return null;
    const text = output.output.response ?? '';
    const deltas = toolCalls(output.output, `call-${id}`, calls);

    // A usage-only frame reports; it does not end, or begin, a native answer.
    native ||= text !== '' || deltas.length > 0;
    calls += deltas.length;

    return [
      text === '' ? '' : chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
      deltas.length === 0 ? '' : chunk([{ index: 0, delta: { tool_calls: deltas }, finish_reason: null }]),
      output.output.usage === undefined ? '' : chunk([], output.output.usage),
    ].join('');
  };

  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (DONE.test(line)) {
          controller.enqueue(encoder.encode(`${finish()}data: [DONE]\n\n`));
          controller.terminate();

          return;
        }

        controller.enqueue(encoder.encode(translated(line.trimEnd()) ?? `${line}\n`));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      controller.enqueue(encoder.encode(`${translated(buffer.trimEnd()) ?? buffer}${finish()}`));
    },
  });
}
