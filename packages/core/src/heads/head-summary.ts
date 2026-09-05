// Pure helpers for building a head's report summary — extracted from
// SubordinateAgent.runAsHead so the capture logic is unit-testable and shared
// by both backends (the cf Facet head + the CLI subprocess head).
//
// The bug they fix: ai-SDK v6 `result.text` returns only the LAST step's text,
// and a generative head almost always ends on a tool-call / reasoning turn —
// so reading `result.text` alone yielded an empty per-head merge summary.

import { digestJsonValue } from '../utils/json';
import type { HeadReport, HeadStep } from "./types";

/**
 * Did this head bank anything a merge may cite?
 *
 * The distinction the merge path must never blur. A head that STOPPED — budget,
 * abort, error — without recording evidence, a decision, or an artifact learned
 * nothing, and its silence is not a finding about the task or the environment.
 * A completed head answered, and its summary is that answer. Tool calls alone
 * are activity, not findings. One predicate so the merge prompt, the merge
 * narrative, and the cost summary can never disagree about which is which.
 */
export function headProducedFindings(
  r: Pick<HeadReport, "status" | "evidence" | "decisions" | "artifactRefs">,
): boolean {
  if (r.status === "completed") return true;
  return r.evidence.length > 0 || r.decisions.length > 0 || r.artifactRefs.length > 0;
}

interface StepLike { text?: string }
interface ResultLike { text?: string; reasoningText?: string; steps?: ReadonlyArray<StepLike> }

/** ai-SDK v6 step shape we read for the trace. toolCalls carry `.input`, their
 *  results carry `.output`, matched by `toolCallId`. */
interface ToolCallLike { toolName?: string; name?: string; input?: unknown; toolCallId?: string }
interface ToolResultLike { toolName?: string; output?: unknown; result?: unknown; toolCallId?: string }
export interface TraceStepLike {
  text?: string;
  reasoningText?: string;
  toolCalls?: ReadonlyArray<ToolCallLike>;
  toolResults?: ReadonlyArray<ToolResultLike>;
}


/**
 * One ai-SDK v6 step as the head's trace row: its prose, its reasoning, and its
 * tool calls (input matched with its output by toolCallId). Null for a step
 * that carries none of the three — empty padding the trace should not show.
 *
 * Per step, not per run, because the trace is written AS the head runs: the
 * head hands each finished step to its journal, so a fork that is still
 * thinking already has a readable trace. A whole-run walk would only ever run
 * after the report, which is the state the Exploration surface used to be
 * stuck in.
 */
export function toHeadStep(step: TraceStepLike): HeadStep | null {
  const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  const results = Array.isArray(step.toolResults) ? step.toolResults : [];
  const toolCalls = calls.map((c, i) => {
    const match = c.toolCallId
      ? results.find((r) => r.toolCallId === c.toolCallId)
      : results[i];
    const output = match?.output ?? match?.result;
    return {
      name: String(c.toolName ?? c.name ?? "?"),
      input: digestJsonValue({ value: c.input }),
      output: output === undefined ? undefined : digestJsonValue({ value: output }),
    };
  });
  const text = step.text?.trim() ?? "";
  const reasoning = step.reasoningText?.trim() || undefined;
  if (!text && !reasoning && toolCalls.length === 0) return null;
  return { text, reasoning, toolCalls };
}

/**
 * The whole run's trace, for a reader that has a finished result rather than
 * a live head: every step that carried prose, reasoning or a tool call, in
 * order. `toHeadStep` is the live path and this is the retrospective one, so
 * a report reconstructed after the fact reads the same as one streamed.
 */
export function extractHeadSteps(steps?: ReadonlyArray<TraceStepLike>): HeadStep[] {
  if (!Array.isArray(steps)) return [];
  const trace: HeadStep[] = [];
  for (const step of steps) {
    const row = toHeadStep(step);
    if (row) trace.push(row);
  }
  return trace;
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
