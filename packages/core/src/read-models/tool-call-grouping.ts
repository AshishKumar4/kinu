/** Folds a message's parts into render blocks. Only adjacent settled quiet calls fold; mutations,
 * running calls and preview calls stay at their transcript position. */
import { isToolUIPart, getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import * as v from "valibot";
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import { toolCallEffect } from '../tools/tool-call-summary';
import { tolerate } from "../obs/index";
import { type JsonObject, type JsonValue } from '../utils/json';
import { extractPreviewUrl } from '../preview/preview-origin';

type Part = UIMessage["parts"][number];

/** A crafted or MCP tool arrives as the dynamic variant; the chat draws both the same way. */
export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

export type PartBlock =
  | { kind: "part"; part: Part }
  | { kind: "tool-run"; parts: AnyToolPart[] };

function isFinished(part: AnyToolPart): boolean {
  return part.state === "output-available" || part.state === "output-error";
}

const MIN_GROUP = 2;

export function groupMessageParts(parts: readonly Part[]): PartBlock[] {
  const blocks: PartBlock[] = [];
  let run: AnyToolPart[] = [];

  const flush = () => {
    if (run.length >= MIN_GROUP) blocks.push({ kind: "tool-run", parts: run });
    else for (const part of run) blocks.push({ kind: "part", part });
    run = [];
  };

  for (const part of parts) {
    // Step markers carry no visible content; keeping them splits one tool run into singleton rows.
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

/** `partFailed` is the protocol fact; `callFailed` adds the refusal payload a provisioned runtime
 * returns as a result. A tool returning `{error}` as data is neither (turn-accumulator.ts). */
const ProvisionErrorSchema = v.object({
  error: v.literal("runtime_not_provisioned"),
  runtime: v.string(),
  message: v.optional(v.string()),
});

export function parseProvisionError(output: JsonValue | undefined):
  { runtime: string; message: string } | null {
  const text = v.safeParse(v.string(), output);

  if (!text.success || !text.output.includes('runtime_not_provisioned')) return null;

  // Non-JSON output is not this shape; any other failure is real and must propagate.
  const parsed = v.safeParse(
    ProvisionErrorSchema,
    tolerate<unknown>(() => JSON.parse(text.output), 'malformed-input'),
  );

  return parsed.success
    ? { runtime: parsed.output.runtime, message: parsed.output.message ?? 'Runtime not available.' }
    : null;
}


/** Undefined until finished. Shared by the group tally and the part's card so they cannot disagree. */
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

function partFailed(part: AnyToolPart): boolean {
  return part.state === 'output-error';
}

export function callFailed(part: AnyToolPart): boolean {
  return partFailed(part) || parseProvisionError(partOutput(part)) !== null;
}
