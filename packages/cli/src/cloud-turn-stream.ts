/** One cloud turn's accumulated stream, as its live frames arrive. */
import * as v from 'valibot';
import {
  JsonObjectSchema, parseJsonValue,
  type JsonObject, type JsonValue, type ToolOutcome,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { asRecord } from './options';
import type { AgentClientEvent, AgentSendResult, AgentTurnResult } from './agent-client';

export class CloudTurnStream {
  private readonly startedAt = Date.now();
  private text = '';
  private steps = 0;
  private readonly toolCalls: AgentTurnResult['toolCalls'] = [];
  private readonly toolById = new Map<string, AgentTurnResult['toolCalls'][number]>();

  /** Turn-start owed only if the server answers with a stream; null once announced. */
  private deferredStart: string | null;

  constructor(
    private readonly emit: (event: AgentClientEvent) => void,
    private readonly resolve: (result: AgentSendResult) => void,
    opts: { readonly deferStart: string | null } = { deferStart: null },
  ) {
    this.deferredStart = opts.deferStart;
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
      toolCalls: this.toolCalls,
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
        const call = { name: toolName, args, result: undefined };
        this.toolCalls.push(call);

        if (toolCallId) this.toolById.set(toolCallId, call);
        this.emit({ type: 'tool-call', toolName, toolCallId, args });

        return;
      }

      case 'tool-output-available':
      case 'tool-output-error': {
        const toolCallId = jsonString(chunk.toolCallId, '');
        const call = this.toolById.get(toolCallId);

        const toolResult = type === 'tool-output-error'
          ? jsonErrorMessage(chunk.errorText, 'tool error')
          : stringifyToolOutput(chunk.output ?? null);

        const outcome = type === 'tool-output-error'
          ? { success: false, reason: null } satisfies ToolOutcome
          : { success: true } satisfies ToolOutcome;

        if (call) { call.result = toolResult; call.outcome = outcome; }

        this.emit({
          type: 'tool-result', toolName: call?.name ?? 'tool', toolCallId, result: toolResult,
          ...outcome,
        });

        return;
      }

      case 'finish-step': {
        this.steps += 1;
        this.emit({ type: 'step-finish', stepIndex: this.steps });

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
