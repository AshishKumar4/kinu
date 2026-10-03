/**
 * One cloud turn's accumulated stream. An ack's replay restates the turn from its first step; it is matched to what is
 * held step by step (D23 (8)).
 */
import * as v from 'valibot';
import {
  JsonObjectSchema, parseJsonValue,
  type JsonObject, type JsonValue, type ToolOutcome,
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
  private readonly began: { readonly text: number; readonly calls: number }[] = [{ text: 0, calls: 0 }];
  private stepChunks = 0;
  private foreign = false;
  private cursor: { step: number; chunk: number } | null = null;

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
    this.cursor = { step: 0, chunk: 0 };
  }

  follow(): void {
    this.foreign = true;
  }

  apply(frame: { readonly body?: string; readonly replay?: boolean; readonly restated?: boolean; readonly replayComplete?: boolean }): void {
    if (frame.body !== undefined && frame.body.trim() !== '') this.applyChunk(frame.body, frame.replay === true, frame.restated === true);

    if (frame.replayComplete !== true) return;

    this.cursor = null;
    this.foreign = false;
  }

  private applyChunk(body: string, replay: boolean, restated: boolean): void {
    const chunk = decodeChunk(body);

    if (chunk === null || (replay && this.repeats(chunk.type, restated))) return;

    if (this.deferredStart !== null) {
      this.emit({ type: 'turn-start', kind: 'user', text: this.deferredStart });
      this.deferredStart = null;
    }

    this.decode(chunk.type, chunk.fields);

    if (chunk.type === 'start') return;

    if (chunk.type !== 'finish-step') {
      this.stepChunks += 1;

      return;
    }

    this.stepChunks = 0;
    this.began[this.steps] = { text: this.text.length, calls: this.toolCalls.length };
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

  private repeats(type: string, restated: boolean): boolean {
    const { cursor } = this;

    if (cursor === null) return false;

    if (type === 'start') return true;
    const sameStream = !restated && !this.foreign;
    const held = cursor.step < this.steps ? restated || sameStream : cursor.step === this.steps && sameStream && cursor.chunk < this.stepChunks;

    if (!held) {
      this.cursor = null;
      this.foreign = false;

      return false;
    }

    if (type === 'finish-step') {
      cursor.step += 1;
      cursor.chunk = 0;
    } else cursor.chunk += 1;

    return true;
  }

  private cut(step: number): void {
    const mark = this.began[step];

    if (mark === undefined) return;
    this.text = this.text.slice(0, mark.text);

    for (const call of this.toolCalls.splice(mark.calls)) {
      for (const [id, held] of this.toolById) if (held === call) this.toolById.delete(id);
    }

    this.steps = step;
    this.stepChunks = 0;
    this.began.length = step + 1;
  }

  private decode(type: string, chunk: JsonObject): void {
    switch (type) {
      case 'data-kinu-step-cut': {
        const data = v.parse(v.object({ stepIndex: v.number() }), chunk.data);
        this.cut(data.stepIndex - 1);
        this.emit({ type: 'step-cut', stepIndex: data.stepIndex });

        return;
      }

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

/** A re-opened turn's stream, to its request: the turn's id is the request's own. */
export class TurnStreams {
  private readonly moved = new Map<string, string>();

  requestOf(stream: string): string {
    return this.moved.get(stream) ?? stream;
  }

  resuming<T>(stream: string, turnId: string | undefined, open: ReadonlyMap<string, T>): { readonly turn: T; readonly moved: boolean } | null {
    const turn = open.get(this.requestOf(stream));

    if (turn !== undefined) return { turn, moved: false };

    const named = turnId === undefined ? undefined : open.get(turnId);

    if (turnId === undefined || named === undefined) return null;
    this.moved.set(stream, turnId);

    return { turn: named, moved: true };
  }

  ended(stream: string): void {
    this.moved.delete(stream);
  }

  clear(): void {
    this.moved.clear();
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
