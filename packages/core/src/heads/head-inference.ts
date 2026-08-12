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
  budgetExhausted,
} from './types.js';
import type { ToolCallRecord } from '../evolution/types.js';
import { missionCallUsage, type MissionBudgetRefusal, type MissionScope } from '../mission-budget.js';
import { nanoid } from '../utils/nanoid.js';
import { extractFinalText, extractHeadSteps, synthesizeHeadSummary } from './head-summary.js';
import { HeadFileChanges } from './file-changes.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';

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
  /** What this head changed on the shared file planes. The backend installs it
   *  on the head's own CompositeVFS (`observeWrites`) when it builds the head's
   *  runtime; unwired, it simply stays empty. */
  readonly files = new HeadFileChanges();
  /** Gross provider spend — what the report carries and the mission budget
   *  governor debits. Nothing meters a head against a private ceiling, so this
   *  is the only token figure there is. */
  readonly tokenUsage = { input: 0, output: 0 };

  recordStepUsage(inputTokens: number, outputTokens: number): void {
    this.tokenUsage.input += inputTokens;
    this.tokenUsage.output += outputTokens;
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
  'file',
  'web',
  'split_subheads',
] as const;

/** Every tool through which a head can reach a filesystem or run a command. If
 *  it holds none of them, the prompt says so instead of implying it can look
 *  things up. */
const HEAD_WORK_TOOLS = ['execute_tools', 'run', 'file'] as const;

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
      + '`/parent/…` is the parent agent\'s durable workspace (start here — the code and data you were spawned to study usually live there), '
      + '`/sandbox/…` and `/nimbus/…` are live windows into its containers, `/pc/…` is the user\'s machine, and `/local/…` is YOUR private scratch. '
      + 'Mounts are the FILE plane only: run commands through the environment\'s own namespace (`sandbox.*`, `nimbus.*`, `laptop.*`), which takes '
      + 'that environment\'s NATIVE paths, not mount paths. `web.*` and `llm.query` are also in scope.',
    );
  }
  if (hasHeadTool(tools, 'run')) {
    lines.push(
      '- run executes one shell command. Name the runtime: `sandbox` / `nimbus` / `laptop` are the parent agent\'s real environments. '
      + 'The `workspace` runtime is a DIFFERENT thing from the `/parent` mount above — it is only YOUR OWN empty scratch shell, never the parent\'s files, '
      + 'and it runs no real binaries; a `/parent/…` or `/sandbox/…` path means nothing there.',
    );
  }
  if (hasHeadTool(tools, 'file')) {
    lines.push(
      '- file reads and edits over that same mount table. Read a file before you edit or overwrite it, and edit by replacing exact text you copied out of the read '
      + 'rather than rewriting the file or shelling out to sed.',
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
    input.budget.maxWallClockMs === undefined
      ? `Take the time the task needs — there is no time or token limit on this run. You may split ${input.budget.maxDepth} more level(s) deep.`
      : `Deadline: ${input.budget.maxWallClockMs}ms wall-clock (the caller asked for one). You may split ${input.budget.maxDepth} more level(s) deep.`,
  ].join('\n');
}

/** The head's opening message — the inherited conversation + its assigned task. */
export function buildHeadMessages(input: HeadInput): Array<{ role: 'user' | 'assistant'; content: string }> {
  const lines: string[] = ['Here is the conversation you inherit:', ''];
  for (const m of input.inheritedContext) {
    lines.push(`[${m.role}${m.toolName ? `/${m.toolName}` : ''}] ${evidenceWindow(m.content, EVIDENCE_BUDGETS.inheritedMessage)}`);
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

/**
 * The report of a head the mission governor stopped.
 *
 * Deliberately the same shape as any other incomplete head — its findings, its
 * status, and no mid-flight speculation dressed up as a conclusion — with the
 * refusal's own words as the reason, so the parent's merge can say which budget
 * ran out rather than reporting an unexplained short run.
 */
function exhaustedMissionReport(
  input: HeadInput,
  capture: HeadCapture,
  refusal: MissionBudgetRefusal,
  wallClockMs: number,
  steps: Parameters<typeof extractHeadSteps>[0] = [],
): HeadReport {
  return {
    id: input.id,
    status: 'budget_exceeded',
    summary: incompleteHeadSummary(input, 'budget_exceeded', capture, refusal.note),
    evidence: [...capture.evidence],
    decisions: [...capture.decisions],
    artifactRefs: [...capture.artifacts],
    fileChanges: capture.files.snapshot(),
    childHeadIds: [...capture.childHeadIds],
    toolCalls: [...capture.toolCalls],
    steps: extractHeadSteps(steps),
    tokenUsage: {
      input: capture.tokenUsage.input,
      output: capture.tokenUsage.output,
      total: capture.tokenUsage.input + capture.tokenUsage.output,
    },
    wallClockMs,
    errorMessage: refusal.note,
  };
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
  /**
   * The step envelope of the turn this head forked, supplied by the backend
   * because only the backend can read the host setting (`PROTEUS_MAX_STEPS`;
   * core owns the parser, see resolveMaxSteps). A head is its parent running on
   * the same workspace, so it gets its parent's envelope — not a smaller one
   * derived from a private token pool.
   */
  maxSteps: number;
  /** Polled in stopWhen + read for the final status. */
  isAborted: () => boolean;
  /** Abort reason, surfaced in errorMessage. */
  abortReason?: () => string | null;
  /**
   * The mission ledger this head charges, when it runs under one.
   *
   * The head's own envelope has no token dimension on purpose — a fork gets its
   * parent's room — so this is the ONLY thing that can stop a head for spending
   * too much, and it stops it only where a budget was declared. Omitted is the
   * default and the loop then never asks: an undeclared run must not touch the
   * table.
   *
   * The backend builds it from {@link HeadInput.missionLabels}: in-process over
   * the governor itself, out-of-process over an RPC to whoever holds the ledger.
   */
  mission?: MissionScope;
}

/**
 * Run one head's inference loop and assemble its HeadReport. A multi-step
 * generateText run that stops on abort, on the parent turn's step envelope, or
 * on a caller-requested deadline; the final text (last text-bearing step)
 * becomes the summary, with a recorded-findings fallback. Never throws —
 * failures become an `errored` report (the controller treats a thrown run() as
 * budget_exceeded anyway).
 */
export async function runHeadInference(input: HeadInput, deps: HeadInferenceDeps): Promise<HeadReport> {
  const { capture, maxSteps, mission } = deps;
  const startedAt = Date.now();

  const usageTotal = () => ({
    input: capture.tokenUsage.input,
    output: capture.tokenUsage.output,
    total: capture.tokenUsage.input + capture.tokenUsage.output,
  });

  // The mission refusal that stopped this head, if one did. Held so the report
  // says which budget ran out rather than reporting a bare stop.
  let refusal: MissionBudgetRefusal | null = null;
  /** Ask the ledger for room. Never called for an unbudgeted run: `mission` is
   *  built only from a non-empty label set, so there is nothing to ask. */
  const outOfBudget = async (): Promise<boolean> => {
    if (!mission || refusal) return refusal !== null;
    refusal = await mission.port.guard('model_call', mission.labels);
    return refusal !== null;
  };

  try {
    // Before the first call as well as between steps: a head spawned into an
    // already-spent mission must not get one free inference out of it.
    if (await outOfBudget()) {
      return exhaustedMissionReport(input, capture, refusal!, Date.now() - startedAt);
    }
    const result = await generateText({
      model: deps.model,
      system: buildHeadSystemPrompt(input, Object.keys(deps.tools)),
      messages: buildHeadMessages(input),
      tools: deps.tools,
      onStepFinish: async (step) => {
        const usage = missionCallUsage(step.usage);
        if (!usage) return;
        capture.recordStepUsage(usage.input, usage.output);
        // Charged per step, from the provider's own report, so the ledger is
        // current when the guard below reads it — rather than one lump debit
        // after the whole fork has already been paid for.
        await mission?.port.debit(usage.input + usage.output, {
          labels: mission.labels, calls: 1, usage,
        });
      },
      stopWhen: async ({ steps }) => {
        if (deps.isAborted()) return true;
        if (steps.length >= maxSteps) return true;
        if (budgetExhausted(input.budget).exhausted) return true;
        return outOfBudget();
      },
    });

    if (refusal) {
      return exhaustedMissionReport(input, capture, refusal, Date.now() - startedAt, result.steps);
    }
    const budgetGate = budgetExhausted(input.budget);
    // A run that used the whole step envelope without the model ever choosing to
    // stop was cut off mid-flight — reporting it 'completed' would hand the
    // parent a mid-flight thought as a finished answer, the exact fabrication
    // incompleteHeadSummary exists to prevent.
    const ranOutOfSteps = result.steps.length >= maxSteps && result.finishReason !== 'stop';
    const status: HeadReport['status'] = deps.isAborted()
      ? 'aborted'
      : budgetGate.exhausted || ranOutOfSteps ? 'budget_exceeded' : 'completed';
    const stopReason = deps.abortReason?.()
      ?? (budgetGate.exhausted
        ? `${budgetGate.reason} budget exhausted`
        : ranOutOfSteps ? `reached the turn step envelope (${maxSteps} steps) without finishing` : null);
    const summary = status === 'completed'
      ? (extractFinalText(result)
        || synthesizeHeadSummary({ decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls })
        || `Head ${input.id} completed without producing a textual summary.`)
      : incompleteHeadSummary(input, status, capture, stopReason);

    return {
      id: input.id, status, summary,
      evidence: [...capture.evidence],
      decisions: [...capture.decisions],
      artifactRefs: [...capture.artifacts],
      fileChanges: capture.files.snapshot(),
      childHeadIds: [...capture.childHeadIds],
      toolCalls: [...capture.toolCalls],
      steps: extractHeadSteps(result.steps),
      tokenUsage: usageTotal(),
      wallClockMs: Date.now() - startedAt,
      errorMessage: status === 'completed' ? undefined : stopReason ?? undefined,
    };
  } catch (err) {
    return {
      id: input.id, status: 'errored',
      summary: `Head ${input.id} errored: ${err instanceof Error ? err.message : String(err)}`,
      evidence: [...capture.evidence],
      decisions: [...capture.decisions],
      artifactRefs: [...capture.artifacts],
      fileChanges: capture.files.snapshot(),
      childHeadIds: [...capture.childHeadIds],
      toolCalls: [...capture.toolCalls],
      steps: [],
      tokenUsage: usageTotal(),
      wallClockMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
