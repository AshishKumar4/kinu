/** Every tool call is its own row; only the middle of a run of {@link FOLD_MIN} or more adjacent settled
 *  read-only calls folds. */
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
  | { kind: "fold"; parts: AnyToolPart[] };

function isFinished(part: AnyToolPart): boolean {
  return part.state === "output-available" || part.state === "output-error";
}

const FOLD_MIN = 9;

export function groupMessageParts(parts: readonly Part[]): PartBlock[] {
  const blocks: PartBlock[] = [];
  let run: AnyToolPart[] = [];

  const flush = () => {
    if (run.length >= FOLD_MIN) blocks.push({ kind: "fold", parts: run });
    else for (const part of run) blocks.push({ kind: "part", part });
    run = [];
  };

  for (const part of parts) {
    // Step markers draw nothing and would split a run of reads.
    if (part.type === 'step-start') continue;

    if (isToolUIPart(part) && isFinished(part) && partEffect(part) === 'read' && extractPreviewUrl(partOutput(part)) === null) {
      run.push(part);
      continue;
    }

    flush();
    blocks.push({ kind: "part", part });
  }

  flush();

  return blocks;
}

/** `partFailed`, plus the refusal a provisioned runtime returns as a result; a tool's `{error}` data is neither. */
const ProvisionErrorSchema = v.object({
  error: v.literal("runtime_not_provisioned"),
  runtime: v.string(),
  message: v.optional(v.string()),
});

export function parseProvisionError(output: JsonValue | undefined):
  { runtime: string; message: string } | null {
  const text = v.safeParse(v.string(), output);

  if (!text.success || !text.output.includes('runtime_not_provisioned')) return null;

  // Non-JSON output is not this shape; other failures propagate.
  const parsed = v.safeParse(
    ProvisionErrorSchema,
    tolerate<unknown>(() => JSON.parse(text.output), 'malformed-input'),
  );

  return parsed.success
    ? { runtime: parsed.output.runtime, message: parsed.output.message ?? 'Runtime not available.' }
    : null;
}


/** Undefined until finished. */
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
