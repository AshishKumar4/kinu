// Pure helpers for building a head's report summary — extracted from
// ExplorationAgent.runAsHead so the capture logic is unit-testable.
//
// The bug they fix: ai-SDK v6 `result.text` returns only the LAST step's text,
// and a generative head almost always ends on a tool-call / reasoning turn —
// so reading `result.text` alone yielded an empty per-head merge summary.

import type { HeadStep } from "@proteus/core";

interface StepLike { text?: string }
interface ResultLike { text?: string; reasoningText?: string; steps?: ReadonlyArray<StepLike> }

/** ai-SDK v6 step shape we read for the trace. toolCalls carry `.input`, their
 *  results carry `.output`, matched by `toolCallId`. */
interface ToolCallLike { toolName?: string; name?: string; input?: unknown; toolCallId?: string }
interface ToolResultLike { toolName?: string; output?: unknown; result?: unknown; toolCallId?: string }
interface TraceStepLike {
  text?: string;
  reasoningText?: string;
  toolCalls?: ReadonlyArray<ToolCallLike>;
  toolResults?: ReadonlyArray<ToolResultLike>;
}

const DIGEST_LIMIT = 800;

/** Truncate a digested value so a single step can't bloat the trace store. */
function digest(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.length > DIGEST_LIMIT ? value.slice(0, DIGEST_LIMIT) + "…" : value;
  try {
    const s = JSON.stringify(value);
    if (s.length <= DIGEST_LIMIT) return value;
    return s.slice(0, DIGEST_LIMIT) + "…";
  } catch { return String(value).slice(0, DIGEST_LIMIT); }
}

/** Walk ai-SDK v6 `result.steps` into the ordered head trace: each step's prose,
 *  reasoning, and tool calls (input matched with its output by toolCallId).
 *  Steps with no text, reasoning, or tool calls are dropped (empty padding). */
export function extractHeadSteps(steps: ReadonlyArray<TraceStepLike> | undefined): HeadStep[] {
  if (!steps?.length) return [];
  const out: HeadStep[] = [];
  for (const step of steps) {
    const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const results = Array.isArray(step.toolResults) ? step.toolResults : [];
    const toolCalls = calls.map((c, i) => {
      const match = c.toolCallId
        ? results.find((r) => r.toolCallId === c.toolCallId)
        : results[i];
      const output = match?.output ?? match?.result;
      return {
        name: String(c.toolName ?? c.name ?? "?"),
        input: digest(c.input),
        output: output === undefined ? undefined : digest(output),
      };
    });
    const text = step.text?.trim() ?? "";
    const reasoning = step.reasoningText?.trim() || undefined;
    if (!text && !reasoning && toolCalls.length === 0) continue;
    out.push({ text, reasoning, toolCalls });
  }
  return out;
}

/** The head's real final answer: the last text-bearing step (not just the last
 *  step), falling back to the model's reasoning text. */
export function extractFinalText(result: ResultLike): string {
  const direct = result.text?.trim();
  if (direct) return direct;
  const steps = result.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]?.text?.trim();
    if (t) return t;
  }
  return result.reasoningText?.trim() ?? "";
}

/** When a head produced no prose turn, synthesize a summary from what it
 *  actually recorded (decisions / evidence / tool calls). Returns null when the
 *  head recorded nothing at all. */
export function synthesizeHeadSummary(opts: {
  decisions: ReadonlyArray<{ question: string; choice: string }>;
  evidence: ReadonlyArray<{ body: string }>;
  toolCalls: ReadonlyArray<{ name: string }>;
}): string | null {
  const parts: string[] = [];
  if (opts.decisions.length) {
    parts.push("Decisions: " + opts.decisions.map((d) => `${d.question} → ${d.choice}`).join("; "));
  }
  if (opts.evidence.length) {
    parts.push("Findings: " + opts.evidence.slice(0, 6).map((e) => e.body).join(" | "));
  }
  if (!parts.length && opts.toolCalls.length) {
    parts.push(`Ran ${opts.toolCalls.length} tool call(s): ` + opts.toolCalls.slice(0, 8).map((t) => t.name).join(", "));
  }
  return parts.length ? parts.join(". ").slice(0, 1500) : null;
}
