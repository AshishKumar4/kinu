/**
 * A head's tool surface, shared by both backends. Containment is structural: absent deps (no
 * `agents`/`report`/`release`) and the `HEAD_BUILTIN_TOOLS` allow-list. `allowedTools` filters last,
 * over the head's real vocabulary. Nodes: docs/EXPLORATION.md "A node is an agent".
 */

import type { ToolSet } from 'ai';
import * as v from 'valibot';
import { defineOperation, serve } from '../operations/operation';
import { operationTool } from '../tools/operation-surfaces';
import { buildToolSurface } from '../tools/builtins';
import { buildHeadAccumulatorTools, HeadCapture, withHeadCaptureRecording } from './head-inference';
import { HEAD_BUILTIN_TOOLS, MERGE_STRATEGIES } from './types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ConversationRecall } from '../memory/conversation-search';
import type { Decision, HeadId, HeadInput, MergeStrategy } from './types';
import type { WebSearchProvider } from '../web/index';
import { wrapToolsForBackground, type ActorJobs } from '../jobs/background-wrap';

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
  conversations: ConversationRecall;
  /** Pre-built `eval` (codemode differs per platform). A function receives the finished head surface and its allowed
   *  reach, and its result replaces `eval`. */
  codemodeTool: unknown;
  webSearch: WebSearchProvider;
  /** The backend owns the spawn substrate; the budget gate lives here. */
  split(request: HeadSplitRequest): Promise<HeadSplitResult>;
  jobs: ActorJobs;
}

/** A head's split into child heads; the width is shown, and the backend's split enforces it. */
const SPLIT = defineOperation({
  ns: 'head', name: 'split', slate: false, impact: 'delegate', plan: true,
  help: "Spawn 2-4 child heads recursively to explore narrower sub-questions. Children's findings merge into a single narrative.",
  input: v.strictObject({
    rationale: v.string(),
    heads: v.pipe(v.array(v.strictObject({ task: v.string(), rationale: v.string() })), v.metadata({ minItems: 2, maxItems: 4 })),
    merge_strategy: v.optional(v.picklist(MERGE_STRATEGIES)),
  }),
  output: v.string(),
});

export function buildHeadToolSet(deps: HeadToolDeps): ToolSet {
  const { input, capture } = deps;

  // The accumulators plus the depth-gated split; the capture wrap records their calls with the builtins'.
  const extra: ToolSet = { ...buildHeadAccumulatorTools(capture) };

  // Depth is fixed for the whole run, so a head with none left is not offered the tool, and the prompt
  // (built from these keys) follows.
  if (input.budget.maxDepth > 0) {
    extra.split_subheads = operationTool(`${SPLIT.help} You may nest ${String(input.budget.maxDepth)} more level(s).`, serve(SPLIT, async ({ rationale, heads, merge_strategy }) => {
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
    }));
  }

  return buildToolSurface({
    rt: deps.rt,
    conversations: deps.conversations,
    workMode: input.mode,
    webSearch: deps.webSearch,
    admitted: HEAD_BUILTIN_TOOLS,
    wrapCalls: (tools) => withHeadCaptureRecording(tools, capture),
    extra,
    allowed: input.allowedTools,
    codemodeTool: deps.codemodeTool,
    wrapFinished: (finished) => wrapToolsForBackground(finished, deps.jobs),
  });
}
