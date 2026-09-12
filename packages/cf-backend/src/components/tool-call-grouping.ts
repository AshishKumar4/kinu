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
import { isToolUIPart, getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import * as v from "valibot";
import {
  BUILTIN_TOOL_NAMES, JsonObjectSchema, JsonValueSchema,
  isMcpToolKey, toolCallEffect,
} from "@kinu.run/core";
import { tolerate } from "@kinu.run/core/obs";
import type { JsonObject, JsonValue } from "@kinu.run/core";

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

/**
 * The parts-model reads the chat already does inline, in one place so the
 * result line and the rows can never disagree about the same call.
 *
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

/** What the result line and the Failed badge both count. */
export function callFailed(part: AnyToolPart): boolean {
  return partFailed(part) || parseProvisionError(partOutput(part)) !== null;
}

/**
 * Whether a tool name is a workspace-crafted tool rather than something the
 * platform ships. Builtins are named by the registry; MCP tools arrive under
 * `mcp_<server>_<tool>` (mcp-naming.ts). Anything else on a part is a tool
 * the workspace taught itself — the only names on the wire the workspace
 * could have minted.
 */
function isCraftedToolName(name: string): boolean {
  return name !== '' && !BUILTIN_TOOL_NAMES.has(name) && !isMcpToolKey(name);
}

/** A completed turn's result as its parts carry it: how many settled calls,
 *  how many failed, and which crafted tools it used, in first-use order. */
export interface TurnResultFacts {
  calls: number;
  failed: number;
  crafted: string[];
}

export function turnResultFacts(parts: readonly Part[]): TurnResultFacts {
  let calls = 0;
  let failed = 0;
  const crafted: string[] = [];

  for (const part of parts) {
    if (!isToolUIPart(part)) continue;

    if (part.state !== "output-available" && part.state !== "output-error") continue;
    calls += 1;

    if (callFailed(part)) failed += 1;
    const name = getToolName(part);

    if (isCraftedToolName(name) && !crafted.includes(name)) crafted.push(name);
  }

  return { calls, failed, crafted };
}

/**
 * The compact result line for a completed turn, or null when the turn made
 * no calls and has nothing to summarize. Counts only — a tool output that
 * reads like a pass is not a check, and there is no check line because no
 * row the chat can read records a named passed check (see the report).
 */
export function formatTurnResult(facts: TurnResultFacts): string | null {
  if (facts.calls === 0) return null;

  const calls = `${facts.calls} tool call${facts.calls === 1 ? "" : "s"}`;

  return facts.failed > 0 ? `${calls}, ${facts.failed} failed` : calls;
}

/** A completed turn's parts cut for result-first rendering: the prose and
 *  files in place, the settled calls for the one activity group, and any
 *  call still open for its own live row. */
export interface CompletedTurnSplit {
  content: Part[];
  settled: AnyToolPart[];
  open: AnyToolPart[];
}

export function splitCompletedTurn(parts: readonly Part[]): CompletedTurnSplit {
  const content: Part[] = [];
  const settled: AnyToolPart[] = [];
  const open: AnyToolPart[] = [];

  for (const part of parts) {
    // AI SDK step markers carry no visible content (see groupMessageParts).
    if (part.type === 'step-start') continue;

    if (isToolUIPart(part)) {
      if (part.state === "output-available" || part.state === "output-error") settled.push(part);
      else open.push(part);

      continue;
    }

    content.push(part);
  }

  return { content, settled, open };
}
