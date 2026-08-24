// The backend-agnostic run of an agent that reports rather than chats — the
// divergent-reasoning-thread fork that produces a HeadReport, and the swarm node
// that produces one too. Every backend drives this: the cf-backend's Facet head
// (ExplorationAgent.runAsHead), the CLI's in-process head-worker, and both
// transports of a swarm node (strategy/node-agent.ts).
//
// IT OWNS NO LOOP OF ITS OWN. The turn body is `runChat` (../chat.ts) — the one
// place a model request is issued, tools are dispatched, the stream is watched
// for a stall, the step context is pruned and an unpaired tool call is repaired.
// This module owns what that body cannot know: how many TURNS this agent gets,
// the record_evidence / record_decision accumulator tools, the head system
// prompt + inherited-context messages, the per-step journal trace, the mission
// ledger it charges, and the HeadReport assembly (via the shared head-summary
// helpers).
//
// The backend provides the model + a HeadCapture + its own tool surface (the cf
// head forks its parent workspace's; the CLI head runs in-process over an
// ephemeral scratch).
//
// What a forking child inherits is specified by docs/EXPLORATION.md — "Inherited
// context".

import {
  tool, jsonSchema,
  type ToolSet, type LanguageModel, type ModelMessage, type StepResult,
} from 'ai';
import { runChat, type ChatOptions } from '../chat';
import type { PromptModelContext } from '../prompting/model-profile';
import {
  type HeadInput, type HeadReport, type HeadId, type HeadStep, type SerializedMessage,
  type Evidence, type Decision, type ArtifactRef,
  budgetExhausted,
} from './types';
import type { ToolCallRecord } from '../evolution/types';
import type { MissionBudgetRefusal, MissionScope } from '../mission-budget';
import { addUsage, normalizeUsage, usageReported, usageTotal, type Usage } from '../usage';
import { nanoid } from '../utils/nanoid';
import { extractFinalText, synthesizeHeadSummary, toHeadStep } from './head-summary';
import { HeadFileChanges } from './file-changes';
import * as v from 'valibot';
import { isJsonObject, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { diagnostics, renderCauseChain, renderThrownChain, toKinuError } from '../obs/index';

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
  /** One settled tool call, WITH what it returned.
   *
   *  `result` is the projected output rather than a fixed word, because this row is
   *  the only audit trail a finished head or node has: `HeadReport.toolCalls` is what
   *  `head_journal.tool_calls_json` stores, and a column reading `ok` for every call
   *  says a call happened and nothing else — the "paragraph of prose" the wrapper in
   *  node-agent.ts exists to improve on. The actor kinds' equivalent
   *  (`TurnAccumulator.recordToolCall`) has always recorded the output; this is the
   *  same treatment, through the same projection. */
  recordToolCall(name: string, args: JsonObject, result: JsonValue): void {
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
        capture.recordToolCall(name, args, projectJsonValue({ value: result }));
        return result;
      } catch (err) {
        capture.recordToolCall(name, args, `error: ${renderThrownChain({ cause: err })}`);
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
   * Whether the spawner has cancelled this run. Polled at step boundaries and
   * read for the final status. Still needed alongside {@link signal}: a host
   * hands its facet an RPC-shaped flag rather than an AbortSignal, which does
   * not cross a Durable Object boundary.
   */
  isAborted: () => boolean;
  /**
   * The spawner's abort signal, when one crosses into this isolate.
   *
   * Given to the SDK, so an abort cuts the step in flight instead of waiting
   * for the next boundary. That distinction is the whole of a hang: a run
   * inside a request that never returns reaches no step boundary, so a polled
   * flag can never observe it.
   */
  signal?: AbortSignal;
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
  /**
   * The prompt this loop runs, when the caller is not a head.
   *
   * A swarm node is a head-SHAPED agent and not a head: it needs the same tool
   * loop, the same per-step trace and the same report assembly, but a search's
   * framing rather than a fork's — the objective, the pinned task block, the
   * sibling angle and the branch protocol, none of which a head has. Absent is
   * the head's own framing, which is every existing caller.
   *
   * One optional dep rather than a second loop: a node with its own copy of
   * this function would be the parallel-implementation defect this module was
   * created to remove, and the swarm's own header records that the loop is
   * reused rather than rebuilt.
   */
  framing?: {
    readonly system: string;
    readonly messages: readonly ModelMessage[];
  };
  /**
   * The conversation this loop PRODUCED — every step's assistant and tool
   * messages, in order, across every turn it took.
   *
   * This is what a forking child inherits: under *Inherited context* a child's
   * context is its parent's *"unchanged, with the new material appended"*, and an
   * unmodified prefix is a prefix a provider can cache, so every sibling of one
   * parent shares one cacheable prefix. Absent for a head, which merges FINDINGS
   * (`record_evidence`, `record_decision`) rather than forking a conversation, and
   * then nothing is accumulated at all.
   *
   * Handed over once, for whatever the loop settled: a cut turn still yields a
   * conversation whose tool calls are all paired, and a child given that can be
   * assembled into a request. Only a turn that never settled one at all — a
   * provider stream that died before its first step — reports nothing.
   */
  reportMessages?: (messages: readonly ModelMessage[]) => void;
  /**
   * HOW THIS AGENT GETS ANOTHER TURN, or `null` when it has none coming.
   *
   * Absent is one turn and exactly one, which is every head: a fork answers the
   * question it was split off to answer and merges its findings.
   *
   * A swarm node is the other case, and it is the reason this exists. A node
   * detaches work that crosses `BACKGROUND_POLICY.interactive.detachAfterMs`
   * (jobs/threshold.ts) — `wakesAfterTurn` is what makes that legal — so a
   * node's turn can END with work still running, and the settled result arrives
   * afterwards as a wake. Returning the wake's messages resumes the SAME agent
   * on the SAME conversation, appended; returning null ends it.
   *
   * The caller owns BOTH halves of its own termination rule, which is why this
   * is one function rather than a flag plus a queue: a node returns null the
   * moment it has called `report`, and otherwise waits on the job it is holding.
   * ENDING A TURN WITHOUT REPORTING IS THEREFORE NORMAL — the loop asks this,
   * and only a `null` answer makes the run terminal.
   */
  resume?: () => Promise<readonly ModelMessage[] | null>;
}

/** A model that was CONSTRUCTED rather than named — the shape that reports its
 *  own id and provider. Duck-typed structurally, the same way every other
 *  vendor-shaped value in this tree is read, so it survives an SDK spec bump. */
const ConstructedModelSchema = v.object({ modelId: v.string(), provider: v.string() });

/**
 * RUN ONE AGENT — every kind that is not an actor's own chat — AND ASSEMBLE ITS
 * REPORT.
 *
 * THE TURN BODY IS {@link runChat} AND NOTHING HERE REPEATS IT. This function
 * used to hold a second `generateText` call, which is how a fork missed the
 * shared loop's dead-stream detection, mid-step abort, step-boundary pruning,
 * and unpaired-tool-call repair. Each exists once in the turn body; driving the
 * same body deletes the second path.
 *
 * WHAT IS LEFT HERE is what a turn body cannot know: how many turns this agent
 * gets, what a finished step means to its journal, which ledger it charges, and
 * how its outcome reads as a {@link HeadReport}.
 *
 * MANY TURNS, ONE RUN. A head takes exactly one turn — it answers the question
 * it was split off to answer. A node takes as many as it needs: its tools
 * detach work that crosses the background threshold, so a turn can end with
 * work still running, and ENDING A TURN WITHOUT REPORTING IS A NORMAL OUTCOME.
 * {@link HeadInferenceDeps.resume} is the only thing that decides, and a `null`
 * from it is the only thing that makes the run terminal. Across turns the
 * conversation is ONE append-only array, the step sequence is ONE dense
 * counter, and the findings are ONE capture — so the report says what the whole
 * run did rather than what its last turn did.
 *
 * NEVER THROWS: a failure becomes an `errored` report, because the controller
 * treats a thrown run() as budget_exceeded and that is a different claim.
 */
export async function runHeadInference(input: HeadInput, deps: HeadInferenceDeps): Promise<HeadReport> {
  const { capture, mission } = deps;
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
  // ONE counter across every turn, because `head_steps` is keyed `${id}-s${seq}`
  // and a per-turn counter would overwrite the first turn's trace with the
  // second's. A step with no prose, reasoning or tool call is padding and is not
  // recorded, exactly as the whole-run walk used to drop it.
  let recorded = 0;
  // `extractFinalText`'s two inputs, tracked as the steps land: the last
  // text-bearing step's prose, and the last reasoning. A whole-run walk is not
  // available here — the turn body reports steps as they finish — and it was
  // never wanted: the summary is the agent's final answer, not its commentary.
  let lastText = '';
  let lastReasoning = '';

  // The conversation this run issues, extended at every turn boundary by the
  // turn's own output and then by the wake that resumed it. ONE array and
  // append-only, which is *Inherited context*'s rule and also what makes a
  // resumed turn's request a prefix of the previous one that a provider can
  // cache. The seed is the prefix a child inherits UP TO, so what this run
  // produced is everything past it.
  const history: ModelMessage[] = deps.framing ? [...deps.framing.messages] : buildHeadMessages(input);
  const seeded = history.length;
  const system = deps.framing?.system
    ?? buildHeadSystemPrompt(input, Object.keys(deps.tools), deps.workspaceLayout);
  // The resolved model as the prompt layer names it, read off the model the
  // caller already resolved rather than asked for as a second dep nobody would
  // set. It buys two things the fork loop had neither of: the real context
  // window, which is what step-boundary tool-output pruning is measured against,
  // and the tool-capability check the actor already refuses a turn on — a fork
  // handed a model that cannot call tools used to burn its whole envelope
  // producing none, and now says so in its report instead.
  //
  // PARSED, not type-narrowed: `LanguageModel` is the SDK's "constructed model OR
  // bare id", two representations of one domain value, and the third arm is a
  // reading rather than a failure — a model that reports no identity still runs,
  // on the default window, because this field is read by the prompt layer alone.
  const constructed = v.safeParse(ConstructedModelSchema, deps.model);
  const named = v.safeParse(v.string(), deps.model);
  const modelContext: PromptModelContext = constructed.success
    ? { id: constructed.output.modelId, provider: constructed.output.provider }
    : named.success ? { id: named.output } : {};

  /** Whether any turn settled a conversation at all. A provider stream that
   *  died before its first step never yields `done`, and half a conversation is
   *  worse for a child than none. */
  let settled = false;
  /** What ended the run early, when something threw. Classified below with the
   *  natural path rather than in a catch of its own, so an aborted run reads the
   *  same whether the abort landed between steps or inside one. */
  let failure: unknown;

  const onStep = async (step: StepResult<ToolSet>): Promise<void> => {
    if (step.text.trim()) lastText = step.text;
    if (step.reasoningText?.trim()) lastReasoning = step.reasoningText;
    const traced = toHeadStep(step);
    if (traced) {
      const seq = recorded++;
      // A failed trace write must not kill the work it was watching — the sink
      // can be an RPC to another Durable Object. Same treatment the actor gives
      // its own step events.
      try {
        await deps.reportStep?.(seq, traced);
      } catch (err) {
        diagnostics.failure(
          'head.step_trace_failed',
          toKinuError({ doing: 'record a head step trace', cause: err, otherwise: 'io' }),
          { headId: input.id, seq },
        );
      }
    }
    const usage = normalizeUsage(step.usage);
    // A step the provider said nothing about meters nothing: neither the report
    // nor the ledger may be moved by a guess.
    if (!usageReported(usage)) return;
    capture.recordStepUsage(usage);
    // Charged per step, from the provider's own report, so the ledger is current
    // when the guard reads it — rather than one lump debit after the whole fork
    // has already been paid for. The `?? 0` is the running cumulative ledger's
    // own plain-number contract, reached only because the guard above
    // established this step was really reported.
    await mission?.port.debit(usageTotal(usage) ?? 0, {
      labels: mission.labels, calls: 1, usage,
    });
  };

  try {
    for (;;) {
      // Before the first call, between steps, AND between turns: an agent
      // spawned into an already-spent mission must not get one free inference
      // out of it, and neither must a resumed one.
      if (await outOfBudget()) break;
      const turn: ChatOptions = {
        model: deps.model,
        system,
        history,
        tools: deps.tools,
        modelContext,
        stopWhen: async () => {
          if (deps.isAborted()) return true;
          if (budgetExhausted(input.budget).exhausted) return true;
          return outOfBudget();
        },
        onStep,
      };
      if (deps.signal !== undefined) turn.signal = deps.signal;
      for await (const event of runChat(turn)) {
        if (event.type !== 'done') continue;
        settled = true;
        // The turn's own response messages, tool calls already paired by the
        // turn body. Appended, never accumulated per step: every step's
        // `response.messages` is CUMULATIVE (ai 6 builds one array and clones it
        // onto each step), so pushing them per step handed a forking child the
        // same assistant message once per remaining step.
        history.push(...event.responseMessages);
      }
      // A run the spawner cancelled, or one past the deadline it was granted,
      // gets no further turn however much work it is still holding.
      if (deps.isAborted() || budgetExhausted(input.budget).exhausted) break;
      const resumed = await deps.resume?.();
      if (!resumed) break;
      history.push(...resumed);
    }
    if (settled) deps.reportMessages?.(history.slice(seeded));
  } catch (err) {
    failure = err;
  }

  if (refusal) {
    return exhaustedMissionReport(input, capture, refusal, Date.now() - startedAt, recorded);
  }

  const budgetGate = budgetExhausted(input.budget);
  const aborted = deps.isAborted();
  // A throw the abort or the deadline already explains is NOT a failure of the
  // work: the turn body ends a cut turn by yielding `done` and then throwing, so
  // the steps it recorded are already in this report and the throw only says the
  // turn did not finish. Anything else — a dead provider stream, a stalled one,
  // a model that cannot call the tools it was given — IS the failure.
  const broke = failure !== undefined && !aborted && !budgetGate.exhausted;
  const status: HeadReport['status'] = broke
    ? 'errored'
    : aborted
      ? 'aborted'
      : budgetGate.exhausted ? 'budget_exceeded' : 'completed';
  // THE CAUSE CHAIN, not the bare message. `runNodeAgent`'s transport catch
  // renders one for the same column of the same store, and a run whose LOOP
  // failed used to get the outermost sentence only — so two terminal rows written
  // minutes apart read at different depths and the one with the real reason in it
  // was the one nobody had to debug.
  const stopReason = broke
    ? renderCauseChain(toKinuError({
      doing: `run agent ${input.id} to a report`, cause: failure, otherwise: 'unavailable',
    }))
    : deps.abortReason?.()
      ?? (budgetGate.exhausted
        ? `${budgetGate.reason} budget exhausted`
        : null);
  const summary = status === 'completed'
    ? (extractFinalText({ text: lastText, reasoningText: lastReasoning })
      || synthesizeHeadSummary({ decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls })
      || `Head ${input.id} completed without producing a textual summary.`)
    : status === 'errored'
      ? `Head ${input.id} errored: ${stopReason ?? 'no reason reported'}`
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
}
