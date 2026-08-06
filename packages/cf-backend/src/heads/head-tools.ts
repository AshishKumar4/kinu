/**
 * A head's tool surface — the single declaration of what a fork of the parent
 * workspace may do.
 *
 * A head IS a fork: it runs on the parent's exec planes (same sandbox container,
 * same Nimbus session, same device consent) with the parent's workspace mounted
 * at `/workspace`, so it reaches the real files and the real executor through
 * exactly the tools the parent agent uses. Before this, a head got a
 * freshly-created empty SqliteFS behind tools NAMED `sandbox_*`, so a head asked
 * to study a repo in the workspace truthfully reported finding nothing.
 *
 * Containment is two independent mechanisms, both structural:
 *
 *   1. Absent deps. `agents` / `report` / `product_change` exist only when
 *      `buildBuiltinTools` is handed the deps that implement them. A head is
 *      handed none, so those tools cannot be built — the same mechanism that
 *      confines subordinates.
 *   2. `HEAD_BUILTIN_TOOLS`. Of what the builtin surface CAN produce, a head
 *      keeps only these. A builtin added upstream tomorrow does not silently
 *      appear on heads.
 *
 * `split_subheads` therefore stays the only way a head starts anything, and it
 * is budget-gated (HeadController derives each child's budget from its parent's;
 * budgetExhausted refuses once depth, tokens or wall-clock run out).
 *
 * This module deliberately imports nothing from `agents`: the facet supplies the
 * runtime and the spawn substrate as plain values, so the surface it produces is
 * directly constructible — and therefore directly assertable — in a unit test.
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import {
  buildBuiltinTools,
  buildHeadAccumulatorTools,
  budgetExhausted,
  withHeadCaptureRecording,
  type AgentRuntime,
  type Decision,
  type HeadCapture,
  type HeadId,
  type HeadInput,
  type MergeStrategy,
  type WebSearchProvider,
} from '@proteus/core';

/** The builtin tools a head keeps. `execute_tools` is the file plane + the
 *  crafted/`llm`/`web` namespaces; `run` is the real executor; `web_*` is live
 *  research. `memory`, `skills` and `fact` are withheld: they would address this
 *  facet's OWN stores, which nothing outside a single head run ever reads. */
export const HEAD_BUILTIN_TOOLS = ['execute_tools', 'run', 'web_search', 'web_fetch'] as const;

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
  /** The head's forked runtime — parent-keyed exec planes, `/workspace` mounted. */
  rt: AgentRuntime;
  /** Pre-built `execute_tools`; the facet owns it because codemode needs
   *  `env.LOADER`, which is not on the runtime. */
  executeTool: unknown;
  webSearch: WebSearchProvider;
  /** Recursive split. The facet owns the facet-spawn substrate; the budget gate
   *  in front of it lives here, with the rest of the head's policy. */
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
        // budgetExhausted covers max-depth, tokens and wall-clock in one gate.
        const exhausted = budgetExhausted(input.budget, capture.tokenUsage.input + capture.tokenUsage.output);
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
