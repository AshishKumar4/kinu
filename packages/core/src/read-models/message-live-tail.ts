/**
 * What a live assistant turn is doing at its tail, right now.
 *
 * The chat has exactly one live affordance and it belongs at the END of the
 * rendered content. Before this it had two, both placed by guesswork: a
 * standalone "Thinking" row shown only while a message had NO parts at all,
 * and a blink caret hung off the last TEXT part — which is not the last part.
 * A turn that writes a sentence and then makes six calls kept its caret above
 * the six rows, and a turn that finished its prose and went quiet between
 * steps showed nothing at all. Both are the same bug: the tail was inferred
 * from part ORDER instead of read from part STATE.
 *
 * The stream states this reads are the provider's own. `text` and `reasoning`
 * parts are opened `state: 'streaming'` and closed `state: 'done'` by the AI
 * SDK's stream reducer; a tool part is unsettled until its output or error
 * lands. So every answer here is a fact about the stream, never a timer — an
 * indicator that animates while nothing is arriving is worse than none.
 */
import { isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import type { TurnLiveness } from "./turn-liveness";

type Part = UIMessage["parts"][number];

export type LiveTail =
  /** Tokens are landing in this text block — the caret rides its last line. */
  | { kind: "text"; part: Part }
  /** The model is reasoning; that block reads live instead of a second row. */
  | { kind: "reasoning"; part: Part }
  /** A call is in flight. Its own row carries the live dot; nothing is added. */
  | { kind: "tool" }
  /** Between parts: the request is open and the next thing has not arrived. */
  | { kind: "thinking" };

/**
 * Only ever called for the last message of a stream that is still open, so
 * "no part is active" means the model is between steps — thinking — rather
 * than finished. A part with no `state` is one the stream never closed, which
 * on a live message is the thing currently being written.
 */
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

/**
 * The one tail the chat thread paints, decided by the surface that owns the
 * whole thread rather than by its last row.
 *
 * `liveTail` above answers for a message; this answers for a CONVERSATION, and
 * the difference is the reported wedge. A turn is admitted, the operator's
 * message is the last row, and no assistant row exists yet: asking the last
 * message whether it is live answers no, so the thread painted nothing while
 * the composer offered Stop. A live turn always has a tail — before its first
 * token that tail is `thinking` — and a thread that is not live has none.
 */
export function threadLiveTail(input: { readonly last: Pick<UIMessage, "role" | "parts"> | undefined; readonly liveness: TurnLiveness }): LiveTail | null {
  if (input.liveness.kind !== "live") return null;

  return liveTail(input.last?.role === "assistant" ? input.last.parts : []);
}
