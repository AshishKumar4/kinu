/**
 * Shared chat engine — one implementation used by both the server and CLI.
 *
 * Yields streaming events (text deltas, tool calls, tool results) and
 * returns the FULL ModelMessage array including tool call/result messages.
 * Callers store these messages in history so the model sees tool context
 * on subsequent turns.
 */

import { streamText, stepCountIs, type ModelMessage, type ToolSet, type LanguageModel } from 'ai';
import { resolveMaxSteps } from './config.js';

export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolName: string; result: string }
  | { type: 'step-finish'; stepIndex: number }
  | { type: 'done'; text: string; responseMessages: ModelMessage[] };

export interface ChatOptions {
  model: LanguageModel;
  system: string;
  history: ModelMessage[];
  tools: ToolSet;
  maxSteps?: number;
  signal?: AbortSignal;
}

/**
 * Run one chat turn. Yields streaming events and finishes with a 'done'
 * event containing the full text and the SDK's response messages.
 *
 * The response messages include assistant messages (with tool_call parts)
 * and tool messages (with tool_result parts). Callers MUST append these
 * to the conversation history — not just the flat text.
 */
export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const maxSteps = opts.maxSteps ?? resolveMaxSteps();

  // Channel step-finish events from the onStepFinish callback to the generator.
  // We use a simple array that the generator checks after each stream chunk.
  const pendingStepEvents: Array<{ stepIndex: number }> = [];
  let stepCount = 0;

  const result = streamText({
    model: opts.model,
    system: opts.system +
      '\n\nAfter using any tools, always provide a brief text summary of what you did and the results.',
    messages: opts.history,
    tools: opts.tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal: opts.signal,
    onStepFinish: () => {
      stepCount++;
      pendingStepEvents.push({ stepIndex: stepCount });
    },
  });

  let allText = '';

  for await (const chunk of result.fullStream) {
    if (opts.signal?.aborted) break;

    switch (chunk.type) {
      case 'text-delta': {
        const delta = (chunk as any).textDelta ?? (chunk as any).text ?? '';
        if (delta) {
          allText += delta;
          yield { type: 'text-delta', delta };
        }
        break;
      }
      case 'tool-call': {
        const args = (chunk as any).input ?? (chunk as any).args ?? {};
        yield {
          type: 'tool-call',
          toolName: chunk.toolName,
          args: args as Record<string, unknown>,
        };
        break;
      }
      case 'tool-result': {
        const raw = (chunk as any).output ?? (chunk as any).result ?? '';
        yield {
          type: 'tool-result',
          toolName: chunk.toolName,
          result: String(raw).slice(0, 1000),
        };
        break;
      }
    }

    // Yield any step-finish events that fired via onStepFinish callback
    while (pendingStepEvents.length > 0) {
      const ev = pendingStepEvents.shift()!;
      yield { type: 'step-finish' as const, stepIndex: ev.stepIndex };
    }
  }

  // Await the full result to get response messages
  const response = await result.response;
  const steps = await result.steps;
  const responseMessages = response.messages as ModelMessage[];

  // If the model produced no text (ended on a tool call), gather from steps
  if (!allText.trim()) {
    for (const step of steps) {
      if (step.text?.trim()) allText += step.text;
    }
  }

  // If still no text, synthesize from tool results
  if (!allText.trim()) {
    const summaries: string[] = [];
    for (const step of steps) {
      for (const tr of step.toolResults) {
        const output = (tr as any).output ?? (tr as any).result ?? '';
        summaries.push(`[${tr.toolName}] ${String(output).slice(0, 200)}`);
      }
    }
    if (summaries.length > 0) allText = summaries.join('\n');
  }

  yield { type: 'done', text: allText, responseMessages };
}
