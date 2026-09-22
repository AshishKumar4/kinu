/**
 * A head's tool surface — the single, backend-agnostic declaration of what a
 * fork of the parent workspace may do. Both backends build heads from this one
 * function: the hosted head and the CLI in-process head runtime.
 *
 * A head IS a fork: it reaches the parent's real execution surface through the
 * same `shell`, `eval`, and `web` vocabulary. Hosted heads share the
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
 * `split_subheads` is withheld when the inherited split depth is exhausted.
 * HeadController checks that depth again at spawn. A caller-requested
 * deadline is checked when the tool executes.
 *
 * The `allowedTools` filter runs LAST over the head's real vocabulary, so a
 * parent fork request naming `shell` / `eval` / `web` maps onto the
 * head's actual tools instead of silently emptying the set (the old bug: the
 * parent's vocabulary was filtered against a disjoint `sandbox_*` head surface).
 *
 * The node variant of this surface is specified by docs/EXPLORATION.md — "A node is
 * an agent".
 */

import { jsonSchema, tool, type ToolSet } from 'ai';
import { buildToolSurface } from '../tools/builtins';
import { buildHeadAccumulatorTools, HeadCapture, withHeadCaptureRecording } from './head-inference';
import { budgetExhausted, HEAD_BUILTIN_TOOLS } from './types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { SessionHistory } from '../session/history';
import type { Decision, HeadId, HeadInput, MergeStrategy } from './types';
import type { WebSearchProvider } from '../web/index';
import { KinuError, renderThrownChain } from '../obs/index';
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
  /** The findings accumulator every tool in the surface writes into. */
  capture: HeadCapture;
  /** The head's forked runtime. Its exact file topology is supplied separately
   *  to the inference prompt; this value backs `shell`, `file`, and eval. */
  rt: AgentRuntime;
  /** The conversation of the logical actor this head runs as. A head is not
   *  given `memory` (HEAD_BUILTIN_TOOLS), but the builtin factory builds one
   *  surface and narrows it afterwards, so the deps it narrows from are whole. */
  history: SessionHistory;
  /** Pre-built `eval`; the backend owns it because codemode
   *  construction differs per platform (cf: LOADER Worker; CLI: Node eval).
   *  A FUNCTION is called with the finished head surface and its result
   *  replaces `eval` in it — the hosted sandbox declares every tool
   *  of that surface as `tools.*`, so it needs the surface first. */
  codemodeTool: unknown;
  webSearch: WebSearchProvider;
  /** Recursive split. The backend owns the spawn substrate; the budget gate in
   *  front of it lives here, with the rest of the head's policy. */
  split(request: HeadSplitRequest): Promise<HeadSplitResult>;
}

export function buildHeadToolSet(deps: HeadToolDeps): ToolSet {
  const { input, capture } = deps;

  // The head's kind tools: the merge-back accumulators (self-recording, so
  // outside the capture wrap) plus the depth-gated split.
  const extra: ToolSet = { ...buildHeadAccumulatorTools(capture) };

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
        // Only the caller-requested deadline can still be spent here; depth was
        // settled when this tool was built. Recorded, not just returned: an
        // unrecorded refusal leaves no trace in the journal, so how often heads
        // are stopped mid-plan was unanswerable from the ledger.
        const exhausted = budgetExhausted(input.budget);

        if (exhausted.exhausted) {
          const failure = new KinuError('denied', 'Cannot split: budget exhausted (' + exhausted.reason + ').');
          capture.recordToolCall({
            name: 'split_subheads', args: { rationale, heads }, result: failure.message,
            outcome: failedToolOutcome({ cause: failure }), toolCallId: options.toolCallId,
          });
          throw failure;
        }

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
