/**
 * A head's tool surface — the single, backend-agnostic declaration of what a
 * fork of the parent workspace may do. Both backends build heads from this one
 * function: the cf ExplorationAgent Facet and the CLI in-process head runtime.
 *
 * A head IS a fork: it reaches the parent's real execution surface through the
 * same `run`, `execute_tools`, and `web` vocabulary. Hosted heads share the
 * canonical workspace directly; local heads expose it as `parent.*` beside a
 * private scratch workspace. The prompt receives that backend layout explicitly.
 *
 * Containment is two independent mechanisms, both structural:
 *
 *   1. Absent deps. `agents` / `report` / `release` exist only when
 *      `buildBuiltinTools` is handed the deps that implement them. A head is
 *      handed none, so those tools cannot be built — the same mechanism that
 *      confines subordinates.
 *   2. `HEAD_BUILTIN_TOOLS`. Of what the builtin surface CAN produce, a head
 *      keeps only these. A builtin added upstream tomorrow does not silently
 *      appear on heads.
 *
 * `split_subheads` therefore stays the only way a head starts anything, and it
 * is depth-gated (HeadController derives each child's budget from its parent's;
 * budgetExhausted refuses once the recursion depth — or a caller-requested
 * deadline — runs out).
 *
 * The `allowedTools` filter runs LAST over the head's real vocabulary, so a
 * parent fork request naming `run` / `execute_tools` / `web` maps onto the
 * head's actual tools instead of silently emptying the set (the old bug: the
 * parent's vocabulary was filtered against a disjoint `sandbox_*` head surface).
 *
 * The node variant of this surface is specified by docs/EXPLORATION.md — "A node is
 * an agent".
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import { buildBuiltinTools } from '../tools/builtins';
import { buildHeadAccumulatorTools, HeadCapture, withHeadCaptureRecording } from './head-inference';
import { budgetExhausted, HEAD_BUILTIN_TOOLS, keepBuiltins } from './types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { Decision, HeadId, HeadInput, MergeStrategy } from './types';
import type { WebSearchProvider } from '../web/index';
import { renderThrownChain } from '../obs/index';

export interface HeadSplitRequest {
  rationale: string;
  heads: Array<{ task: string; rationale: string }>;
  mergeStrategy: MergeStrategy;
}

export interface HeadSplitResult {
  narrative: string;
  decisions: readonly Decision[];
  unresolvedQuestions: readonly string[];
  blindSpots: readonly string[];
  childHeadIds: readonly HeadId[];
  headCount: number;
}

export interface HeadToolDeps {
  input: HeadInput;
  /** The findings accumulator every tool in the surface writes into. */
  capture: HeadCapture;
  /** The head's forked runtime. Its exact file topology is supplied separately
   *  to the inference prompt; this value backs `run`, `file`, and execute_tools. */
  rt: AgentRuntime;
  /** Pre-built `execute_tools`; the backend owns it because codemode
   *  construction differs per platform (cf: LOADER Worker; CLI: Node eval). */
  executeTool: unknown;
  webSearch: WebSearchProvider;
  /** Recursive split. The backend owns the spawn substrate; the budget gate in
   *  front of it lives here, with the rest of the head's policy. */
  split(request: HeadSplitRequest): Promise<HeadSplitResult>;
}

export function buildHeadToolSet(deps: HeadToolDeps): ToolSet {
  const { input, capture } = deps;

  const builtin = buildBuiltinTools({
    rt: deps.rt,
    preBuiltExecuteTool: deps.executeTool,
    webSearch: deps.webSearch,
  });
  const kept = keepBuiltins(builtin, HEAD_BUILTIN_TOOLS);

  const all: ToolSet = {
    // The builtin tools know nothing about heads, so their calls are recorded
    // into the capture here rather than by each tool.
    ...withHeadCaptureRecording(kept, capture),
    // record_evidence / record_decision — the merge-back mechanism. Already
    // self-recording, so deliberately outside the wrapper.
    ...buildHeadAccumulatorTools(capture),
  };

  // Recursion depth is fixed for a head's whole run — nothing decrements
  // `input.budget.maxDepth` in place — so a head with none left cannot split
  // at any moment of it, and is not offered the tool rather than being handed
  // one whose only possible outcome is a refusal. Same structural containment
  // as the rest of this surface (absent, not guarded), and the prompt follows
  // for free: buildHeadSystemPrompt reads Object.keys of this very set, so a
  // head without the tool is told not to propose recursion instead of being
  // told it may split zero levels. The wall clock stays a RUNTIME check inside
  // execute — it can pass mid-run, which build time cannot know.
  if (input.budget.maxDepth > 0) {
    all.split_subheads = tool({
      description:
        `Spawn 2-4 child heads recursively to explore narrower sub-questions. ` +
        `Children's findings merge into a single narrative. ` +
        `You may nest ${input.budget.maxDepth} more level(s).`,
      inputSchema: jsonSchema<{
        rationale: string;
        heads: Array<{ task: string; rationale: string }>;
        merge_strategy?: MergeStrategy;
      }>({
        type: 'object', required: ['rationale', 'heads'],
        properties: {
          rationale: { type: 'string' },
          heads: {
            type: 'array', minItems: 2, maxItems: 4,
            items: {
              type: 'object', required: ['task', 'rationale'],
              properties: { task: { type: 'string' }, rationale: { type: 'string' } },
            },
          },
          merge_strategy: { type: 'string', enum: ['synthesize', 'best_of', 'consensus'] },
        },
      }),
      execute: async ({ rationale, heads, merge_strategy }): Promise<string> => {
        // Only the caller-requested deadline can still be spent here; depth was
        // settled when this tool was built. Recorded, not just returned: an
        // unrecorded refusal leaves no trace in the journal, so how often heads
        // are stopped mid-plan was unanswerable from the ledger.
        const exhausted = budgetExhausted(input.budget);
        if (exhausted.exhausted) {
          const refusal = `Cannot split: budget exhausted (${exhausted.reason}).`;
          capture.recordToolCall('split_subheads', { rationale, heads }, refusal);
          return refusal;
        }
        try {
          const result = await deps.split({
            rationale, heads, mergeStrategy: merge_strategy ?? input.mergeStrategy,
          });
          for (const id of result.childHeadIds) capture.childHeadIds.push(id);
          capture.recordToolCall('split_subheads', { rationale, heads }, `merged ${result.headCount}`);
          const lines: string[] = [result.narrative];
          if (result.decisions.length) {
            lines.push('', "Children's selected decisions:");
            for (const d of result.decisions) lines.push(`- ${d.question}: ${d.choice}`);
          }
          if (result.unresolvedQuestions.length) {
            lines.push('', 'Open questions:');
            for (const q of result.unresolvedQuestions) lines.push(`- ${q}`);
          }
          if (result.blindSpots.length) {
            lines.push('', 'Not covered by any child:');
            for (const b of result.blindSpots) lines.push(`- ${b}`);
          }
          return lines.join('\n');
        } catch (err) {
          capture.recordToolCall('split_subheads', { rationale, heads }, 'error');
          return `split_subheads failed: ${renderThrownChain({ cause: err })}`;
        }
      },
    });
  }

  if (input.allowedTools === undefined) return all;
  const allowed = new Set(input.allowedTools);
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowed.has(name)));
}
