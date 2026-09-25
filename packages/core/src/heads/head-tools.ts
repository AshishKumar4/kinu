/**
 * A head's tool surface, shared by both backends. Containment is structural: absent deps (no
 * `agents`/`report`/`release`) and the `HEAD_BUILTIN_TOOLS` allow-list. `allowedTools` filters last,
 * over the head's real vocabulary. Nodes: docs/EXPLORATION.md "A node is an agent".
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { oneOf } from '../tools/tool-schema';
import { buildToolSurface } from '../tools/builtins';
import { buildHeadAccumulatorTools, HeadCapture, withHeadCaptureRecording } from './head-inference';
import { HEAD_BUILTIN_TOOLS, MERGE_STRATEGIES } from './types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SessionHistory } from '../session/history';
import type { Decision, HeadId, HeadInput, MergeStrategy } from './types';
import type { WebSearchProvider } from '../web/index';
import { permitInPlan } from '../execution/work-mode';

export interface HeadSplitRequest {
  readonly rationale: string;
  readonly heads: readonly { readonly task: string; readonly rationale: string }[];
  readonly mergeStrategy: MergeStrategy;
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
  capture: HeadCapture;
  /** Backs `shell`, `file`, and eval; the file topology reaches the prompt separately. */
  rt: AgentRuntime;
  /** The builtin factory builds the whole surface and narrows it afterwards, so its deps are whole. */
  history: SessionHistory;
  /** Pre-built `eval` (codemode differs per platform). A function receives the finished head surface and its result replaces `eval`. */
  codemodeTool: unknown;
  webSearch: WebSearchProvider;
  /** The backend owns the spawn substrate; the budget gate lives here. */
  split(request: HeadSplitRequest): Promise<HeadSplitResult>;
}

const SplitSubheadsInputSchema = z.object({
  rationale: z.string(),
  heads: z.array(z.object({ task: z.string(), rationale: z.string() })).min(2).max(4),
  merge_strategy: oneOf(MERGE_STRATEGIES).optional(),
});

export function buildHeadToolSet(deps: HeadToolDeps): ToolSet {
  const { input, capture } = deps;

  // The accumulators plus the depth-gated split; the capture wrap records their calls with the builtins'.
  const extra: ToolSet = { ...buildHeadAccumulatorTools(capture) };

  // Depth is fixed for the whole run, so a head with none left is not offered the tool, and the prompt
  // (built from these keys) follows.
  if (input.budget.maxDepth > 0) {
    extra.split_subheads = permitInPlan(tool({
      description:
        `Spawn 2-4 child heads recursively to explore narrower sub-questions. ` +
        `Children's findings merge into a single narrative. ` +
        `You may nest ${input.budget.maxDepth} more level(s).`,
      inputSchema: SplitSubheadsInputSchema,
      execute: async ({ rationale, heads, merge_strategy }): Promise<string> => {
        const result = await deps.split({
          rationale, heads, mergeStrategy: merge_strategy ?? input.mergeStrategy,
        });

        for (const id of result.childHeadIds) capture.childHeadIds.push(id);
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
      },
    }));
  }

  return buildToolSurface({
    rt: deps.rt,
    history: deps.history,
    workMode: input.mode,
    webSearch: deps.webSearch,
    admitted: HEAD_BUILTIN_TOOLS,
    wrapCalls: (tools) => withHeadCaptureRecording(tools, capture),
    extra,
    allowed: input.allowedTools,
    codemodeTool: deps.codemodeTool,
  });
}
