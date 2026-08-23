import {
  JsonObjectSchema,
  asFetchFunction,
  type JsonObject,
} from '@kinu.run/core';
import * as v from 'valibot';

const ChatCompletionRequestSchema = v.looseObject({
  model: v.pipe(v.string(), v.trim(), v.minLength(1)),
  stream: v.optional(v.boolean(), false),
});
const NativeOutputSchema = v.looseObject({
  response: v.optional(v.string(), ''),
  tool_calls: v.optional(v.array(v.looseObject({
    id: v.optional(v.string()),
    name: v.string(),
    arguments: v.optional(v.union([v.string(), JsonObjectSchema]), ''),
  })), []),
  usage: v.optional(JsonObjectSchema),
});
const CompletionChoiceSchema = v.object({
  index: v.optional(v.number(), 0),
  message: JsonObjectSchema,
  finish_reason: v.optional(v.nullable(v.string()), 'stop'),
});
const CompletionSchema = v.looseObject({
  id: v.optional(v.string()),
  created: v.optional(v.number()),
  model: v.optional(v.string()),
  choices: v.pipe(v.array(CompletionChoiceSchema), v.minLength(1)),
  usage: v.optional(JsonObjectSchema),
});

interface DirectWorkersAIRunOptions {
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
}

interface DirectWorkersAIRunner {
  run(
    model: string,
    inputs: JsonObject,
    options?: DirectWorkersAIRunOptions,
  ): Promise<JsonObject>;
}

/**
 * OpenAI-compatible fetch over Cloudflare's direct Workers AI binding.
 *
 * Development and staging have no user OAuth credential. The binding is their
 * inference boundary. Calls run non-streaming at that boundary, then this
 * adapter emits a complete OpenAI SSE response when the caller requested a
 * stream. This avoids the direct binding's empty-stream failure under parallel
 * agent turns while preserving tool calls, reasoning fields, finish reason,
 * and usage.
 */
export function createDirectWorkersAIFetch(binding: Ai): typeof globalThis.fetch {
  // SAFETY: Cloudflare's `Ai` binding owns `run(model, JSON, options)`. This
  // view removes methods the adapter cannot call and names the JSON result of a
  // non-streaming text-generation request.
  const runner = binding as DirectWorkersAIRunner;
  return asFetchFunction(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = v.parse(JsonObjectSchema, JSON.parse(await request.text()));
    const route = v.parse(ChatCompletionRequestSchema, body);
    const inputs: JsonObject = { ...body, stream: false };
    delete inputs.model;
    const affinity = request.headers.get('x-session-affinity');
    const options: DirectWorkersAIRunOptions = { signal: request.signal };
    if (affinity) options.extraHeaders = { 'x-session-affinity': affinity };
    const raw = v.parse(JsonObjectSchema, await runner.run(route.model, inputs, options));
    return openAIResponse(raw, route.model, route.stream);
  });
}

function openAIResponse(raw: JsonObject, requestedModel: string, stream: boolean): Response {
  if (Array.isArray(raw.choices)) {
    return stream ? streamCompletion(raw, requestedModel) : jsonResponse(raw);
  }

  const output = v.parse(NativeOutputSchema, raw);
  const toolCalls = output.tool_calls.map((call, index) => ({
    id: call.id ?? `call-${String(index + 1)}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: v.is(v.string(), call.arguments)
        ? call.arguments
        : JSON.stringify(call.arguments),
    },
  }));
  const message: JsonObject = { role: 'assistant', content: output.response };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const completion: JsonObject = {
    id: `chatcmpl-${crypto.randomUUID()}`,
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
  return stream ? streamCompletion(completion, requestedModel) : jsonResponse(completion);
}

function streamCompletion(raw: JsonObject, requestedModel: string): Response {
  const completion = v.parse(CompletionSchema, raw);
  const choice = completion.choices[0];
  const id = completion.id ?? `chatcmpl-${crypto.randomUUID()}`;
  const created = completion.created ?? Math.floor(Date.now() / 1000);
  const model = completion.model ?? requestedModel;
  const start: JsonObject = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: choice.index,
      delta: choice.message,
      finish_reason: null,
    }],
  };
  const finish: JsonObject = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: choice.index,
      delta: {},
      finish_reason: choice.finish_reason,
    }],
  };
  if (completion.usage) finish.usage = completion.usage;
  return new Response(
    `data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}
