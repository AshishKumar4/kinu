/**
 * Folding a message's parts into render blocks.
 *
 * A turn that repairs something is a run of calls — read, read, edit, write,
 * delegate, run — and one row each buries the prose on either side of it.
 * This walks the parts once and hands the view either a single part or a run
 * of consecutive tool calls to draw as one.
 *
 * The rule that matters: a call that is still running is never folded into a
 * group. Its row stays where it is, so a headline that says "5 calls" does
 * not tick to 6 and back while the reader is looking at it, and the live
 * indicator is never hidden behind a collapsed chevron.
 */
import { isToolUIPart } from "ai";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";

type Part = UIMessage["parts"][number];
/** Exactly what `isToolUIPart` narrows to — a crafted or MCP tool arrives as
 *  the dynamic variant, and the chat draws both the same way. */
export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

export type PartBlock =
  | { kind: "part"; part: Part }
  | { kind: "tool-run"; parts: AnyToolPart[] };

/** Only a settled call can be folded away — see the note above. */
function isFinished(part: AnyToolPart): boolean {
  return part.state === "output-available" || part.state === "output-error";
}

/** Two adjacent settled calls already form the tool card drawn by the mock. */
const MIN_GROUP = 2;

export function groupMessageParts(parts: readonly Part[]): PartBlock[] {
  const blocks: PartBlock[] = [];
  let run: AnyToolPart[] = [];

  // A short run stays as ordinary rows; adjacent calls coalesce into one card.
  const flush = () => {
    if (run.length >= MIN_GROUP) blocks.push({ kind: "tool-run", parts: run });
    else for (const part of run) blocks.push({ kind: "part", part });
    run = [];
  };

  for (const part of parts) {
    // AI SDK step markers carry no visible content. Keeping them in the render
    // stream split one long sequential tool run into dozens of singleton rows.
    if (part.type === 'step-start') continue;
    if (isToolUIPart(part) && isFinished(part)) {
      run.push(part);
      continue;
    }
    flush();
    blocks.push({ kind: "part", part });
  }
  flush();
  return blocks;
}
