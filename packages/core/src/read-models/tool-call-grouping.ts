/**
 * How the chat lays out a turn's parts (the owner, 2026-10-17, 2026-10-19): a run of two or more tool calls is one
 * phase, folded behind a line that says in a few words what it did or is doing. Thinking streams as it always has: a
 * thought before a phase's first call or after its last stands outside it, and only the thoughts between its calls go
 * in. What the owner reads or answers stands outside a phase and ends it: the turn's words, a question for the owner, a
 * call that started a preview, a file. A long turn rolls up once more: its earlier phases, with the thinking and words
 * among them, under one line, the newest phase open below it while it runs, and the answer under all of it once it
 * lands.
 */
import { isToolUIPart, getToolName } from "ai";
import type { DynamicToolUIPart, ReasoningUIPart, ToolUIPart, UIMessage } from "ai";
import * as v from "valibot";
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import { toolCallEffect } from '../tools/tool-call-summary';
import { ASK_OWNER_TOOL } from '../tools/registry';
import { tolerate } from "../obs/index";
import { type JsonObject, type JsonValue } from '../utils/json';
import { extractPreviewUrl } from '../preview/preview-origin';
import { ongoing, phaseTitle } from './tool-phase-title';

type Part = UIMessage["parts"][number];

/** A crafted or MCP tool arrives as the dynamic variant; the chat draws both the same way. */
export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** One step of a run: a call, or the thinking between calls, in a row. */
export type RunStep =
  | { kind: "tool"; part: AnyToolPart }
  | { kind: "reasoning"; parts: ReasoningUIPart[] };

/** `reasoning`: a run of thinking, across steps; `run`: a phase, its calls and the thinking between them. */
export type PartBlock =
  | { kind: "part"; part: Part }
  | { kind: "run"; steps: RunStep[] }
  | { kind: "reasoning"; parts: ReasoningUIPart[] };

/** A turn's blocks, its earlier phases and the words among them rolled up into one `turn`. */
export type TurnBlock = PartBlock | { kind: "turn"; blocks: PartBlock[] };

/** The calls a run holds before it groups. */
const RUN_MIN = 2;

/** A call the owner neither answers nor reads as the turn's result: one a run may hold. */
function isRunCall(part: Part): part is AnyToolPart {
  return isToolUIPart(part) && getToolName(part) !== ASK_OWNER_TOOL && part.state !== "approval-requested"
    && extractPreviewUrl(partOutput(part)) === null;
}

/** Words or thinking that draw nothing: a run goes on across them. */
function blank(part: Part): boolean {
  return (part.type === "text" || part.type === "reasoning") && part.text.trim() === "";
}

/** Thinking onto the end of `list`: joined to the thinking it ends on, or its own block after it. */
function addThought(list: (PartBlock | RunStep)[], part: ReasoningUIPart): void {
  const last = list.at(-1);

  if (last?.kind === "reasoning") last.parts.push(part);
  else list.push({ kind: "reasoning", parts: [part] });
}

/** The last index `test` holds at; -1 for none. ES2022's arrays have no `findLastIndex`. */
function lastIndex<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let at = list.length - 1; at >= 0; at--) {
    const item = list[at];

    if (item !== undefined && test(item)) return at;
  }

  return -1;
}

/** Each thought before a phase's first call, or after its last, as the blocks outside it. */
function addThoughts(blocks: PartBlock[], steps: readonly RunStep[]): void {
  for (const step of steps) if (step.kind === "reasoning") for (const part of step.parts) addThought(blocks, part);
}

export function groupMessageParts(parts: readonly Part[]): PartBlock[] {
  const blocks: PartBlock[] = [];
  let run: RunStep[] = [];

  // Too few calls to group: each call is its own row, and its thinking its own block.
  const flush = () => {
    const first = run.findIndex((step) => step.kind === "tool");
    const last = lastIndex(run, (step) => step.kind === "tool");

    if (run.filter((step) => step.kind === "tool").length >= RUN_MIN) {
      addThoughts(blocks, run.slice(0, first));
      blocks.push({ kind: "run", steps: run.slice(first, last + 1) });
      addThoughts(blocks, run.slice(last + 1));
    }
    else for (const step of run) {
      if (step.kind === "tool") blocks.push({ kind: "part", part: step.part });
      else for (const part of step.parts) addThought(blocks, part);
    }

    run = [];
  };

  for (const part of parts) {
    // Step markers draw nothing and would split a run.
    if (part.type === "step-start" || blank(part)) continue;

    if (isRunCall(part)) run.push({ kind: "tool", part });
    else if (part.type === "reasoning") addThought(run, part);
    else {
      flush();
      blocks.push({ kind: "part", part });
    }
  }

  flush();

  return blocks;
}

/** A block of the turn's work: a phase, or a call on its own row. */
function isWorkBlock(block: PartBlock): boolean {
  return block.kind === "run" || (block.kind === "part" && isRunCall(block.part));
}

/** What the owner reads or answers, never rolled up: a question, a preview, a file, a call that waits on them. */
function ownerFacing(block: PartBlock): boolean {
  return block.kind === "part" && block.part.type !== "text" && !isWorkBlock(block);
}

/** The phases a stretch holds before it rolls up: a long turn's, never an ordinary one's, which reads as it did. */
const TURN_MIN = 3;

/**
 * The turn as it reads: while it runs, the newest phase, and the thought that opened it, open, and the work before it
 * under one line once three phases lie there; once it has run, all its work under that line and the answer
 * after it, when it holds as many. What the owner reads or answers is never rolled up, so it splits the line in two.
 */
export function rollUpTurn(blocks: readonly PartBlock[], live: boolean): TurnBlock[] {
  const newest = lastIndex(blocks, isWorkBlock);

  if (newest < 0) return [...blocks];
  const opened = live && blocks[newest - 1]?.kind === "reasoning" ? newest - 1 : newest;
  const tail = live ? opened : newest + 1;
  const rolled: TurnBlock[] = [];
  let stretch: PartBlock[] = [];

  const close = () => {
    if (stretch.filter((block) => block.kind === "run").length >= TURN_MIN) rolled.push({ kind: "turn", blocks: stretch });
    else rolled.push(...stretch);
    stretch = [];
  };

  for (const block of blocks.slice(0, tail)) {
    if (ownerFacing(block)) {
      close();
      rolled.push(block);
    }
    else stretch.push(block);
  }

  close();

  return [...rolled, ...blocks.slice(tail)];
}

/** A phase's calls, in order. */
export function phaseCalls(steps: readonly RunStep[]): AnyToolPart[] {
  return steps.flatMap((step) => (step.kind === "tool" ? [step.part] : []));
}

/** A phase as its line reads: its calls, those that failed, what it did, and what is running in it now. */
export interface ToolRunSummary {
  readonly calls: number;
  readonly failed: number;
  readonly title: string;
  readonly now: string;
}

const running = (part: AnyToolPart) => part.state === "input-streaming" || part.state === "input-available";

export function toolRunSummary(steps: readonly RunStep[]): ToolRunSummary {
  const calls = phaseCalls(steps);
  const newest = calls.at(-1);
  const done = calls.filter((call) => !running(call));

  return {
    calls: calls.length, failed: calls.filter(callFailed).length,
    title: phaseTitle(done), now: newest !== undefined && running(newest) ? ongoing(newest) : "",
  };
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
  const answered = part.state === 'output-error' ? part.errorText : partOutput(part);

  return toolCallEffect(getToolName(part), partInput(part), part.state === 'output-available' || part.state === 'output-error' ? { toolCallId: part.toolCallId, output: answered } : undefined);
}

function partFailed(part: AnyToolPart): boolean {
  return part.state === 'output-error';
}

export function callFailed(part: AnyToolPart): boolean {
  return partFailed(part) || parseProvisionError(partOutput(part)) !== null;
}
