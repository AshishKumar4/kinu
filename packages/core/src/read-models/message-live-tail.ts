/**
 * What a live assistant turn is doing at its tail, read from part state, never part order or a timer. Only
 * a part the row draws is a live state; an empty one reads as thinking.
 */
import { isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { AnyToolPart } from "./tool-call-grouping";
import type { TurnLiveness } from "./turn-liveness";

type Part = UIMessage["parts"][number];

export type LiveTail =
  | { kind: "text"; part: Part }
  | { kind: "reasoning"; part: Part }
  /** Its own row carries the live dot. */
  | { kind: "tool" }
  /** Between parts: the next thing has not arrived. */
  | { kind: "thinking" };

/** What a text or reasoning block draws; null when blank. */
export function drawnText(part: { readonly text: string }): string | null {
  return part.text.trim() === "" ? null : part.text;
}

/** A call its row draws running. */
export function toolCallRunning(part: AnyToolPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available";
}

/** The newest part of the step in flight that draws itself live. A part with no `state` is being written. */
function liveTail(parts: readonly Part[]): LiveTail {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];

    if (part === undefined) continue;

    if (part.type === "step-start") break;

    if (isToolUIPart(part)) {
      if (toolCallRunning(part)) return { kind: "tool" };

      continue;
    }

    if (part.type !== "text" && part.type !== "reasoning") continue;

    if (part.state === "done" || drawnText(part) === null) continue;

    return part.type === "text" ? { kind: "text", part } : { kind: "reasoning", part };
  }

  return { kind: "thinking" };
}

/** Before the first assistant row the tail is `thinking`; a thread that is not live has none. */
export function threadLiveTail(input: { readonly last: Pick<UIMessage, "role" | "parts"> | undefined; readonly liveness: TurnLiveness }): LiveTail | null {
  if (input.liveness.kind !== "live") return null;

  return liveTail(input.last?.role === "assistant" ? input.last.parts : []);
}
