/** One cloud turn's accumulated stream, as its live frames arrive. */
import * as v from 'valibot';
import {
  JsonObjectSchema, parseJsonValue, STEP_CUT_CHUNK, StepCutDataSchema,
  type JsonObject, type JsonValue, type ToolOutcome,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { asRecord } from './options';
import type { AgentClientEvent, AgentSendResult, AgentTurnResult } from './agent-client';
import { TurnCalls } from './turn-calls';

export class CloudTurnStream {
  private readonly startedAt = Date.now();
  private text = '';
  /** How much of `text` the finished steps wrote: a cut step's output is retracted back to it. */
  private stepText = 0;
  private steps = 0;
  private readonly calls = new TurnCalls();

  /** Turn-start owed only if the server answers with a stream; null once announced. */
  private deferredStart: string | null;

  private readonly resolve: (result: AgentSendResult) => void;

  private readonly reject: (refusal: Error) => void;

  constructor(
    private readonly sink: (event: AgentClientEvent) => void,
    send: { readonly resolve: (result: AgentSendResult) => void; readonly reject: (refusal: Error) => void },
    opts: { readonly deferStart: string | null } = { deferStart: null },
  ) {
    this.resolve = send.resolve;
    this.reject = send.reject;
    this.deferredStart = opts.deferStart;
  }

  /** Every event the stream says, its tool calls kept as it says them. */
  private emit(event: AgentClientEvent): void {
    this.calls.observe(event);
    this.sink(event);
  }

  /**
   * The workspace refused the send before admitting it: the send fails in the workspace's words. A turn-start already
   * announced for it is closed, so the count of running turns stays whole; a deferred one is never announced.
   */
  refused(message: string): void {
    if (this.deferredStart === null) this.emit({ type: 'turn-end', turn: { text: '', toolCalls: [], steps: 0, durationMs: Date.now() - this.startedAt, hadError: true } });
    this.deferredStart = null;
    this.reject(new Error(message));
  }

  landedMidTurn(): void {
    this.deferredStart = null;
    this.resolve({ landed: 'mid-turn' });
  }

  apply(body: string | undefined): void {
    const chunk = body === undefined || body.trim() === '' ? null : decodeChunk(body);

    if (chunk === null) return;

    if (this.deferredStart !== null) {
      this.emit({ type: 'turn-start', kind: 'user', text: this.deferredStart });
      this.deferredStart = null;
    }

    this.decode(chunk.type, chunk.fields);
  }

  /** The answer as the workspace recorded it, once the stream that was showing it is gone: what was not shown follows. */
  finish(answer: string): void {
    const rest = answer.startsWith(this.text) ? answer.slice(this.text.length) : `\n${answer}`;

    this.text = answer;

    if (rest !== '') this.emit({ type: 'text-delta', delta: rest });
  }

  /** Exactly one turn-end per turn-start, after any error event. */
  settle(hadError = false): void {
    if (this.deferredStart !== null) {
      this.emit({ type: 'turn-start', kind: 'user', text: this.deferredStart });
      this.deferredStart = null;
    }

    const result: AgentTurnResult = {
      text: this.text,
      toolCalls: this.calls.calls,
      steps: this.steps,
      durationMs: Date.now() - this.startedAt,
      hadError,
    };

    this.emit({ type: 'turn-end', turn: result });
    this.resolve({ landed: 'turn', ...result });
  }

  private decode(type: string, chunk: JsonObject): void {
    switch (type) {
      case 'text-delta': {
        const delta = jsonString(chunk.delta, '');

        if (!delta) return;
        this.text += delta;
        this.emit({ type: 'text-delta', delta });

        return;
      }

      case 'reasoning-delta': {
        const delta = jsonString(chunk.delta, '');

        if (delta) this.emit({ type: 'reasoning-delta', delta });

        return;
      }

      case 'tool-input-available': {
        const toolName = jsonString(chunk.toolName, 'tool');
        const toolCallId = jsonString(chunk.toolCallId, '');
        const args = asRecord({ value: chunk.input ?? null }, 'input');

        this.emit({ type: 'tool-call', toolName, toolCallId, args });

        return;
      }

      case 'tool-output-available':
      case 'tool-output-error': {
        const toolCallId = jsonString(chunk.toolCallId, '');

        const toolResult = type === 'tool-output-error'
          ? jsonErrorMessage(chunk.errorText, 'tool error')
          : stringifyToolOutput(chunk.output ?? null);

        const outcome = type === 'tool-output-error'
          ? { success: false, reason: null } satisfies ToolOutcome
          : { success: true } satisfies ToolOutcome;

        this.emit({
          type: 'tool-result', toolName: this.calls.nameOf(toolCallId) ?? 'tool', toolCallId, result: toolResult,
          ...outcome,
        });

        return;
      }

      case 'finish-step': {
        this.steps += 1;
        this.stepText = this.text.length;
        this.emit({ type: 'step-finish', stepIndex: this.steps });

        return;
      }

      // A resumed turn retracts the step its agent did not finish: what it wrote is not the answer.
      case STEP_CUT_CHUNK: {
        const cut = v.safeParse(StepCutDataSchema, chunk.data);

        if (!cut.success) return;
        this.text = this.text.slice(0, this.stepText);
        this.emit({ type: 'step-cut', stepIndex: cut.output.stepIndex });

        return;
      }
    }
  }
}

function decodeChunk(body: string): { readonly type: string; readonly fields: JsonObject } | null {
  const parsed = tolerate(() => parseJsonValue(body), 'malformed-input');

  if (parsed === undefined) return null;
  const chunk = v.safeParse(JsonObjectSchema, parsed);

  if (!chunk.success) return null;
  const type = v.safeParse(v.string(), chunk.output.type);

  return type.success ? { type: type.output, fields: chunk.output } : null;
}

function stringifyToolOutput(output: JsonValue): string {
  const text = v.safeParse(v.string(), output);

  return text.success ? text.output : JSON.stringify(output);
}

/** Exported because the client reads RPC rejections with it too. */
export function jsonErrorMessage(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

function jsonString(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : fallback;
}
