/**
 * A head's work as chat messages: the steps its journal holds, and the step
 * still arriving.
 *
 * Both projections live here because they have to agree. A journalled step and
 * the step being written are the SAME shape — optional reasoning, optional
 * prose, the calls it made — and the chat already has one renderer for that
 * (`MessageView`). A bespoke rendering for the live half is what made an
 * in-flight step read as a plain dashed box with its reasoning thrown away,
 * while the identical text one frame later read as a chat message.
 *
 * The accumulator is here too, next to the projection that consumes it, and it
 * is the whole of the live state: two strings per head, no history, nothing
 * persisted. A `head_stream` frame carries the provider's own delta verbatim,
 * so applying one is a concatenation and nothing else.
 */
import type { UIMessage } from "ai";
import type { HeadStep, HeadStepToolCall } from "@kinu.run/core";

/** What a running head has produced but not yet journalled, in the two streams
 *  the provider separates. Both halves, because the chat draws both. */
export interface HeadDelta {
  readonly text: string;
  readonly reasoning: string;
}

/** Which of a head's two streams a `head_stream` frame carried. */
export type HeadDeltaKind = "text" | "reasoning";

const NOTHING: HeadDelta = { text: "", reasoning: "" };

/**
 * The live deltas as a READER sees them: what a head is writing, and the one
 * thing the reader may say back about it.
 *
 * `retire` is that one thing, and it is why this is an interface rather than
 * the map itself. A delta is retired by the `head_activity` push in the normal
 * case — but a socket frame can be missed, which is the whole reason an open
 * transcript also re-reads on a clock. A reader that learns of a landed step
 * from its OWN read has to retire the delta as well, or the same text paints
 * twice: once as the durable step, once as the live tail under it.
 *
 * The accumulator stays in `useKinu`, where the socket is. This is its surface.
 */
export interface HeadDeltas {
  /** What this head is writing, or undefined when nothing is. */
  get(headId: string): HeadDelta | undefined;
  /** This head's journal has caught up with what the accumulator holds, so the
   *  accumulator must stop claiming it. Idempotent. */
  retire(headId: string): void;
}

/** No head is painting. A shared empty for every caller without a live socket:
 *  the gallery frames, a settled view. */
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

/** Drop one head's accumulator, keeping the map's identity when there is
 *  nothing to drop — a retire that changed nothing must not re-render every
 *  reader. */
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
 * One recorded step as one assistant message.
 *
 * A step is exactly what the chat already draws: optional reasoning, optional
 * prose, and the calls it made. The only translation needed is the tool shape —
 * the journal stores `{ name, input, output }` and the chat reads AI-SDK tool
 * parts — so that is all this does.
 *
 * `dynamic-tool` rather than a typed `tool-<name>` part because the head's tool
 * set is not statically known to the browser, and `groupMessageParts` /
 * `ToolCallPart` treat both variants identically by design (tool-call-grouping.ts).
 *
 * A call with no recorded output is `input-available`, which the chat draws as
 * still running — true of the step a live branch is in the middle of, and the
 * honest reading of a call whose result never came back.
 */
export function stepAsMessage(step: HeadStep, index: number, headId: string): UIMessage {
  const parts: UIMessage["parts"] = [];
  if (step.reasoning) parts.push({ type: "reasoning", text: step.reasoning, state: "done" });
  if (step.text) parts.push({ type: "text", text: step.text, state: "done" });
  step.toolCalls.forEach((call: HeadStepToolCall, callIndex) => {
    const toolCallId = `${headId}-s${index}-t${callIndex}`;
    parts.push(call.output === undefined
      ? { type: "dynamic-tool", toolName: call.name, toolCallId, state: "input-available", input: call.input }
      : { type: "dynamic-tool", toolName: call.name, toolCallId, state: "output-available", input: call.input, output: call.output });
  });
  return { id: `${headId}-s${index}`, role: "assistant", parts };
}

/**
 * The step still arriving, as the chat's own live message.
 *
 * Left OPEN — `state: "streaming"` on the part tokens are landing in — so
 * `MessageView`'s live tail shimmers the reasoning block and puts the caret
 * inside the prose, which is what the main chat's streaming turn looks like.
 * Reasoning closes the moment prose starts, because a provider that has begun
 * answering has stopped thinking.
 *
 * Null when the head has produced nothing: there is no message to draw, and
 * that is also what a head emitting no deltas at all looks like — one rendering
 * for both.
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
