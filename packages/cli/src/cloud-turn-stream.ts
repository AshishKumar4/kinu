/**
 * One cloud turn's accumulated stream. The DO replays a resumed stream from chunk zero on every ack, so the
 * applied-body count makes replay idempotent.
 */
import * as v from 'valibot';
import {
  JsonObjectSchema, parseJsonValue,
  type JsonValue, type ToolOutcome,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { asRecord } from './options';
import type { AgentClientEvent, AgentSendResult, AgentTurnResult } from './agent-client';

export class CloudTurnStream {
  /** Every ack replays from chunk zero, so the ack goes out once per socket generation. */
  resumeAcked = false;
  /** Still set on a second drop means no progress: the turn is reported rather than chased forever. */
  awaitingRebind = false;

  private readonly startedAt = Date.now();
  private text = '';
  private steps = 0;
  private readonly toolCalls: AgentTurnResult['toolCalls'] = [];
  private readonly toolById = new Map<string, AgentTurnResult['toolCalls'][number]>();
  private applied = 0;
  private replayed = 0;

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

  beginReplay(): void {
    this.replayed = 0;
  }

  apply(body: string, replay: boolean): void {
    if (!this.admit(replay)) return;

    if (this.deferredStart !== null) {
      this.emit({ type: 'turn-start', kind: 'user', text: this.deferredStart });
      this.deferredStart = null;
    }

    this.decode(body);
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

  private admit(replay: boolean): boolean {
    if (!replay) {
      this.applied += 1;

      return true;
    }

    this.replayed += 1;

    if (this.replayed <= this.applied) return false;
    this.applied = this.replayed;

    return true;
  }

  private decode(body: string): void {
    const parsed = tolerate(() => parseJsonValue(body), 'malformed-input');

    if (parsed === undefined) return;
    const result = v.safeParse(JsonObjectSchema, parsed);

    if (!result.success) return;
    const chunk = result.output;
    const type = v.safeParse(v.string(), chunk.type);

    if (!type.success) return;

    switch (type.output) {
      case 'text-delta': {
        const delta = jsonString(chunk.delta, '');

        if (!delta) return;
        this.text += delta;
        this.emit({ type: 'text-delta', delta });

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

        const toolResult = type.output === 'tool-output-error'
          ? jsonErrorMessage(chunk.errorText, 'tool error')
          : stringifyToolOutput(chunk.output ?? null);

        const outcome = type.output === 'tool-output-error'
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

function stringifyToolOutput(output: JsonValue): string {
  const text = v.safeParse(v.string(), output);

  return text.success ? text.output : JSON.stringify(output);
}

/** Exported because the client reads RPC rejections with it too. */
export function jsonErrorMessage(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);

  if (text.success && text.output !== '') return text.output;

  return JSON.stringify(value);
}

function jsonString(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : fallback;
}
