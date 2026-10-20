/**
 * One answer as an OpenAI-compatible `/chat/completions` endpoint writes it, for every fixture host that plays one: the
 * envelope, the deltas, the finishing choice and the `[DONE]` terminator. A host keeps its own scenarios, refusals,
 * pacing and network; it writes its answers through here. Imports nothing node-only: a workerd probe bundles it.
 */

/** Token counts as the endpoint reports them. */
export interface ChatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/** A tool call as the wire carries it; `arguments` is the JSON text the model wrote. */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * What the answer says: text, a tool call, or both. Usage is reported only where the host gives one; absent, the answer
 * is unmetered, as some providers send it.
 */
export interface ChatAnswer {
  readonly model: string;
  readonly id?: string;
  readonly text?: string;
  readonly toolCall?: ChatToolCall;
  readonly usage?: ChatUsage;
}

/** What one streamed chunk carries: the role, text, reasoning text, or the tool call. */
export interface ChatDelta {
  readonly role?: 'assistant';
  readonly content?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly (ReturnType<typeof wireCall> & { readonly index: number })[];
}

/** One `/chat/completions` envelope's identity: what every chunk of an answer repeats. */
type ChatEnvelope = Pick<ChatAnswer, 'model' | 'id'>;

function envelope(answer: ChatEnvelope, object: 'chat.completion' | 'chat.completion.chunk') {
  return { id: answer.id ?? 'chatcmpl-mock', object, created: 1, model: answer.model };
}

function wireCall(call: ChatToolCall) {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
}

const finishOf = (answer: ChatAnswer) => (answer.toolCall === undefined ? 'stop' : 'tool_calls');

const usageOf = (answer: ChatAnswer) => (answer.usage === undefined ? {} : { usage: answer.usage });

/** The answer to a call that asked for no stream, as one completion's JSON. */
export function chatCompletionBody(answer: ChatAnswer): string {
  const message = { role: 'assistant', content: answer.text ?? null, ...answer.toolCall !== undefined && { tool_calls: [wireCall(answer.toolCall)] } };

  return JSON.stringify({ ...envelope(answer, 'chat.completion'), choices: [{ index: 0, message, finish_reason: finishOf(answer) }], ...usageOf(answer) });
}

/** One streamed frame carrying `delta` alone, unfinished: what a paced answer writes before the rest. */
export function chatCompletionFrame(answer: ChatEnvelope, delta: ChatDelta): string {
  return `data: ${JSON.stringify({ ...envelope(answer, 'chat.completion.chunk'), choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

/** The answer as a stream: its text, then its tool call, then the finishing chunk with its usage, then `[DONE]`. */
export function chatCompletionStream(answer: ChatAnswer): string {
  const frames = [
    ...answer.text === undefined ? [] : [chatCompletionFrame(answer, { role: 'assistant', content: answer.text })],
    ...answer.toolCall === undefined ? [] : [chatCompletionFrame(answer, { role: 'assistant', tool_calls: [{ index: 0, ...wireCall(answer.toolCall) }] })],
  ];

  const finish = { ...envelope(answer, 'chat.completion.chunk'), choices: [{ index: 0, delta: {}, finish_reason: finishOf(answer) }], ...usageOf(answer) };

  return `${frames.join('')}data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`;
}
