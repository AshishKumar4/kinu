// Fixtures for the platform AI Gateway provider: usable only with a parseable gateway URL and a bound `env.AI`.
import type {
  LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3FunctionTool, LanguageModelV3Message, LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';
import { JsonObjectSchema, JsonValueSchema, type GatewayRunRequest, type JsonObject, type ProviderEnv, type WorkersAIBinding } from '@kinu.run/core';
import * as v from 'valibot';

/** Shape `AI_GATEWAY_URL` must have: {origin}/v1/{account}/{gateway}/{provider}/... */
export const TEST_GATEWAY_URL =
  'https://gateway.ai.cloudflare.com/v1/testaccount0000000000000000000/test-gateway/workers-ai/v1';

export interface RecordedGatewayRun extends GatewayRunRequest {
  gateway: string;
  signal: AbortSignal | undefined;
}

export interface StubbedAiBinding {
  binding: WorkersAIBinding;
  runs: RecordedGatewayRun[];
}

/** Only `gateway().run()` exists, so a suite reaching for another binding method fails loudly. */
export function stubAiBinding(
  respond: (run: RecordedGatewayRun) => Response | Promise<Response> = () => Response.json({ ok: true }),
): StubbedAiBinding {
  const runs: RecordedGatewayRun[] = [];

  return {
    runs,
    binding: {
      gateway(gateway: string) {
        return {
          run(data: GatewayRunRequest, options?: { signal?: AbortSignal }): Promise<Response> {
            const recorded: RecordedGatewayRun = { gateway, ...data, signal: options?.signal };
            runs.push(recorded);

            return Promise.resolve(respond(recorded));
          },
        };
      },
    },
  };
}

/** URL and binding are both required for the provider to be available. */
export function platformGatewayEnv(stub: StubbedAiBinding = stubAiBinding()): Partial<ProviderEnv> {
  return { AI_GATEWAY_URL: TEST_GATEWAY_URL, AI: stub.binding };
}

const StreamedQuerySchema = v.looseObject({ stream: v.optional(v.boolean()) });

/** A tool call as the gateway's answer carries it: the id its result will name, the tool, its JSON arguments. */
interface WireToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * The OpenAI-compatible answer the gateway returns: one chat completion, or the SSE stream a streaming
 * request asks for. The platform shape, so everything above the binding is production's.
 */
function assistantCompletion(run: RecordedGatewayRun, text: string | null, calls: readonly WireToolCall[]): Response {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const head = { id: 'chatcmpl-harness', created: 0, model: 'harness' };
  const finish = calls.length > 0 ? 'tool_calls' : 'stop';
  const toolCalls = calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));

  if (v.parse(StreamedQuerySchema, run.query).stream !== true) {
    const message = { role: 'assistant', content: text, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) };

    return Response.json({ ...head, object: 'chat.completion', usage, choices: [{ index: 0, message, finish_reason: finish }] });
  }

  const delta = {
    role: 'assistant',
    ...(text !== null && { content: text }),
    ...(toolCalls.length > 0 && { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }),
  };

  const chunks = [
    { ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
  ];

  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** The gateway's answer for `text`. */
export function chatCompletion(run: RecordedGatewayRun, text: string): Response {
  return assistantCompletion(run, text, []);
}

/** A tool call the model makes, as the gateway returns it. */
export interface GatewayToolCall {
  readonly tool: string;
  readonly args: JsonObject;
}

/** The gateway's answer that calls one tool; `id` is the call id the tool result will name. */
export function toolCallCompletion(run: RecordedGatewayRun, call: GatewayToolCall, id: string): Response {
  return assistantCompletion(run, null, [{ id, name: call.tool, arguments: JSON.stringify(call.args) }]);
}

const WireCallSchema = v.object({ id: v.string(), function: v.object({ name: v.string(), arguments: v.string() }) });

const WireTextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

/** One chat message as the provider sends it to the gateway. */
const WireMessageSchema = v.variant('role', [
  v.object({ role: v.literal('system'), content: v.string() }),
  v.object({ role: v.literal('user'), content: v.union([v.string(), v.array(WireTextPartSchema)]) }),
  v.object({ role: v.literal('assistant'), content: v.nullish(v.string()), tool_calls: v.optional(v.array(WireCallSchema)) }),
  v.object({ role: v.literal('tool'), tool_call_id: v.string(), content: v.string() }),
]);

const WireRequestSchema = v.object({
  messages: v.array(WireMessageSchema),
  tools: v.optional(v.array(v.object({
    function: v.object({ name: v.string(), description: v.optional(v.string()), parameters: v.optional(JsonObjectSchema) }),
  }))),
});

const JsonTextSchema = v.pipe(v.string(), v.parseJson(), JsonValueSchema);

/** A tool result as the model reads it: the JSON a tool answered, else its text. */
function toolOutput(content: string): LanguageModelV3ToolResultOutput {
  const parsed = v.safeParse(JsonTextSchema, content);

  return parsed.success ? { type: 'json', value: parsed.output } : { type: 'text', value: content };
}

/** One gateway request as the AI SDK hands it to a model: its prompt and the tools it offers. */
function callOptionsOf(run: RecordedGatewayRun): LanguageModelV3CallOptions {
  const request = v.parse(WireRequestSchema, run.query);

  const toolNames = new Map(request.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.tool_calls ?? []).map((call) => [call.id, call.function.name] as const) : []));

  const prompt = request.messages.map((message): LanguageModelV3Message => {
    switch (message.role) {
      case 'system': return message;
      case 'user': return { role: 'user', content: v.is(v.string(), message.content) ? [{ type: 'text', text: message.content }] : message.content };
      case 'assistant': return { role: 'assistant', content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({
          type: 'tool-call' as const, toolCallId: call.id, toolName: call.function.name, input: v.parse(JsonTextSchema, call.function.arguments),
        })),
      ] };
      case 'tool': return { role: 'tool', content: [{
        type: 'tool-result', toolCallId: message.tool_call_id, toolName: toolNames.get(message.tool_call_id) ?? '', output: toolOutput(message.content),
      }] };
    }
  });

  const tools = (request.tools ?? []).map((tool): LanguageModelV3FunctionTool => ({
    type: 'function', name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters ?? {},
  }));

  return { prompt, tools };
}

/**
 * A gateway whose model is `model`, a scripted AI SDK model: each request reaches it in the SDK's own
 * shape, and its text and tool calls go back as the gateway's answer.
 */
export function modelGateway(model: Pick<LanguageModelV3, 'doGenerate'>): StubbedAiBinding {
  return stubAiBinding(async (run) => {
    const { content } = await model.doGenerate(callOptionsOf(run));
    const text = content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
    const calls = content.flatMap((part) => part.type === 'tool-call' ? [{ id: part.toolCallId, name: part.toolName, arguments: part.input }] : []);

    return assistantCompletion(run, calls.length > 0 && text === '' ? null : text, calls);
  });
}

const ChatMessageSchema = v.looseObject({ role: v.string(), content: v.optional(v.unknown()) });

const OfferedToolSchema = v.looseObject({
  function: v.looseObject({ name: v.string(), description: v.optional(v.string()), parameters: v.optional(v.unknown()) }),
});

const ChatRequestSchema = v.looseObject({
  messages: v.optional(v.array(ChatMessageSchema)),
  tools: v.optional(v.array(OfferedToolSchema)),
});

/** A tool as a request offered it to the model: its description and its input schema. */
export interface OfferedTool {
  readonly description: string | undefined;
  readonly inputSchema: unknown;
}

/** Every tool the recorded requests offered the model, by name. */
export function offeredTools(runs: readonly RecordedGatewayRun[]): Map<string, OfferedTool> {
  return new Map(runs.flatMap((run) => v.parse(ChatRequestSchema, run.query).tools ?? []).map((tool) => [
    tool.function.name, { description: tool.function.description, inputSchema: tool.function.parameters },
  ]));
}

/** What one gateway request asked the model: its messages and the names of the tools it offered. */
export interface GatewayRequest {
  readonly messages: readonly v.InferOutput<typeof ChatMessageSchema>[];
  readonly tools: readonly string[];
}

export function requestOf(run: RecordedGatewayRun): GatewayRequest {
  const request = v.parse(ChatRequestSchema, run.query);

  return { messages: request.messages ?? [], tools: (request.tools ?? []).map((tool) => tool.function.name) };
}

/**
 * A gateway whose model makes `calls` in order, one per request, then answers `text`. The step is read
 * off the request's tool results, so a retried request answers the same way.
 */
export function scriptedGateway(calls: readonly GatewayToolCall[], text = 'done'): StubbedAiBinding {
  return stubAiBinding((run) => {
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;
    const call = calls[step];

    return call === undefined ? chatCompletion(run, text) : toolCallCompletion(run, call, `call_${String(step)}`);
  });
}

/** A gateway every call of which the model answers with `text`. */
export function answeringGateway(text: string): StubbedAiBinding {
  return stubAiBinding((run) => chatCompletion(run, text));
}

/** A model spec the platform gateway serves: every lane routed to it reaches the stub binding. */
export const GATEWAY_MODEL = 'ai-gateway/workers-ai/@cf/harness/model';
