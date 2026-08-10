// Backend-agnostic head inference loop — the divergent-reasoning-thread run that
// produces a HeadReport. Both backends drive this: the cf-backend's Facet head
// (ExplorationAgent.runAsHead) and the CLI's subprocess head-worker. Previously
// this loop lived only inside the cf Facet; hoisting it here keeps ONE tested
// implementation so a CLI head behaves identically to a DO head.
//
// The backend provides the model + a HeadCapture + its own tool surface (the cf
// head forks its parent workspace's; the CLI head runs in-process over an
// ephemeral scratch). This module owns the record_evidence /
// record_decision accumulator tools, the head system prompt + inherited-context
// messages, the generateText loop (with the abort/step/budget stop condition),
// and the HeadReport assembly (via the shared head-summary helpers).

import { generateText, tool, jsonSchema, type ToolSet, type LanguageModel } from 'ai';
import {
  type HeadInput, type HeadReport, type HeadId,
  type Evidence, type Decision, type ArtifactRef,
  budgetExhausted, MAX_HEAD_STEPS, NOMINAL_STEP_TOKENS,
} from './types.js';
import type { ToolCallRecord } from '../evolution/types.js';
import { nanoid } from '../utils/nanoid.js';
import { extractFinalText, extractHeadSteps, synthesizeHeadSummary } from './head-summary.js';

/**
 * The mutable findings a head accumulates as it runs — evidence/decisions
 * (recorded via the accumulator tools), artifacts + tool calls (recorded by the
 * backend's scratch tools), child head ids (recursive split), and token usage.
 * runHeadInference reads it into the final HeadReport; the backend's tools mutate
 * the SAME instance, so there is one source of truth per head run.
 */
export class HeadCapture {
  readonly evidence: Evidence[] = [];
  readonly decisions: Decision[] = [];
  readonly artifacts: ArtifactRef[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly childHeadIds: HeadId[] = [];
  /** `input`/`output` are gross provider spend (what the cost ledger debits);
   *  `budgetCharged` is the marginal spend the head's budget meters. See
   *  recordStepUsage for why those must be two different numbers. */
  readonly tokenUsage = { input: 0, output: 0, budgetCharged: 0 };
  /** Largest prompt this head has been sent so far; null until its first step. */
  private promptTokens: number | null = null;

  /**
   * Fold one step's provider usage in.
   *
   * A head re-sends its entire accumulated prompt on every step, so charging
   * `inputTokens` per step bills the same prefix again and again: a head spawned
   * from a long parent turn burns its whole ceiling in one to three steps and
   * returns having produced nothing. The budget therefore meters only what the
   * head ADDS — its own output plus the GROWTH of its prompt, i.e. the tool
   * output it pulled in. The inherited context it was handed is a fixed entry
   * cost set by the parent, not work the head chose to do, so it is not charged
   * either; that is what keeps a head's working room independent of how long its
   * parent has been running. Gross spend stays bounded by the step cap, the
   * wall-clock, and the mission governor, which debits the real numbers.
   */
  recordStepUsage(inputTokens: number, outputTokens: number): void {
    this.tokenUsage.input += inputTokens;
    this.tokenUsage.output += outputTokens;
    const growth = this.promptTokens === null ? 0 : Math.max(0, inputTokens - this.promptTokens);
    this.tokenUsage.budgetCharged += outputTokens + growth;
    this.promptTokens = Math.max(this.promptTokens ?? 0, inputTokens);
  }

  recordEvidence(e: Evidence): void { this.evidence.push(e); }
  recordDecision(d: Decision): void { this.decisions.push(d); }
  recordArtifact(a: ArtifactRef): void { this.artifacts.push(a); }
  recordToolCall(name: string, args: Record<string, unknown>, result: string): void {
    this.toolCalls.push({ name, args, result });
  }
}

/** The two accumulator tools every head has — record_evidence / record_decision,
 *  pushing into the shared HeadCapture. Backend scratch tools are merged on top. */
export function buildHeadAccumulatorTools(capture: HeadCapture): ToolSet {
  return {
    record_evidence: tool({
      description:
        "Record a piece of evidence you've gathered. Use this for facts you want surfaced in the merge synthesis.",
      inputSchema: jsonSchema<{ kind: Evidence['kind']; body: string; ref?: string; confidence?: number }>({
        type: 'object', required: ['kind', 'body'],
        properties: {
          kind: { type: 'string', enum: ['tool_output', 'fact', 'citation', 'artifact'] },
          body: { type: 'string' }, ref: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      }),
      execute: async ({ kind, body, ref, confidence }) => {
        const ev: Evidence = { id: `ev-${nanoid(6)}`, kind, body, ref, confidence };
        capture.recordEvidence(ev);
        capture.recordToolCall('record_evidence', { kind, body, ref, confidence }, 'ok');
        return `evidence recorded (id=${ev.id})`;
      },
    }),
    record_decision: tool({
      description: 'Record a decision the head considered.',
      inputSchema: jsonSchema<{ question: string; choice: string; rationale: string; supportingEvidence?: string[] }>({
        type: 'object', required: ['question', 'choice', 'rationale'],
        properties: {
          question: { type: 'string' }, choice: { type: 'string' }, rationale: { type: 'string' },
          supportingEvidence: { type: 'array', items: { type: 'string' } },
        },
      }),
      execute: async ({ question, choice, rationale, supportingEvidence }) => {
        const d: Decision = { question, choice, rationale, supportingEvidence };
        capture.recordDecision(d);
        capture.recordToolCall('record_decision', { question, choice, rationale }, 'ok');
        return 'decision recorded';
      },
    }),
  };
}

/**
 * Decorate a ToolSet so every call lands in the head's HeadCapture.
 *
 * The head tool builders in this module record themselves (they also record
 * artifacts, which only they can classify, and per-tool outcomes only they can
 * name). This wrapper is for the SHARED builtin surface a backend hands a head —
 * `run`, `execute_tools`, `web` know nothing about heads, and without it
 * `HeadReport.toolCalls` (which the journal persists and the no-prose fallback
 * summary reads) would be empty for exactly the tools a head does its real work
 * with. It records the one outcome a generic wrapper honestly knows — resolved
 * or threw — and leaves the full result to `HeadReport.steps`. Do not apply it
 * to a self-recording builder: the call would be recorded twice.
 */
export function withHeadCaptureRecording(tools: ToolSet, capture: HeadCapture): ToolSet {
  const out: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    if (!execute) { out[name] = entry; continue; }
    out[name] = {
      ...entry,
      execute: async (input: unknown, options: never) => {
        const args = (input && typeof input === 'object' ? input : { input }) as Record<string, unknown>;
        try {
          const result = await execute(input as never, options);
          capture.recordToolCall(name, args, 'ok');
          return result;
        } catch (err) {
          capture.recordToolCall(name, args, `error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
    } as ToolSet[string];
  }
  return out;
}

/** The head's system prompt — task framing + the head conventions (record_*,
 *  the forked real runtime, web research, recursive split, isolation). */
const HEAD_PROMPT_TOOL_NAMES = [
  'record_evidence',
  'record_decision',
  'execute_tools',
  'run',
  'web',
  'split_subheads',
] as const;

/** Every tool through which a head can reach a filesystem or run a command. If
 *  it holds none of them, the prompt says so instead of implying it can look
 *  things up. */
const HEAD_WORK_TOOLS = ['execute_tools', 'run'] as const;

function hasHeadTool(tools: ReadonlySet<string>, ...names: readonly string[]): boolean {
  return names.some((name) => tools.has(name));
}

function renderHeadToolConventions(input: HeadInput, availableToolNames?: readonly string[]): string[] {
  const tools = new Set(availableToolNames ?? HEAD_PROMPT_TOOL_NAMES);
  const lines: string[] = ['Conventions:'];
  if (hasHeadTool(tools, 'record_evidence')) {
    lines.push('- record_evidence whenever you learn something worth surfacing in the merge.');
  }
  if (hasHeadTool(tools, 'record_decision')) {
    lines.push('- record_decision when you make a substantive choice the parent might want to reconcile.');
  }
  if (hasHeadTool(tools, 'execute_tools')) {
    lines.push(
      '- execute_tools runs JavaScript against the SAME resources your parent agent has. `workspace.*` file ops address a mount table: '
      + '`/workspace/…` is the parent agent\'s durable workspace (start here — the code and data you were spawned to study usually live there), '
      + '`/sandbox/…` and `/nimbus/…` are live windows into its containers, `/pc/…` is the user\'s machine, and `/local/…` is YOUR private scratch. '
      + 'Mounts are the FILE plane only: run commands through the environment\'s own namespace (`sandbox.*`, `nimbus.*`, `laptop.*`), which takes '
      + 'that environment\'s NATIVE paths, not mount paths. `web.*` and `llm.query` are also in scope.',
    );
  }
  if (hasHeadTool(tools, 'run')) {
    lines.push(
      '- run executes one shell command. Name the runtime: `sandbox` / `nimbus` / `laptop` are the parent agent\'s real environments; '
      + 'the default `workspace` runtime is only YOUR private scratch shell.',
    );
  }
  if (hasHeadTool(tools, 'web')) {
    lines.push('- Loop `web` action=search to gather, then action=fetch to read the promising results; record_evidence each finding worth surfacing.');
  }
  if (hasHeadTool(tools, 'split_subheads')) {
    lines.push('- split_subheads to recursively explore deeper if needed (depth-budgeted).');
  }
  lines.push(
    '- Final text response: 2-4 sentences summarizing what you found + recommending what should happen next.',
    '- Stay focused on YOUR task. Don\'t try to do sibling heads\' work.',
  );
  lines.push('- If you need to share findings but no shared scratch tool exists, put the finding in your final response and record_evidence if available.');
  if (!hasHeadTool(tools, ...HEAD_WORK_TOOLS)) {
    lines.push('- You have no filesystem or command tool in this run: reason from inherited context and the available accumulator tools only.');
  }
  if (!hasHeadTool(tools, 'split_subheads')) {
    lines.push('- Do not propose recursive subheads; split_subheads is not available in this run.');
  }
  return [
    ...lines,
    '',
    `You are ONE OF SEVERAL heads running concurrently against the same agent's resources. When you touch a SHARED MUTABLE resource, isolate yourself so you don't race a sibling: for any git repo, create your own worktree (\`git worktree add ../head-${input.id.slice(0, 8)} <branch>\`) before working; for shared files, write under your own head-namespaced path (\`shared/findings/${input.id}/…\` in the parent workspace). Read-only inspection of shared resources is always fine.`,
  ];
}

export function buildHeadSystemPrompt(input: HeadInput, availableToolNames?: readonly string[]): string {
  return [
    `You are a "head" — one of several parallel reasoning threads in a self-evolving agent runtime.`,
    ``,
    `Your task: ${input.task}`,
    `Why you were spawned: ${input.rationale}`,
    `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
    ``,
    ...renderHeadToolConventions(input, availableToolNames),
    ``,
    `Budget: depth ${input.budget.maxDepth}, ${input.budget.maxTokens} tokens, ${input.budget.maxWallClockMs}ms wall-clock.`,
  ].join('\n');
}

/** The head's opening message — the inherited conversation + its assigned task. */
export function buildHeadMessages(input: HeadInput): Array<{ role: 'user' | 'assistant'; content: string }> {
  const lines: string[] = ['Here is the conversation you inherit:', ''];
  for (const m of input.inheritedContext) {
    const trimmed = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content;
    lines.push(`[${m.role}${m.toolName ? `/${m.toolName}` : ''}] ${trimmed}`);
  }
  lines.push('', `Now focus on your assigned task: ${input.task}`);
  return [{ role: 'user', content: lines.join('\n') }];
}

/**
 * The summary of a head that did NOT run to completion.
 *
 * Deliberately ignores the head's last text. That text is a mid-flight thought,
 * not a conclusion, and reporting it as the head's finding is how a starved
 * head's speculation reached its parent as fact — a real run told its parent
 * "the immediate blockage is the sandbox provisioning failure" when both heads
 * had simply run out of budget. A stopped head reports its status and only what
 * it actually banked.
 */
function incompleteHeadSummary(
  input: HeadInput,
  status: HeadReport['status'],
  capture: HeadCapture,
  abortReason: string | null,
): string {
  const recorded = synthesizeHeadSummary({
    decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls,
  });
  return `Head ${input.id} did not complete (status=${status}${abortReason ? `; ${abortReason}` : ''}). `
    + (recorded ? `What it recorded before stopping: ${recorded}` : 'It produced no findings.');
}

export interface HeadInferenceDeps {
  /** The LanguageModel this head reasons with (per-head model override applied upstream). */
  model: LanguageModel;
  /** The head's FULL toolset — the accumulator tools (buildHeadAccumulatorTools)
   *  + the backend's scratch tools (sandbox/shared/split). The caller assembles
   *  (and may filter) it so each backend keeps control over its allowed surface. */
  tools: ToolSet;
  /** Shared findings accumulator — the tools mutate this same instance. */
  capture: HeadCapture;
  /** Polled in stopWhen + read for the final status. */
  isAborted: () => boolean;
  /** Abort reason, surfaced in errorMessage. */
  abortReason?: () => string | null;
}

/**
 * Run one head's inference loop and assemble its HeadReport. A multi-step
 * generateText run that stops on abort, the derived step cap, or budget
 * exhaustion; the final text (last text-bearing step) becomes the summary, with
 * a recorded-findings fallback. Never throws — failures become an `errored`
 * report (the controller treats a thrown run() as budget_exceeded anyway).
 */
export async function runHeadInference(input: HeadInput, deps: HeadInferenceDeps): Promise<HeadReport> {
  const { capture } = deps;
  const startedAt = Date.now();
  const maxSteps = Math.min(MAX_HEAD_STEPS, Math.max(1, Math.floor(input.budget.maxTokens / NOMINAL_STEP_TOKENS)));

  // Gross spend — what the report carries and the cost ledger debits. The budget
  // gate below reads `budgetCharged` instead (see HeadCapture.recordStepUsage).
  const usageTotal = () => ({
    input: capture.tokenUsage.input,
    output: capture.tokenUsage.output,
    total: capture.tokenUsage.input + capture.tokenUsage.output,
  });

  try {
    const result = await generateText({
      model: deps.model,
      system: buildHeadSystemPrompt(input, Object.keys(deps.tools)),
      messages: buildHeadMessages(input),
      tools: deps.tools,
      // Accumulate usage as each step finishes — fires before stopWhen is
      // evaluated — so the token ceiling can gate the run mid-flight rather
      // than only being noticed once the whole loop is done (THINKING-AUDIT §4 #7).
      onStepFinish: (step) => {
        const u = (step as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
        if (u) capture.recordStepUsage(u.inputTokens ?? 0, u.outputTokens ?? 0);
      },
      stopWhen: ({ steps }) => {
        if (deps.isAborted()) return true;
        if (steps.length >= maxSteps) return true;
        if (budgetExhausted(input.budget, capture.tokenUsage.budgetCharged).exhausted) return true;
        return false;
      },
    });

    const status: HeadReport['status'] = deps.isAborted()
      ? 'aborted'
      : budgetExhausted(input.budget, capture.tokenUsage.budgetCharged).exhausted ? 'budget_exceeded' : 'completed';
    const abortReason = deps.abortReason?.() ?? null;
    const summary = status === 'completed'
      ? (extractFinalText(result)
        || synthesizeHeadSummary({ decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls })
        || `Head ${input.id} completed without producing a textual summary.`)
      : incompleteHeadSummary(input, status, capture, abortReason);

    return {
      id: input.id, status, summary,
      evidence: [...capture.evidence],
      decisions: [...capture.decisions],
      artifactRefs: [...capture.artifacts],
      childHeadIds: [...capture.childHeadIds],
      toolCalls: [...capture.toolCalls],
      steps: extractHeadSteps(result.steps),
      tokenUsage: usageTotal(),
      wallClockMs: Date.now() - startedAt,
      errorMessage: abortReason ?? undefined,
    };
  } catch (err) {
    return {
      id: input.id, status: 'errored',
      summary: `Head ${input.id} errored: ${err instanceof Error ? err.message : String(err)}`,
      evidence: [...capture.evidence],
      decisions: [...capture.decisions],
      artifactRefs: [...capture.artifacts],
      childHeadIds: [...capture.childHeadIds],
      toolCalls: [...capture.toolCalls],
      steps: [],
      tokenUsage: usageTotal(),
      wallClockMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
