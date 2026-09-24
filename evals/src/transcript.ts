import * as v from 'valibot';
import { decodeModelMessageValues, JsonValueSchema, projectJsonValue, type RunEvent } from '@kinu.run/core';
import type { TranscriptEvent } from 'vitest-evals';
import type { EvalMetrics } from './task';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const ArgumentsSchema = v.record(v.string(), JsonValueSchema);

const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

/** A call the deployment recorded as failed: an error string, or a producer outcome that says so. */
function failed(call: ToolCallEnd): boolean {
  return call.error !== undefined || call.outcome?.success === false;
}

/** What the model said in one step: the text parts of its assistant messages, joined. */
function stepText(step: Extract<RunEvent, { type: 'step_finish' }>): string {
  return decodeModelMessageValues(step.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => v.is(v.string(), message.content)
      ? [message.content]
      : message.content.flatMap((part) => v.is(TextPartSchema, part) ? [part.text] : []))
    .join('')
    .trim();
}

/**
 * The deployment's run ledger as a vitest-evals transcript, in ledger order: each run's opening
 * message, then per model step what it said and every tool call with its result or error.
 */
export function toTranscript(events: readonly RunEvent[]): TranscriptEvent[] {
  const transcript: TranscriptEvent[] = [];
  let calls: ToolCallEnd[] = [];

  for (const event of events) {
    const metadata = { runId: event.runId, timestamp: event.timestamp };

    if (event.type === 'run_start') {
      const content = event.userMessage ?? `(the workspace started a run: ${event.caused_by ?? 'programmatic'})`;
      transcript.push({ type: 'message', role: 'user', content, metadata });
    } else if (event.type === 'tool_call_end') {
      calls.push(event);
    } else if (event.type === 'step_finish') {
      const text = stepText(event);

      if (text !== '') transcript.push({ type: 'message', role: 'assistant', content: text, metadata });

      for (const call of calls) {
        const args = v.safeParse(ArgumentsSchema, projectJsonValue({ value: call.args ?? {} }));
        const invoked: TranscriptEvent = { type: 'tool_call', id: call.toolCallId, name: call.name, metadata };

        if (args.success) invoked.arguments = args.output;
        transcript.push(invoked);
        transcript.push(failed(call)
          ? { type: 'tool_result', toolCallId: call.toolCallId, name: call.name, metadata,
              error: { type: 'ToolError', message: call.error ?? JSON.stringify(call.result ?? null) } }
          : { type: 'tool_result', toolCallId: call.toolCallId, name: call.name, metadata,
              content: projectJsonValue({ value: call.result ?? null }) });
      }

      calls = [];
    } else if (event.type === 'run_end' && event.reason !== 'completed') {
      const content = `(the run ended: ${event.reason ?? 'no reason'}${event.error === undefined ? '' : ` — ${event.error}`})`;
      transcript.push({ type: 'message', role: 'system', content, metadata });
    }
  }

  return transcript;
}

/** Model steps, tool calls and failed tool calls, counted off the ledger. */
export function measure(events: readonly RunEvent[]): EvalMetrics & { inputTokens: number; outputTokens: number } {
  let modelTurns = 0, toolCalls = 0, toolErrors = 0, inputTokens = 0, outputTokens = 0;

  for (const event of events) {
    if (event.type === 'step_finish') {
      modelTurns += 1;
      inputTokens += event.usage?.input ?? 0;
      outputTokens += event.usage?.output ?? 0;
    } else if (event.type === 'tool_call_end') {
      toolCalls += 1;

      if (failed(event)) toolErrors += 1;
    }
  }

  return { modelTurns, toolCalls, toolErrors, inputTokens, outputTokens };
}
