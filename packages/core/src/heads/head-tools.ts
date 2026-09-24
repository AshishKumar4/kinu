/**
 * A head's tool surface, shared by both backends. Containment is structural: absent deps (no
 * `agents`/`report`/`release`) and the `HEAD_BUILTIN_TOOLS` allow-list. `allowedTools` filters last,
 * over the head's real vocabulary. Nodes: docs/EXPLORATION.md "A node is an agent".
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import { buildToolSurface } from '../tools/builtins';
import { buildHeadAccumulatorTools, HeadCapture, withHeadCaptureRecording } from './head-inference';
import { HEAD_BUILTIN_TOOLS } from './types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SessionHistory } from '../session/history';
import type { Decision, HeadId, HeadInput, MergeStrategy } from './types';
import type { WebSearchProvider } from '../web/index';
import { renderThrownChain } from '../obs/index';
import { failedToolOutcome } from '../tools/outcome';
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

export function buildHeadToolSet(deps: HeadToolDeps): ToolSet {
  const { input, capture } = deps;

  // Self-recording accumulators (outside the capture wrap) plus the depth-gated split.
  const extra: ToolSet = { ...buildHeadAccumulatorTools(capture) };

  // Depth is fixed for the whole run, so a head with none left is not offered the tool, and the prompt
  // (built from these keys) follows.
  if (input.budget.maxDepth > 0) {
    extra.split_subheads = permitInPlan(tool({
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
      execute: async ({ rationale, heads, merge_strategy }, options): Promise<string> => {
        try {
          const result = await deps.split({
            rationale, heads, mergeStrategy: merge_strategy ?? input.mergeStrategy,
          });

          for (const id of result.childHeadIds) capture.childHeadIds.push(id);
          capture.recordToolCall({
            name: 'split_subheads', args: { rationale, heads }, result: 'merged ' + result.headCount,
            outcome: { success: true }, toolCallId: options.toolCallId,
          });
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
          capture.recordToolCall({
            name: 'split_subheads', args: { rationale, heads }, result: renderThrownChain({ cause: err }),
            outcome: failedToolOutcome({ cause: err }), toolCallId: options.toolCallId,
          });
          throw err;
        }
      },
    }));
  }

  return buildToolSurface({
    rt: deps.rt,
    history: deps.history,
    workMode: input.mode,
    webSearch: deps.webSearch,
    admitted: HEAD_BUILTIN_TOOLS,
    wrapAdmitted: (admitted) => withHeadCaptureRecording(admitted, capture),
    extra,
    allowed: input.allowedTools,
    codemodeTool: deps.codemodeTool,
  });
}
