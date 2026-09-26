/**
 * A scripted model's wire protocol: an OpenAI-compatible chat request read the way a script reads it, and a script's
 * answer written back the way a provider sends one. It imports nothing node-only, so the local runs' server
 * (`scripted-model.ts`) and the deployed tiers' Worker (`scripted-model-worker.ts`) answer from the same code.
 *
 * The streamed shapes are the ones `@ai-sdk/openai-compatible` parses:
 * a `delta.content` chunk finished with `stop`, or a `delta.tool_calls` chunk
 * carrying the complete argument JSON, finished with `tool_calls` (the parser
 * emits the tool call as soon as the arguments parse — see
 * openai-compatible-chat-language-model.ts:605, `isParsableJson`). A request
 * that asks for no stream, as a workspace's titling does, gets one completion.
 */
import * as v from 'valibot';
import { DYNAMIC_CONTEXT_OPEN_TAG, SYSTEM_REMINDER_TAG, WORKSPACE_INSTRUCTIONS_TAG } from '../packages/core/src/utils/prompt-sections';
import { SCRIPTED_MODEL_ID } from '../packages/test-utils/src/scripted-model-spec';

/** What an unscripted request gets. One string, so a row that waits for the
 *  answer waits for the words this server actually sends. */
export const FALLBACK_ANSWER = 'Live answer from the fake model.';

/** A paced answer's silences, in the order a thinking model leaves them: before its first token, and after
 *  `lead`, a first token that opens the answer's text with nothing to draw, as a blank lead line does. */
export interface ScriptedPace {
  readonly firstTokenMs: number;
  readonly lead: string;
  readonly leadMs: number;
  /** A first silence of unknown length, ended by the row that holds it ({@link heldCall}). */
  readonly hold?: Promise<void>;
  /** A silence after the lead, ended the same way: the text stops mid-way until the row lets it finish. */
  readonly rest?: Promise<void>;
}

/** One answer: prose, or a tool call with its complete arguments. Unpaced, it is written in one piece. */
export interface ScriptedAnswer {
  readonly text?: string;
  readonly toolCall?: { readonly name: string; readonly arguments: unknown };
  readonly pace?: ScriptedPace;
}

/** One tool call the conversation holds: its name, its arguments as the wire carried them, and its result's
 *  text ('' while none is in the request). */
export interface ScriptedCall {
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
}

/** The request as a script reads it. `available` is what this turn may call —
 *  a titling call carries no tools at all, and a script that ignored that
 *  would answer it with a tool call the request never offered. */
export interface ScriptedRequest {
  /** What was said to the agent, oldest first: every user-role message's text but the runtime state the
   *  product sends in that role (a `<dynamic_context>` block, the unapproved workspace files, a stop reminder),
   *  so the last entry is the latest ask. */
  readonly userTexts: readonly string[];
  /** What the agent said, oldest first: every assistant-role message's text. */
  readonly assistantTexts: readonly string[];
  /** The system messages' text: where a workspace's mission reaches its model. */
  readonly system: string;
  /** Tool names already called in this conversation, in order. */
  readonly called: readonly string[];
  /** The same calls, each with its arguments and result, so a script answers from what the product returned. */
  readonly calls: readonly ScriptedCall[];
  /** The calls made since the latest ask: the work its turn has done so far. */
  readonly turn: readonly ScriptedCall[];
  readonly available: readonly string[];
  /** Whether the call asked for a stream; a workspace's titling asks for one completion. */
  readonly streamed: boolean;
}

export type ScriptedModel = (request: ScriptedRequest) => ScriptedAnswer;

const TextPartSchema = v.object({ type: v.optional(v.string()), text: v.optional(v.string()) });

/** A message's text, whatever shape the provider serialized it in: a plain
 *  string, or the parts array the SDK sends for a multi-part message. */
const ContentSchema = v.pipe(
  v.union([v.string(), v.array(TextPartSchema), v.null()]),
  v.transform((content) => (
    Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content ?? ''
  )),
);

const OutboundMessageSchema = v.object({
  role: v.optional(v.string()),
  content: v.optional(ContentSchema),
  tool_call_id: v.optional(v.string()),
  tool_calls: v.optional(v.array(v.object({
    id: v.optional(v.string()),
    function: v.optional(v.object({ name: v.optional(v.string()), arguments: v.optional(v.string()) })),
  }))),
});

const OutboundBodySchema = v.object({
  messages: v.optional(v.array(OutboundMessageSchema)),
  tools: v.optional(v.array(v.object({
    function: v.optional(v.object({ name: v.optional(v.string()) })),
  }))),
  stream: v.optional(v.boolean()),
});

/** A user-role message the product wrote: its live state, the unapproved workspace files
 *  (`prompting/volatile-context.ts`), or a reminder at a turn's stop (`tasks/reminder.ts`). */
function isRuntimeState(text: string): boolean {
  return text.startsWith(DYNAMIC_CONTEXT_OPEN_TAG) || [WORKSPACE_INSTRUCTIONS_TAG, SYSTEM_REMINDER_TAG].some((tag) => text.startsWith(`<${tag}>`));
}

type OutboundMessage = v.InferOutput<typeof OutboundMessageSchema>;

/** Whether a message is an ask: a user-role message that is not runtime state. */
function isAsk(message: OutboundMessage): boolean {
  return message.role === 'user' && !isRuntimeState(message.content ?? '');
}

/** Every tool call, each matched to its result by id, and where the latest ask sits among them. */
function callsOf(messages: readonly OutboundMessage[]) {
  const results = new Map<string, string>(messages.flatMap((message) => (
    message.role === 'tool' && message.tool_call_id !== undefined ? [[message.tool_call_id, message.content ?? '']] : []
  )));

  const calls: ScriptedCall[] = [];
  let latestAsk = 0;

  for (const message of messages) {
    if (isAsk(message)) latestAsk = calls.length;

    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      const result = call.id === undefined ? '' : results.get(call.id) ?? '';

      if (name !== undefined) calls.push({ name, arguments: call.function?.arguments ?? '', result });
    }
  }

  return { calls, latestAsk };
}

/** The request body as a script reads it. */
export function readScriptedRequest(body: string): ScriptedRequest {
  const parsed = v.parse(v.pipe(v.string(), v.parseJson(), OutboundBodySchema), body);
  const messages = parsed.messages ?? [];
  const { calls, latestAsk } = callsOf(messages);

  return {
    userTexts: messages.flatMap((message) => isAsk(message) ? [message.content ?? ''] : []),
    assistantTexts: messages.flatMap((message) => message.role === 'assistant' && message.content ? [message.content] : []),
    system: messages.flatMap((message) => message.role === 'system' ? [message.content ?? ''] : []).join('\n'),
    called: calls.map((call) => call.name),
    calls,
    turn: calls.slice(latestAsk),
    available: (parsed.tools ?? []).flatMap((tool) => tool.function?.name === undefined ? [] : [tool.function.name]),
    streamed: parsed.stream === true,
  };
}

const CHUNK = { id: 'chatcmpl-scripted', object: 'chat.completion.chunk', created: 1, model: SCRIPTED_MODEL_ID };

/** The `/models` answer: the one model this endpoint serves. */
export const SCRIPTED_MODELS_BODY = JSON.stringify({ object: 'list', data: [{ id: SCRIPTED_MODEL_ID, name: 'Fake Live' }] });

/** One streamed frame carrying `delta` alone: what a paced answer writes before its silences. */
function streamFrame(delta: Readonly<Record<string, string>>): string {
  return `data: ${JSON.stringify({ ...CHUNK, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

/** The answer's tool call as the wire carries it, with its own id per `step`: the calls the request already holds, so
 *  each call a turn makes has its own id, as a provider gives it. */
function wireCall(call: NonNullable<ScriptedAnswer['toolCall']>, step: number) {
  return { id: `call-${call.name}-${String(step)}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
}

/** The scripted model's own token count, one per whitespace-separated word. */
function wordsIn(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + text.split(/\s+/).filter(Boolean).length, 0);
}

/** What the call read and wrote, reported as a provider reports its usage, so a tier's spend ledger shows the model
 *  was reached and what passed through it. */
function usageOf(answer: ScriptedAnswer, request: ScriptedRequest) {
  const read = wordsIn([request.system, ...request.userTexts, ...request.assistantTexts, ...request.calls.flatMap((made) => [made.arguments, made.result])]);
  const wrote = wordsIn([answer.text ?? '', answer.toolCall === undefined ? '' : JSON.stringify(answer.toolCall.arguments)]);

  return { prompt_tokens: read, completion_tokens: wrote, total_tokens: read + wrote };
}

/** The answer to a request that asked for no stream, as one completion: a workspace's title is asked this way. */
function completionOf(answer: ScriptedAnswer, request: ScriptedRequest): string {
  const call = answer.toolCall;
  const content = answer.text ?? null;

  const message = call === undefined
    ? { role: 'assistant', content }
    : { role: 'assistant', content, tool_calls: [wireCall(call, request.calls.length)] };

  return JSON.stringify({
    ...CHUNK,
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: call === undefined ? 'stop' : 'tool_calls' }],
    usage: usageOf(answer, request),
  });
}

/** The answer as a stream, its usage on the finishing chunk. */
export function streamOf(answer: ScriptedAnswer, request: ScriptedRequest): string {
  const events: unknown[] = [];
  const call = answer.toolCall;
  const step = request.calls.length;

  if (answer.text !== undefined) {
    events.push({ ...CHUNK, choices: [{ index: 0, delta: { role: 'assistant', content: answer.text }, finish_reason: null }] });
  }

  if (call !== undefined) {
    events.push({
      ...CHUNK,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, ...wireCall(call, step) }],
        },
        finish_reason: null,
      }],
    });
  }

  events.push({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: usageOf(answer, request) });

  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

/**
 * A paced answer the way a slow provider streams one: the role chunk at once, then each silence as a real wait, then
 * the answer. A hold or a rest the row ends is awaited where its silence falls, and a hold that fails is thrown, as a
 * provider that drops the socket cuts the call. `wait` is the host's own sleep.
 */
export async function* pacedStream(
  answer: ScriptedAnswer, pace: ScriptedPace, request: ScriptedRequest, wait: (ms: number) => Promise<void>,
): AsyncGenerator<string> {
  yield streamFrame({ role: 'assistant' });
  await pace.hold;
  await wait(pace.firstTokenMs);
  yield streamFrame({ content: pace.lead });
  await pace.rest;
  await wait(pace.leadMs);
  yield streamOf(answer, request);
}

/** The HTTP answer to one chat call, unpaced: a stream when the call asked for one, else one completion. */
export function scriptedBody(answer: ScriptedAnswer, request: ScriptedRequest): { readonly contentType: string; readonly body: string } {
  return request.streamed
    ? { contentType: 'text/event-stream', body: streamOf(answer, request) }
    : { contentType: 'application/json', body: completionOf(answer, request) };
}
