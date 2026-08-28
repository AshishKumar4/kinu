/**
 * One cloud turn's stream, accumulated.
 *
 * Owns everything "the turn so far" means: the AI-SDK chunk vocabulary, the
 * tool calls paired to their outputs by id, the step count, the client events
 * a surface renders, and the single turn-end every turn-start is paired with.
 *
 * It also owns the one fact only a RESUMED stream has. The DO replays a resumed
 * stream from chunk zero on every resume ack, so a client that simply applied
 * what arrived would render the answer twice; the count of bodies already
 * applied is what makes the replay idempotent instead. CloudAgentClient keeps
 * the socket and the resume handshake — this keeps the turn.
 */
import * as v from 'valibot';
import {
  JsonObjectSchema, parseJsonValue,
  type JsonValue,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { asRecord, type AgentClientEvent, type AgentTurnResult } from './agent-client';

export class CloudTurnStream {
  /** Whether this turn's resume has been acked on the LIVE socket. The DO
   *  announces a resumable stream both proactively on connect and in answer to
   *  a probe, and every ack replays the buffer from chunk zero — so the ack
   *  goes out once per socket generation. */
  resumeAcked = false;
  /** Set when the socket died with this turn still running, cleared by the
   *  first frame that arrives for it afterwards. A drop that finds it still set
   *  made no progress, so the turn is reported rather than chased forever. */
  awaitingRebind = false;

  private readonly startedAt = Date.now();
  private text = '';
  private steps = 0;
  private readonly toolCalls: AgentTurnResult['toolCalls'] = [];
  private readonly toolById = new Map<string, AgentTurnResult['toolCalls'][number]>();
  /** Stream bodies already applied. */
  private applied = 0;
  /** Bodies counted in the CURRENT replay, against `applied`. */
  private replayed = 0;

  constructor(
    private readonly emit: (event: AgentClientEvent) => void,
    private readonly resolve: (result: AgentTurnResult) => void,
  ) {}

  /** A resume ack just went out: the replay that answers it starts at chunk
   *  zero, so the comparison against `applied` starts there too. */
  beginReplay(): void {
    this.replayed = 0;
  }

  /**
   * Feed one stream body.
   *
   * A replayed body the surface has already seen is dropped: a resumed stream
   * repeats its chunks in production order, so the first `applied` of them are
   * exactly the ones already rendered.
   */
  apply(body: string, replay: boolean): void {
    if (!this.admit(replay)) return;
    this.decode(body);
  }

  /** End the turn: exactly ONE turn-end per turn-start, carrying `hadError`
   *  (the error event precedes it) so a surface can pair the lifecycle. */
  settle(hadError = false): void {
    const result: AgentTurnResult = {
      text: this.text,
      toolCalls: this.toolCalls,
      steps: this.steps,
      durationMs: Date.now() - this.startedAt,
      hadError,
    };
    this.emit({ type: 'turn-end', turn: result });
    this.resolve(result);
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
        const args = asRecord({ value: chunk.input ?? null });
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
        const result = type.output === 'tool-output-error'
          ? jsonErrorMessage(chunk.errorText, 'tool error')
          : stringifyToolOutput(chunk.output ?? null);
        if (call) call.result = result;
        this.emit({
          type: 'tool-result', toolName: call?.name ?? 'tool', toolCallId, result,
          success: type.output !== 'tool-output-error',
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

/** The message an error-shaped JSON field carries, or `fallback` when it
 *  carries nothing readable. Exported because the client reads it off RPC
 *  rejections too. */
export function jsonErrorMessage(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);
  return text.success && text.output ? text.output : String(value);
}

function jsonString(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = v.safeParse(v.string(), value);
  return text.success ? text.output : fallback;
}
