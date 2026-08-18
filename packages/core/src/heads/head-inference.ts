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

import {
  generateText, tool, jsonSchema,
  type ToolSet, type LanguageModel, type ModelMessage,
} from 'ai';
import {
  type HeadInput, type HeadReport, type HeadId, type HeadStep, type SerializedMessage,
  type Evidence, type Decision, type ArtifactRef,
  budgetExhausted,
} from './types.js';
import type { ToolCallRecord } from '../evolution/types.js';
import type { MissionBudgetRefusal, MissionScope } from '../mission-budget.js';
import { addUsage, normalizeUsage, usageReported, usageTotal, type Usage } from '../usage.js';
import { nanoid } from '../utils/nanoid.js';
import { extractFinalText, synthesizeHeadSummary, toHeadStep } from './head-summary.js';
import { HeadFileChanges } from './file-changes.js';
import { isJsonObject, projectJsonValue, type JsonObject } from '../utils/json.js';
import { diagnostics, toProteusError } from '../obs/index.js';

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
   *  on the head's own view of its parent (`observeWrites`) when it builds the head's
   *  runtime; unwired, it simply stays empty. */
  readonly files = new HeadFileChanges();
  /** Gross provider spend — what the report carries and the mission budget
   *  governor debits. Nothing meters a head against a private ceiling, so this
   *  is the only token figure there is. Starts as `{}`: a head whose provider
   *  never reported reports nothing, rather than a run of zeros. */
  usage: Usage = {};

  /** Accumulate one step's report. Takes a whole {@link Usage} rather than bare
   *  counts so a field the provider omitted stays omitted here — the boundary
   *  where absence used to be flattened into 0 before it ever reached the
   *  report. */
  recordStepUsage(usage: Usage): void {
    this.usage = addUsage(this.usage, usage);
  }

  recordEvidence(e: Evidence): void { this.evidence.push(e); }
  recordDecision(d: Decision): void { this.decisions.push(d); }
  recordArtifact(a: ArtifactRef): void { this.artifacts.push(a); }
  recordToolCall(name: string, args: JsonObject, result: string): void {
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
        const args: JsonObject = { kind, body };
        if (ref !== undefined) args.ref = ref;
        if (confidence !== undefined) args.confidence = confidence;
        capture.recordToolCall('record_evidence', args, 'ok');
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
    out[name] = recordingTool(name, entry, capture);
  }
  return out;
}

function recordingTool<Entry extends ToolSet[string]>(
  name: string,
  entry: Entry,
  capture: HeadCapture,
): Entry {
  const execute = entry.execute;
  if (!execute) return entry;
  return Object.assign({}, entry, {
    execute: async (input: never, options: never) => {
      const value = projectJsonValue({ value: input });
      const args: JsonObject = isJsonObject(value) ? value : { input: value };
      try {
        const result = await execute(input, options);
        capture.recordToolCall(name, args, 'ok');
        return result;
      } catch (err) {
        capture.recordToolCall(name, args, `error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  });
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
export type HeadWorkspaceLayout = 'shared-workspace' | 'private-scratch';

function hasHeadTool(tools: ReadonlySet<string>, ...names: readonly string[]): boolean {
  return names.some((name) => tools.has(name));
}

function renderHeadToolConventions(
  input: HeadInput,
  workspaceLayout: HeadWorkspaceLayout,
  availableToolNames?: readonly string[],
): string[] {
  const tools = new Set(availableToolNames ?? HEAD_PROMPT_TOOL_NAMES);
  const lines: string[] = ['Conventions:'];
  if (hasHeadTool(tools, 'record_evidence')) {
    lines.push('- record_evidence whenever you learn something worth surfacing in the merge.');
  }
  if (hasHeadTool(tools, 'record_decision')) {
    lines.push('- record_decision when you make a substantive choice the parent might want to reconcile.');
  }
  if (hasHeadTool(tools, 'execute_tools')) {
    const executionDoctrine = workspaceLayout === 'shared-workspace'
      ? '- execute_tools runs JavaScript against the SAME resources your parent agent has. Each environment is its own filesystem in its own paths: '
        + '`workspace.*` is the canonical workspace you were forked from (start there — the code and data you were spawned to study usually live in it), '
        + '`sandbox.*` is its container, and `laptop.*` is the user\'s machine. '
        + '`workspace.exec` runs a real shell in the workspace, so `grep -rn X .` searches it in one call. '
        + '`web.*` and `llm.query` are also in scope.'
      : '- execute_tools runs JavaScript across the environments exposed to this local head: '
        + '`workspace.*` is your private scratch, `parent.*` is the canonical parent workspace containing the task\'s code and data, '
        + 'and `laptop.*` is the user\'s machine. Start with `parent.*` for project work; use `workspace.*` only for private scratch. '
        + '`web.*` and `llm.query` are also in scope.';
    lines.push(
      executionDoctrine,
      ...(input.mode === 'plan'
        ? ['- This is a Plan research head: use execute_tools only for read-only inspection. Do not call mutating workspace, process, port, release, or deployment operations.']
        : []),
    );
  }
  if (hasHeadTool(tools, 'run')) {
    const runDoctrine = workspaceLayout === 'shared-workspace'
      ? '- run executes one shell command. Name the runtime: `sandbox` / `laptop` are the parent agent\'s separate environments, '
        + 'and the default `workspace` runtime is the canonical workspace you were forked from.'
      : '- run executes one shell command. The runtime `parent` is the canonical parent workspace, the default `workspace` runtime is private scratch, '
        + 'and runtime `laptop` is the user\'s machine.';
    lines.push(
      runDoctrine,
      ...(input.mode === 'plan'
        ? ['- In Plan mode, run only read-only inspection commands. Do not install, write, launch servers, expose ports, or change system state.']
        : []),
    );
  }
  if (hasHeadTool(tools, 'file')) {
    const filePlane = workspaceLayout === 'shared-workspace'
      ? 'the canonical workspace filesystem'
      : 'your private scratch filesystem; use parent.* inside execute_tools for the canonical parent workspace';
    lines.push(input.mode === 'plan'
      ? `- file is available for reading ${filePlane}. Do not edit, write, or delete files in Plan mode.`
      : `- file reads and edits ${filePlane}. Read a file before you edit or overwrite it, and edit by replacing exact text you copied out of the read `
        + 'rather than rewriting the file or shelling out to sed.');
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
    input.mode === 'plan'
      ? 'You are ONE OF SEVERAL Plan research heads with read access to the parent workspace. Inspect it read-only, do not create scratch files or worktrees, and return evidence and recommendations to the parent plan.'
      : workspaceLayout === 'shared-workspace'
        ? `You are ONE OF SEVERAL heads running concurrently against the same agent's resources. When you touch a SHARED MUTABLE resource, isolate yourself so you don't race a sibling: for any git repo, create your own worktree (\`git worktree add ../head-${input.id.slice(0, 8)} <branch>\`) before working; for shared files, write under your own head-namespaced path (\`shared/findings/${input.id}/…\` in the parent workspace). Read-only inspection of shared resources is always fine.`
        : `Your workspace and file tools are private scratch. The canonical parent workspace exposed through parent.* is shared with sibling heads; isolate any mutation there (for a git repo, create a worktree such as \`git worktree add ../head-${input.id.slice(0, 8)} <branch>\`). Read-only inspection is always fine.`,
  ];
}

export function buildHeadSystemPrompt(
  input: HeadInput,
  availableToolNames?: readonly string[],
  workspaceLayout: HeadWorkspaceLayout = 'shared-workspace',
): string {
  return [
    `You are a "head" — one of several parallel reasoning threads in a self-evolving agent runtime.`,
    ``,
    `Your task: ${input.task}`,
    `Why you were spawned: ${input.rationale}`,
    `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
    ``,
    ...renderHeadToolConventions(input, workspaceLayout, availableToolNames),
    ``,
    // The depth clause is dropped rather than reading "you may split 0 more
    // level(s)": at zero the tool is not on the surface at all (head-tools.ts),
    // and the conventions above already say so.
    (input.budget.maxWallClockMs === undefined
      ? 'Take the time the task needs — there is no time or token limit on this run.'
      : `Deadline: ${input.budget.maxWallClockMs}ms wall-clock (the caller asked for one).`)
    + (input.budget.maxDepth > 0 ? ` You may split ${input.budget.maxDepth} more level(s) deep.` : ''),
  ].join('\n');
}

/**
 * The head's conversation — the inherited messages, structurally, then its task.
 *
 * A head used to receive its whole inheritance flattened into ONE user message
 * of `[role/toolName] text` prose lines, while a SubordinateAgent received real
 * structured messages. That asymmetry is why a fork could not be watched the
 * way a subordinate can: there was no per-message structure left to render, so
 * clicking into a fork showed a wall of prose instead of a conversation. One
 * inherited message becomes one ModelMessage here, carrying its own role.
 *
 * No re-windowing: `inheritedContext` arrives already capped per message at
 * EVIDENCE_BUDGETS.inheritedMessage by orchestrator/heads-support.ts, which is
 * the single place that policy lives.
 */
export function buildHeadMessages(input: HeadInput): ModelMessage[] {
  return [
    ...input.inheritedContext.map(inheritedAsModelMessage),
    // Last, so the assigned task is the live instruction rather than one more
    // turn of history the model has to rank against the rest.
    { role: 'user', content: `Now focus on your assigned task: ${input.task}` },
  ];
}

/**
 * One inherited message as a ModelMessage the provider will accept standalone.
 *
 * 'user' and 'assistant' pass through — that is the whole point, and the SDK is
 * fine with consecutive same-role messages, so nothing is merged.
 *
 * The other two roles are remapped deliberately, and both remaps keep the
 * message's identity in its text rather than dropping it:
 *
 *   - 'tool' CANNOT be emitted as a role:'tool' ModelMessage. The SDK requires
 *     a matching preceding assistant tool-call part with the same toolCallId,
 *     and a SerializedMessage carries only a toolName and a text body — there
 *     is no id to match, and inventing one makes every head request malformed
 *     at the provider. It becomes a user message that names the producing tool.
 *
 *   - 'system' would otherwise become a second system prompt competing with
 *     buildHeadSystemPrompt for authority over how the head behaves. Inherited
 *     system entries are narration about the conversation (the omission
 *     disclosure from inheritedContextOmissionNote is the one the runtime
 *     actually produces), not instructions to the head, so they are reported to
 *     the head as a user message instead of issued to it as policy.
 */
function inheritedAsModelMessage(m: SerializedMessage): ModelMessage {
  switch (m.role) {
    case 'user':
    case 'assistant':
      return { role: m.role, content: m.content };
    case 'tool':
      return { role: 'user', content: `[inherited tool result${m.toolName ? ` from ${m.toolName}` : ''}]\n${m.content}` };
    case 'system':
      return { role: 'user', content: `[inherited system note]\n${m.content}` };
  }
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
  stepCount = 0,
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
    stepCount,
    usage: capture.usage,
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
  /** The backend's actual file topology. The prompt must name the same plane
   * the tools reach; local heads have private scratch plus parent.*, while
   * hosted heads operate directly on the shared canonical workspace. */
  workspaceLayout: HeadWorkspaceLayout;
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
  /**
   * Where each finished step is recorded, while the head is still running.
   *
   * This is the head's whole observability story and the ONLY writer of its
   * trace — the report carries a count, not the rows. A fork is not an actor:
   * it has no chat, no run-event recorder and no socket a surface can watch, so
   * the ordered trace it pushes here is the one thing that makes a running
   * branch legible.
   *
   * The sink is the journal holding this head's own row, which is whoever
   * spawned it. Omitted only for a recursive sub-head on the hosted backend:
   * its spawner is another facet whose journal is that facet's private storage
   * and is not addressable from the child — the same reason a sub-head has
   * never appeared on the Exploration surface at all.
   */
  reportStep?: (seq: number, step: HeadStep) => Promise<void> | void;
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

  // Steps recorded so far — the trace's dense sequence and the report's count.
  // A step with no prose, reasoning or tool call is padding and is not recorded,
  // exactly as the whole-run walk used to drop it.
  let recorded = 0;

  try {
    // Before the first call as well as between steps: a head spawned into an
    // already-spent mission must not get one free inference out of it.
    if (await outOfBudget()) {
      return exhaustedMissionReport(input, capture, refusal!, Date.now() - startedAt);
    }
    const result = await generateText({
      model: deps.model,
      system: buildHeadSystemPrompt(input, Object.keys(deps.tools), deps.workspaceLayout),
      messages: buildHeadMessages(input),
      tools: deps.tools,
      onStepFinish: async (step) => {
        const traced = toHeadStep(step);
        if (traced) {
          const seq = recorded++;
          // A failed trace write must not kill the work it was watching — the
          // sink can be an RPC to another Durable Object. Same treatment the
          // actor gives its own step events.
          try {
            await deps.reportStep?.(seq, traced);
          } catch (err) {
            diagnostics.failure(
              'head.step_trace_failed',
              toProteusError({ doing: 'record a head step trace', cause: err, otherwise: 'io' }),
              { headId: input.id, seq },
            );
          }
        }
        const usage = normalizeUsage(step.usage);
        // A step the provider said nothing about meters nothing: neither the
        // report nor the ledger may be moved by a guess.
        if (!usageReported(usage)) return;
        capture.recordStepUsage(usage);
        // Charged per step, from the provider's own report, so the ledger is
        // current when the guard below reads it — rather than one lump debit
        // after the whole fork has already been paid for. The `?? 0` is the
        // running cumulative ledger's own plain-number contract, reached only
        // because the guard above established this step was really reported.
        await mission?.port.debit(usageTotal(usage) ?? 0, {
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
      return exhaustedMissionReport(input, capture, refusal, Date.now() - startedAt, recorded);
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
      stepCount: recorded,
      usage: capture.usage,
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
      stepCount: recorded,
      usage: capture.usage,
      wallClockMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
