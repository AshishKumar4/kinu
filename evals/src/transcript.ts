import * as v from 'valibot';
import {
  BUILTIN_TOOL_NAMES, decodeModelMessageValues, JsonValueSchema, projectJsonValue, SUBMIT_PLAN_TOOL, TOOL_CALLS_PENDING, type RunEvent,
} from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import type { TranscriptEvent } from 'vitest-evals';
import { redact, redactJson } from './redact';
import type { EvalMetrics } from './task';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const ArgumentsSchema = v.record(v.string(), JsonValueSchema);

const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

const ToolCallPartSchema = v.object({ type: v.literal('tool-call'), toolCallId: v.string(), input: v.unknown() });

/** The native tools a turn can be offered; crafted tools run inside `eval`, so a call naming any other was invented. */
const OFFERED_TOOLS: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, SUBMIT_PLAN_TOOL]);

/** A call the deployment recorded as failed: an error string, or a producer outcome that says so. */
function failed(call: ToolCallEnd): boolean {
  return call.error !== undefined || call.outcome?.success === false;
}

/** What the model said in one step: the text parts of its assistant messages, joined. */
function stepText(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => v.is(v.string(), message.content)
      ? [message.content]
      : message.content.flatMap((part) => v.is(TextPartSchema, part) ? [part.text] : []))
    .join('')
    .trim();
}

/**
 * Each tool call of one step as the model sent it, by call id. The ledger's own row keeps a digest of
 * a large call's arguments, which is where the code an agent writes lives; the step's messages keep
 * all of it.
 */
function inputsOf(messages: readonly ModelMessage[]): Map<string, unknown> {
  const inputs = new Map<string, unknown>();

  for (const message of messages) {
    if (message.role !== 'assistant' || v.is(v.string(), message.content)) continue;

    for (const part of message.content) {
      const call = v.safeParse(ToolCallPartSchema, part);

      if (call.success) inputs.set(call.output.toolCallId, call.output.input);
    }
  }

  return inputs;
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
      transcript.push({ type: 'message', role: 'user', content: redact(content), metadata });
    } else if (event.type === 'tool_call_end') {
      calls.push(event);
    } else if (event.type === 'step_finish') {
      const messages = decodeModelMessageValues(event.messages ?? []);
      const inputs = inputsOf(messages);
      const text = stepText(messages);

      if (text !== '') transcript.push({ type: 'message', role: 'assistant', content: redact(text), metadata });

      for (const call of calls) {
        const input = inputs.has(call.toolCallId) ? inputs.get(call.toolCallId) : call.args;
        const args = v.safeParse(ArgumentsSchema, redactJson(projectJsonValue({ value: input ?? {} })));
        const invoked: TranscriptEvent = { type: 'tool_call', id: call.toolCallId, name: call.name, metadata };

        if (args.success) invoked.arguments = args.output;
        transcript.push(invoked);
        transcript.push(failed(call)
          ? { type: 'tool_result', toolCallId: call.toolCallId, name: call.name, metadata,
              error: { type: 'ToolError', message: redact(call.error ?? JSON.stringify(call.result ?? null)) } }
          : { type: 'tool_result', toolCallId: call.toolCallId, name: call.name, metadata,
              content: redactJson(projectJsonValue({ value: call.result ?? null })) });
      }

      calls = [];
    } else if (event.type === 'run_end' && event.reason !== 'completed') {
      const content = `(the run ended: ${event.reason ?? 'no reason'}${event.error === undefined ? '' : ` — ${event.error}`})`;
      transcript.push({ type: 'message', role: 'system', content: redact(content), metadata });
    }
  }

  return transcript;
}

/** Model steps, tool calls, failed tool calls and waits on the model provider's rate limit, counted off the ledger. A
 *  `stall` wait is the provider failing to send anything, not the limit, and the run's own rows carry it. */
export function measure(events: readonly RunEvent[]): EvalMetrics {
  let modelTurns = 0, toolCalls = 0, toolErrors = 0, badInputCalls = 0, unknownToolCalls = 0, providerWaits = 0, providerWaitMs = 0;

  for (const event of events) {
    if (event.type === 'step_finish') {
      modelTurns += 1;
    } else if (event.type === 'tool_call_end') {
      toolCalls += 1;

      if (failed(event)) toolErrors += 1;

      if (event.outcome?.success === false && event.outcome.reason === 'bad_input') badInputCalls += 1;

      if (!OFFERED_TOOLS.has(event.name)) unknownToolCalls += 1;
    } else if (event.type === 'provider_wait' && event.source !== 'stall') {
      providerWaits += 1;
      providerWaitMs += event.waitMs;
    }
  }

  return { modelTurns, toolCalls, toolErrors, badInputCalls, unknownToolCalls, providerWaits, providerWaitMs };
}

/**
 * Runs this turn opened that stopped while the model was still calling tools and were reported
 * completed: a loop cut mid-work that said it finished. The product seals such a run `incomplete`
 * (core `classifyRunEnd`); four capped production turns once reported `completed` instead, and no
 * suite could see it. Read off the run ledger the web app's Activity pane reads.
 */
export function cutButCompleted(events: readonly RunEvent[], before: ReadonlySet<string>): { runId: string; steps: number }[] {
  const steps = new Map<string, { count: number; last: string | undefined }>();
  const completed: string[] = [];

  for (const event of events) {
    if (before.has(event.runId)) continue;

    if (event.type === 'step_finish') {
      steps.set(event.runId, { count: (steps.get(event.runId)?.count ?? 0) + 1, last: event.reason });
    } else if (event.type === 'run_end' && event.reason === 'completed') {
      completed.push(event.runId);
    }
  }

  return completed.flatMap((runId) => {
    const seen = steps.get(runId);

    return seen?.last === TOOL_CALLS_PENDING ? [{ runId, steps: seen.count }] : [];
  });
}
