/**
 * What a live assistant turn is doing at its tail. Read from part state (`streaming`/`done`, tool output
 * landed), never from part order or a timer: an indicator animating while nothing arrives is worse than none.
 */
import { isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { TurnLiveness } from "./turn-liveness";

type Part = UIMessage["parts"][number];

export type LiveTail =
  /** The caret rides this block's last line. */
  | { kind: "text"; part: Part }
  /** The model is reasoning; that block reads live instead of a second row. */
  | { kind: "reasoning"; part: Part }
  /** Its own row carries the live dot; nothing is added. */
  | { kind: "tool" }
  /** Between parts: the request is open and the next thing has not arrived. */
  | { kind: "thinking" };

/** Only called for the last message of an open stream, so no active part means between steps. A part
 * with no `state` was never closed: it is the one being written. */
function liveTail(parts: readonly Part[]): LiveTail {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];

    if (part === undefined) continue;

    if (isToolUIPart(part)) {
      const done = part.state === "output-available" || part.state === "output-error";

      return done ? { kind: "thinking" } : { kind: "tool" };
    }

    if (part.type === "text") {
      return part.state === "done" ? { kind: "thinking" } : { kind: "text", part };
    }

    if (part.type === "reasoning") {
      return part.state === "done" ? { kind: "thinking" } : { kind: "reasoning", part };
    }
  }

  return { kind: "thinking" };
}

/** Decided per conversation, not per last row: before the first assistant row the tail is `thinking`.
 * A live turn always has a tail; a thread that is not live has none. */
export function threadLiveTail(input: { readonly last: Pick<UIMessage, "role" | "parts"> | undefined; readonly liveness: TurnLiveness }): LiveTail | null {
  if (input.liveness.kind !== "live") return null;

  return liveTail(input.last?.role === "assistant" ? input.last.parts : []);
}
