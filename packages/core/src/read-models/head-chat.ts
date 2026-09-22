/**
 * A head's journalled steps and its in-flight step as chat messages. Kept together because both
 * must render through `MessageView` identically; the live state is two strings per head.
 */
import type { UIMessage } from "ai";
import type { HeadStep } from '../heads/types';

export interface HeadDelta {
  readonly text: string;
  readonly reasoning: string;
}

export type HeadDeltaKind = "text" | "reasoning";

const NOTHING: HeadDelta = { text: "", reasoning: "" };

/** `retire` exists because a socket frame can be missed: a reader that sees a landed step via its
 * own read must retire the delta, or the text paints twice. */
export interface HeadDeltas {
  get(headId: string): HeadDelta | undefined;
  /** The journal caught up; stop claiming this head's text. Idempotent. */
  retire(headId: string): void;
}

export const NO_HEAD_DELTAS: HeadDeltas = { get: () => undefined, retire: () => {} };

export function appendHeadDelta(
  previous: ReadonlyMap<string, HeadDelta>,
  headId: string,
  kind: HeadDeltaKind,
  delta: string,
): ReadonlyMap<string, HeadDelta> {
  const held = previous.get(headId) ?? NOTHING;

  return new Map(previous).set(headId, kind === "reasoning"
    ? { text: held.text, reasoning: held.reasoning + delta }
    : { text: held.text + delta, reasoning: held.reasoning });
}

/** Keeps the map's identity when nothing drops, so a no-op retire re-renders nothing. */
export function retireHeadDelta(
  previous: ReadonlyMap<string, HeadDelta>,
  headId: string,
): ReadonlyMap<string, HeadDelta> {
  if (!previous.has(headId)) return previous;
  const next = new Map(previous);
  next.delete(headId);

  return next;
}

/**
 * `dynamic-tool` parts: the head's tool set is not statically known to the browser. A call with no
 * recorded output stays `input-available`, drawn as still running.
 */
export function stepAsMessage(step: HeadStep, index: number, headId: string): UIMessage {
  const parts: UIMessage["parts"] = [];

  if (step.reasoning) parts.push({ type: "reasoning", text: step.reasoning, state: "done" });

  if (step.text) parts.push({ type: "text", text: step.text, state: "done" });

  for (const [callIndex, call] of step.toolCalls.entries()) {
    const toolCallId = `${headId}-s${index}-t${callIndex}`;
    parts.push(call.output === undefined
      ? { type: "dynamic-tool", toolName: call.name, toolCallId, state: "input-available", input: call.input }
      : { type: "dynamic-tool", toolName: call.name, toolCallId, state: "output-available", input: call.input, output: call.output });
  }

  return { id: `${headId}-s${index}`, role: "assistant", parts };
}

/**
 * Left `state: "streaming"` so `MessageView` draws the live tail; reasoning closes once prose starts.
 * Null when the head has produced nothing.
 */
export function deltaAsMessage(delta: HeadDelta | undefined, headId: string): UIMessage | null {
  if (delta === undefined || (delta.text === "" && delta.reasoning === "")) return null;
  const parts: UIMessage["parts"] = [];

  if (delta.reasoning) {
    parts.push({ type: "reasoning", text: delta.reasoning, state: delta.text ? "done" : "streaming" });
  }

  if (delta.text) parts.push({ type: "text", text: delta.text, state: "streaming" });

  return { id: `${headId}-live`, role: "assistant", parts };
}
