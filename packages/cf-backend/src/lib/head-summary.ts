// Pure helpers for building a head's report summary — extracted from
// ExplorationAgent.runAsHead so the capture logic is unit-testable.
//
// The bug they fix: ai-SDK v6 `result.text` returns only the LAST step's text,
// and a generative head almost always ends on a tool-call / reasoning turn —
// so reading `result.text` alone yielded an empty per-head merge summary.

interface StepLike { text?: string }
interface ResultLike { text?: string; reasoningText?: string; steps?: ReadonlyArray<StepLike> }

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
