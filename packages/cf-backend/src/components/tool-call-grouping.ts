/**
 * Folding a message's parts into render blocks.
 *
 * Only adjacent settled quiet calls fold together. Mutations, running calls and
 * calls that put a preview on screen stay visible at their transcript position.
 */
import { isToolUIPart, getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import * as v from "valibot";
import { JsonObjectSchema, JsonValueSchema, toolCallEffect } from "@kinu.run/core";
import { tolerate } from "@kinu.run/core/obs";
import type { JsonObject, JsonValue } from "@kinu.run/core";
import { extractPreviewUrl } from "@kinu.run/core";

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

/** A single read needs no group header. */
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

    if (isToolUIPart(part) && isFinished(part) && partEffect(part) !== 'mutate' && extractPreviewUrl(partOutput(part)) === null) {
      run.push(part);
      continue;
    }

    flush();
    blocks.push({ kind: "part", part });
  }

  flush();

  return blocks;
}

/**
 * `partFailed` is the protocol fact (the transport reports the invocation
 * failed); `callFailed` is what the reader is shown as failed — the protocol
 * fact plus the refusal payload a provisioned runtime returns as an ordinary
 * result. A tool that caught its own failure and returned it as data
 * (`{error: "…"}`) is neither: output is data, and the ledger records it as
 * a clean invocation (turn-accumulator.ts).
 */
const ProvisionErrorSchema = v.object({
  error: v.literal("runtime_not_provisioned"),
  runtime: v.string(),
  message: v.optional(v.string()),
});

/** Try to parse `{error:'runtime_not_provisioned', runtime, message}` from a
 *  string-ified tool output. Returns null if the output doesn't match. */
export function parseProvisionError<Output>(output: Output):
  { runtime: string; message: string } | null {
  const text = v.safeParse(v.string(), output);

  if (!text.success || !text.output.includes('runtime_not_provisioned')) return null;

  // Output that names the runtime but isn't JSON is not this error shape; any
  // other failure here is real and must not read as "not a provision error".
  const parsed = v.safeParse(
    ProvisionErrorSchema,
    tolerate<unknown>(() => JSON.parse(text.output), 'malformed-input'),
  );

  return parsed.success
    ? { runtime: parsed.output.runtime, message: parsed.output.message ?? 'Runtime not available.' }
    : null;
}


/** The live output value of a finished part — undefined while it's still
 *  running or never finished, which is exactly when there is nothing to read
 *  a failure out of yet. Shared by the group's failure tally and the part's
 *  own card so the two can never disagree about the same call. */
export function partOutput(part: AnyToolPart): JsonValue | undefined {
  if (part.state !== "output-available") return undefined;
  const parsed = v.safeParse(JsonValueSchema, part.output);

  return parsed.success ? parsed.output : undefined;
}

export function partInput(part: AnyToolPart): JsonObject | undefined {
  const parsed = v.safeParse(JsonObjectSchema, part.input);

  return parsed.success ? parsed.output : undefined;
}

export function partEffect(part: AnyToolPart) {
  return toolCallEffect(getToolName(part), partInput(part));
}

/** The UI protocol records whether the tool invocation failed. Output is data. */
function partFailed(part: AnyToolPart): boolean {
  return part.state === 'output-error';
}

/** What the activity tally and the Failed badge both count. */
export function callFailed(part: AnyToolPart): boolean {
  return partFailed(part) || parseProvisionError(partOutput(part)) !== null;
}
