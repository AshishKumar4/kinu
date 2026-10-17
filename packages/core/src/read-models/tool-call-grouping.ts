/**
 * How the chat lays out a turn's parts (the owner, 2026-10-17): a run of two or more tool calls in a row, with the
 * thinking around and between them, is one group, folded behind a line that says what it is doing or did. What the
 * owner reads or answers stands outside a run and splits it: the turn's words, a question for the owner, a call that
 * started a preview, a file.
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

type Part = UIMessage["parts"][number];

/** A crafted or MCP tool arrives as the dynamic variant; the chat draws both the same way. */
export type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** One step of a run: a call, or the thinking between calls, in a row. */
export type RunStep =
  | { kind: "tool"; part: AnyToolPart }
  | { kind: "reasoning"; parts: ReasoningUIPart[] };

/** `reasoning`: a run of thinking, across steps; `run`: a run of calls and the thinking among them. */
export type PartBlock =
  | { kind: "part"; part: Part }
  | { kind: "run"; steps: RunStep[] }
  | { kind: "reasoning"; parts: ReasoningUIPart[] };

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

export function groupMessageParts(parts: readonly Part[]): PartBlock[] {
  const blocks: PartBlock[] = [];
  let run: RunStep[] = [];

  // Too few calls to group: each call is its own row, and its thinking its own block.
  const flush = () => {
    if (run.filter((step) => step.kind === "tool").length >= RUN_MIN) blocks.push({ kind: "run", steps: run });
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

/** One kind of work a call does, as a run's line says it while it runs: once, and `count` times. */
interface Activity {
  readonly key: string;
  readonly doing: (count: number) => string;
}

const counted = (one: string, many: (count: number) => string) => (count: number) => (count === 1 ? one : many(count));

const ACTIVITIES = {
  search: { key: "web-search", doing: () => "searching the web" },
  page: { key: "web-page", doing: counted("reading a page", (n) => `reading ${String(n)} pages`) },
  screenshot: { key: "web-shot", doing: counted("taking a screenshot", (n) => `taking ${String(n)} screenshots`) },
  read: { key: "file-read", doing: counted("reading a file", (n) => `reading ${String(n)} files`) },
  edit: { key: "file-edit", doing: counted("editing a file", (n) => `editing ${String(n)} files`) },
  look: { key: "file-look", doing: () => "looking through files" },
  command: { key: "command", doing: counted("running a command", (n) => `running ${String(n)} commands`) },
  program: { key: "program", doing: counted("running a tool program", (n) => `running ${String(n)} tool programs`) },
  agents: { key: "agents", doing: () => "working with agents" },
  memory: { key: "memory", doing: () => "checking memory" },
  tasks: { key: "tasks", doing: () => "updating the plan" },
  report: { key: "report", doing: () => "reporting back" },
} satisfies Record<string, Activity>;

/** Each kind of work by the name it is looked up by: a file's or the web's operation, or a tool's own name. */
const FILE_ACTIVITY = new Map<string, Activity>([["read", ACTIVITIES.read], ["write", ACTIVITIES.edit], ["edit", ACTIVITIES.edit]]);

const WEB_ACTIVITY = new Map<string, Activity>([["fetch", ACTIVITIES.page], ["screenshot", ACTIVITIES.screenshot]]);

const TOOL_ACTIVITY = new Map<string, Activity>([
  ["shell", ACTIVITIES.command], ["run", ACTIVITIES.command], ["eval", ACTIVITIES.program], ["agents", ACTIVITIES.agents],
  ["memory", ACTIVITIES.memory], ["tasks", ACTIVITIES.tasks], ["report", ACTIVITIES.report],
]);

/** The kind of work a call does; a tool the chat has no words for is used by its own name. */
function activityOf(part: AnyToolPart): Activity {
  const name = getToolName(part);
  const op = v.safeParse(v.object({ op: v.string() }), part.input);
  const said = op.success ? op.output.op : "";

  if (name === "file") return FILE_ACTIVITY.get(said) ?? ACTIVITIES.look;

  if (name === "web") return WEB_ACTIVITY.get(said) ?? ACTIVITIES.search;

  return TOOL_ACTIVITY.get(name) ?? { key: `tool:${name}`, doing: counted(`using ${name}`, (n) => `using ${name} ${String(n)} times`) };
}

/** A run as its line reads: its calls, those that failed, and the two newest kinds of work it does. */
export interface ToolRunSummary {
  readonly calls: number;
  readonly failed: number;
  readonly doing: string;
}

export function toolRunSummary(steps: readonly RunStep[]): ToolRunSummary {
  const calls = steps.flatMap((step) => (step.kind === "tool" ? [step.part] : []));
  const kinds = new Map<string, { activity: Activity; count: number }>();

  // Each kind moves to the end as a call of it comes, so the newest two are the last two.
  for (const call of calls) {
    const activity = activityOf(call);
    const seen = kinds.get(activity.key);

    kinds.delete(activity.key);
    kinds.set(activity.key, { activity, count: (seen?.count ?? 0) + 1 });
  }

  const doing = [...kinds.values()].slice(-2).map(({ activity, count }) => activity.doing(count)).join(" · ");

  return { calls: calls.length, failed: calls.filter(callFailed).length, doing: doing.charAt(0).toUpperCase() + doing.slice(1) };
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
