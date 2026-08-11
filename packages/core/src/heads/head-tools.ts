/**
 * A head's tool surface — the single, backend-agnostic declaration of what a
 * fork of the parent workspace may do. Both backends build heads from this one
 * function: the cf ExplorationAgent Facet and the CLI in-process head runtime.
 *
 * A head IS a fork: it runs on the parent's real execution surface (the parent's
 * exec planes and workspace files) and reaches them through exactly the tools the
 * parent agent uses — `run`, `execute_tools`, `web`. Before this, a head got a
 * freshly-created empty scratch behind tools NAMED `sandbox_*`, so a head asked
 * to study a repo in the workspace truthfully reported finding nothing.
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
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import { buildBuiltinTools } from '../tools/builtins.js';
import { buildHeadAccumulatorTools, HeadCapture, withHeadCaptureRecording } from './head-inference.js';
import { budgetExhausted } from './types.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { Decision, HeadId, HeadInput, MergeStrategy } from './types.js';
import type { WebSearchProvider } from '../web/index.js';

/** The builtin tools a head keeps. `file` is the file plane, `execute_tools`
 *  the crafted/`llm`/`web` namespaces, `run` the real executor, `web` live
 *  research. `file` is kept deliberately, not by drift: a head does real
 *  implementation work on the parent's real files, and withholding the
 *  exact-match editor from it would leave the sed/heredoc corruption path open
 *  on exactly the branch whose output gets scored. `memory` and `skills` are
 *  withheld: they would address this head's OWN stores, which nothing outside a
 *  single head run ever reads. */
export const HEAD_BUILTIN_TOOLS = ['execute_tools', 'run', 'file', 'web'] as const;

export interface HeadSplitRequest {
  rationale: string;
  heads: Array<{ task: string; rationale: string }>;
  mergeStrategy: MergeStrategy;
}

export interface HeadSplitResult {
  narrative: string;
  decisions: readonly Decision[];
  unresolvedQuestions: readonly string[];
  childHeadIds: readonly HeadId[];
  headCount: number;
}

export interface HeadToolDeps {
  input: HeadInput;
  /** The findings accumulator every tool in the surface writes into. */
  capture: HeadCapture;
  /** The head's forked runtime — parent exec planes + workspace files, private
   *  durable scratch. Backs `run` and the `execute_tools` file plane. */
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
  const kept: ToolSet = {};
  for (const name of HEAD_BUILTIN_TOOLS) {
    const entry = builtin[name];
    if (entry) kept[name] = entry;
  }

  const all: ToolSet = {
    // The builtin tools know nothing about heads, so their calls are recorded
    // into the capture here rather than by each tool.
    ...withHeadCaptureRecording(kept, capture),
    // record_evidence / record_decision — the merge-back mechanism. Already
    // self-recording, so deliberately outside the wrapper.
    ...buildHeadAccumulatorTools(capture),

    split_subheads: tool({
      description:
        'Spawn 2-4 child heads recursively to explore narrower sub-questions. ' +
        'Children\'s findings merge into a single narrative. May fail if depth exhausted.',
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
        // Depth, plus a caller-requested deadline if one was set.
        const exhausted = budgetExhausted(input.budget);
        if (exhausted.exhausted) return `Cannot split: budget exhausted (${exhausted.reason}).`;
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
          return lines.join('\n');
        } catch (err) {
          capture.recordToolCall('split_subheads', { rationale, heads }, 'error');
          return `split_subheads failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };

  if (input.allowedTools === undefined) return all;
  const allowed = new Set(input.allowedTools);
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowed.has(name)));
}
