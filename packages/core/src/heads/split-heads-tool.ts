/**
 * split_heads tool — the user-facing primitive for the LLM to invoke
 * branching-head exploration.
 *
 * Wired into OrchestratorAgent.getTools(). The LLM calls:
 *   split_heads({
 *     rationale: "Explore three angles on integrating X",
 *     heads: [
 *       { task: "Survey existing impls", rationale: "establish prior art" },
 *       { task: "Sketch our own design", rationale: "exercise constraints" },
 *       { task: "List failure modes", rationale: "stress-test the design" },
 *     ],
 *     merge_strategy: "synthesize",
 *   })
 *
 * The tool fires the HeadController, awaits all heads, and returns the merged
 * narrative as the tool result. The LLM then continues its turn with that
 * narrative as the latest tool output — exactly like any other tool call.
 */

import { tool, jsonSchema } from "ai";
import type { Tool, ToolExecutionOptions } from "ai";
import type { HeadController } from "./controller.js";
import type {
  SerializedMessage, SplitRequest, MergeResult, MergeStrategy, HeadBudget,
} from "./types.js";
import { DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY } from "./types.js";
import { nanoid } from "../utils/nanoid.js";

// Input schema — kept in shorthand-JSON-schema form for Vercel AI SDK.
const splitHeadsInputSchema = jsonSchema<SplitHeadsInput>({
  type: "object",
  required: ["rationale", "heads"],
  properties: {
    rationale: {
      type: "string",
      description:
        "One sentence: WHY are you splitting? What overall question are these heads collectively answering?",
    },
    heads: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: {
        type: "object",
        required: ["task", "rationale"],
        properties: {
          task: { type: "string", description: "What this specific head should explore. Be concrete." },
          rationale: { type: "string", description: "Why this angle matters." },
          allowedSandboxes: {
            type: "array",
            items: { type: "string" },
            description: "Sandbox namespaces this head may use. Omit for default (head's own virtual sandbox only).",
          },
          allowedTools: {
            type: "array",
            items: { type: "string" },
            description: "Tool names this head may invoke. Omit for default (record_evidence, record_decision, sandbox_*).",
          },
        },
      },
    },
    merge_strategy: {
      type: "string",
      enum: ["synthesize", "best_of", "consensus"],
      description:
        "How to combine the heads' findings. " +
        "'synthesize' = unify into one narrative. " +
        "'best_of' = pick the strongest. " +
        "'consensus' = highlight agreement and surface disagreements.",
    },
    max_depth: {
      type: "integer",
      minimum: 1,
      maximum: 5,
      description: "How deep heads may recursively split. Default 3.",
    },
    max_tokens: {
      type: "integer",
      minimum: 1000,
      description: "Total token ceiling across this head subtree. Default 50000.",
    },
    max_wall_clock_ms: {
      type: "integer",
      minimum: 5000,
      description: "Wall-clock budget for the whole split. Default 5min.",
    },
  },
});

export interface SplitHeadsInput {
  rationale: string;
  heads: Array<{
    task: string;
    rationale: string;
    allowedSandboxes?: string[];
    allowedTools?: string[];
  }>;
  merge_strategy?: MergeStrategy;
  max_depth?: number;
  max_tokens?: number;
  max_wall_clock_ms?: number;
}

/**
 * What the parent provides at tool-build time: how to get the current
 * conversation context (so each head receives it as inheritedContext) and
 * the HeadController instance.
 */
export interface SplitHeadsToolDeps {
  /** The controller (already wired to a HeadRuntime). */
  controller: HeadController;
  /** Returns the parent's conversation context at call time. */
  getInheritedContext: () => SerializedMessage[] | Promise<SerializedMessage[]>;
  /** Optional: the model id heads should use. Defaults to the orchestrator's. */
  defaultModel?: string;
  /** Optional: the parent budget (root-head budget). Default DEFAULT_HEAD_BUDGET. */
  defaultBudget?: Partial<HeadBudget>;
  /**
   * Optional: invoked on split / merge so the host can fan out events
   * (SSE, telemetry, UI nested timelines). One call per phase per split.
   * The controller fires it with the REAL spawned head ids.
   */
  onPhase?: import('./controller.js').HeadController['run'] extends (opts: { onPhase?: infer T }) => unknown
    ? T
    : never;
}

/**
 * Build the `split_heads` tool from a HeadController + context provider.
 *
 * The execute() body assembles a SplitRequest, runs the controller, and
 * returns the merged narrative + a concise cost summary.
 */
export function createSplitHeadsTool(deps: SplitHeadsToolDeps): Tool<SplitHeadsInput, string> {
  return tool({
    description: [
      "Split your reasoning into multiple parallel HEADS that explore different angles concurrently.",
      "Each head sees the WHOLE conversation context but has its own ephemeral scratch space.",
      "Heads return findings (summary + evidence + decisions); their findings are merged via LLM synthesis.",
      "",
      "Use this when the task has clearly distinct sub-questions that benefit from parallel exploration",
      "rather than serial reasoning. Avoid for tasks with one obvious path.",
      "",
      "Example: 'Explore 3 angles on integrating X' → splits into heads for prior-art survey,",
      "draft design, and failure modes. Heads run in parallel, then merge.",
    ].join("\n"),
    inputSchema: splitHeadsInputSchema,
    execute: async (
      input: SplitHeadsInput,
      _opts?: ToolExecutionOptions,
    ): Promise<string> => {
      const inheritedContext = await deps.getInheritedContext();
      const strategy: MergeStrategy = input.merge_strategy ?? DEFAULT_MERGE_STRATEGY;

      const parentBudget: HeadBudget = {
        maxDepth: input.max_depth ?? deps.defaultBudget?.maxDepth ?? DEFAULT_HEAD_BUDGET.maxDepth,
        maxTokens: input.max_tokens ?? deps.defaultBudget?.maxTokens ?? DEFAULT_HEAD_BUDGET.maxTokens,
        maxWallClockMs:
          input.max_wall_clock_ms ?? deps.defaultBudget?.maxWallClockMs ?? DEFAULT_HEAD_BUDGET.maxWallClockMs,
        spawnedAt: Date.now(),
      };

      const request: SplitRequest = {
        rationale: input.rationale,
        heads: input.heads,
        mergeStrategy: strategy,
      };

      const rootId = `split-${nanoid()}`;

      try {
        // Forward onPhase straight to the controller, which fires it with
        // the REAL spawned head ids + correct merge stats — no guessing.
        const result: MergeResult = await deps.controller.run({
          parentHeadId: null,
          rootId,
          inheritedContext,
          request,
          parentBudget,
          model: deps.defaultModel,
          onPhase: deps.onPhase,
        });
        return formatMergeResult(result, strategy);
      } catch (err) {
        return `split_heads failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

function formatMergeResult(result: MergeResult, strategy: MergeStrategy): string {
  const lines: string[] = [];
  lines.push(result.mergedNarrative);
  if (result.selectedDecisions.length > 0) {
    lines.push("");
    lines.push("### Selected decisions");
    for (const d of result.selectedDecisions) {
      lines.push(`- **${d.question}** → ${d.choice} _(${d.rationale})_`);
    }
  }
  if (result.unresolvedQuestions.length > 0) {
    lines.push("");
    lines.push("### Unresolved questions");
    for (const q of result.unresolvedQuestions) lines.push(`- ${q}`);
  }
  if (result.recommendations.length > 0) {
    lines.push("");
    lines.push("### Recommendations");
    for (const r of result.recommendations) lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(
    `_(merge=${strategy}, heads=${result.costSummary.headCount}, ` +
    `tokens=${result.costSummary.totalTokens}, ` +
    `wall=${Math.round(result.costSummary.totalWallClockMs / 100) / 10}s, ` +
    `depth=${result.costSummary.maxDepth})_`,
  );
  return lines.join("\n");
}
