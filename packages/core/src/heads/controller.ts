/**
 * HeadController — orchestrates split → await → merge for branching heads.
 *
 * Pure logic. Abstracted over a `HeadRuntime` interface that:
 *   1. spawns a head as some kind of isolated worker (Facet on CF, child
 *      process in CLI, in-memory promise in tests)
 *   2. runs the merge LLM with a Zod-validated structured output
 *
 * The cf-backend supplies a Facet-based HeadRuntime; tests supply in-memory.
 *
 * Concurrency: heads run via Promise.allSettled — one head's failure does
 * not block the others. Wall-clock enforcement is a race against the budget.
 * Token-budget enforcement is post-hoc (heads self-report; merge cost summary
 * surfaces overruns).
 */

import { nanoid } from '../utils/nanoid.js';
import {
  type HeadId,
  type HeadInput,
  type HeadReport,
  type HeadBudget,
  type SplitRequest,
  type MergeResult,
  type MergeStrategy,
  type SerializedMessage,
  type Evidence,
  type Decision,
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
} from './types.js';
import { HeadJournal } from './journal.js';
import { MergeOutputSchema, type MergeOutput } from './merge-schema.js';

/** What the merge LLM should return. Validated by MergeOutputSchema. */
export type MergeLLMFn = (
  prompt: string,
  responseSchema: typeof MergeOutputSchema,
) => Promise<MergeOutput>;

/** What the controller asks the runtime to do per child head. */
export interface SpawnedHead {
  readonly id: HeadId;
  /** Kicks off the head; resolves with its report on completion. */
  run(): Promise<HeadReport>;
  /** Best-effort abort — used on wall-clock timeout. */
  abort(reason: string): Promise<void>;
}

/** Runtime adapter the controller depends on. */
export interface HeadRuntime {
  /** Spawn a head and return a handle. Called once per child in SplitRequest.heads. */
  spawnHead(input: HeadInput): Promise<SpawnedHead>;
  /** Run the merge LLM with structured output enforcement. */
  mergeLLM: MergeLLMFn;
}

/** Build a HeadController. */
export class HeadController {
  constructor(
    private readonly runtime: HeadRuntime,
    private readonly journal: HeadJournal,
  ) {}

  /**
   * Run a full split → await → merge cycle for the parent head identified
   * by `parentHeadId` (or undefined if this is the root split from the
   * orchestrator's main turn).
   *
   * Returns the MergeResult; also writes the cached merge into the journal.
   */
  async run(opts: {
    parentHeadId: HeadId | null;
    rootId?: HeadId;
    inheritedContext: SerializedMessage[];
    request: SplitRequest;
    parentBudget?: HeadBudget;
    model?: string;
  }): Promise<MergeResult> {
    const rootId = opts.rootId ?? opts.parentHeadId ?? nanoid();
    const strategy: MergeStrategy = opts.request.mergeStrategy ?? DEFAULT_MERGE_STRATEGY;

    const parentBudget: HeadBudget = opts.parentBudget ?? {
      ...DEFAULT_HEAD_BUDGET,
      ...opts.request.budget,
      spawnedAt: Date.now(),
    };
    if (parentBudget.maxDepth <= 0) {
      throw new Error('Cannot split: max depth reached');
    }
    if (opts.request.heads.length === 0) {
      throw new Error('Cannot split: no head tasks provided');
    }

    const n = opts.request.heads.length;
    const childBudget = deriveChildBudget(parentBudget, n, opts.request.budgetSplit);

    // Spawn all children concurrently.
    const spawnPromises = opts.request.heads.map(async (h, idx) => {
      const id = `${rootId}-d${childBudget.maxDepth + 1}-${idx}-${nanoid(6)}`;
      const input: HeadInput = {
        id,
        rootId,
        parentId: opts.parentHeadId,
        depth: (parentBudget.maxDepth - childBudget.maxDepth),
        task: h.task,
        rationale: h.rationale,
        inheritedContext: opts.inheritedContext,
        budget: childBudget,
        model: opts.model,
        allowedSandboxes: h.allowedSandboxes,
        allowedTools: h.allowedTools,
        mergeStrategy: strategy,
      };
      this.journal.insertSpawn(input);
      return this.runtime.spawnHead(input);
    });

    const handles = await Promise.all(spawnPromises);
    const startedAt = Date.now();

    // Race each head against the parent's wall-clock.
    const reports = await Promise.all(
      handles.map(async (h): Promise<HeadReport> => {
        const remainingMs = parentBudget.maxWallClockMs - (Date.now() - parentBudget.spawnedAt);
        try {
          const report = await raceWithTimeout(h, remainingMs);
          this.journal.recordReport(report);
          return report;
        } catch (err) {
          // Either abort failed or wall-clock blew. Synthesize a budget_exceeded report.
          const failed: HeadReport = {
            id: h.id,
            status: 'budget_exceeded',
            summary: 'Head was aborted before producing a report (wall-clock budget exceeded).',
            evidence: [],
            decisions: [],
            artifactRefs: [],
            childHeadIds: [],
            toolCalls: [],
            tokenUsage: { input: 0, output: 0, total: 0 },
            wallClockMs: Date.now() - startedAt,
            errorMessage: err instanceof Error ? err.message : String(err),
          };
          this.journal.recordReport(failed);
          return failed;
        }
      }),
    );

    // Synthesize via LLM.
    const mergeResult = await this.merge(reports, opts.request.rationale, strategy, opts.inheritedContext, parentBudget);
    this.journal.cacheMerge(rootId, mergeResult, strategy);
    return mergeResult;
  }

  /**
   * Run the merge synthesis call.
   *
   * Constructs a merge prompt with each head's summary + decisions + top
   * evidence, asks the LLM to synthesize, validates against MergeOutputSchema,
   * and produces the final MergeResult.
   */
  async merge(
    reports: readonly HeadReport[],
    rationale: string,
    strategy: MergeStrategy,
    inheritedContext: readonly SerializedMessage[],
    parentBudget: HeadBudget,
  ): Promise<MergeResult> {
    const prompt = buildMergePrompt(reports, rationale, strategy, inheritedContext);
    let merged: MergeOutput;
    try {
      merged = await this.runtime.mergeLLM(prompt, MergeOutputSchema);
    } catch (err) {
      // Hard merge failure: return a fallback narrative that lists each head's summary.
      const narrative = fallbackNarrative(reports, rationale, err instanceof Error ? err.message : String(err));
      return {
        mergedNarrative: narrative,
        selectedDecisions: reports.flatMap((r) => r.decisions),
        unresolvedQuestions: [],
        recommendations: [],
        evidenceAggregate: reports.flatMap((r) => r.evidence),
        costSummary: summarizeCost(reports, parentBudget),
      };
    }

    // Validate again defensively — runtimes may not enforce.
    const parse = MergeOutputSchema.safeParse(merged);
    if (!parse.success) {
      const narrative = fallbackNarrative(reports, rationale, `merge schema invalid: ${parse.error.message}`);
      return {
        mergedNarrative: narrative,
        selectedDecisions: reports.flatMap((r) => r.decisions),
        unresolvedQuestions: [],
        recommendations: [],
        evidenceAggregate: reports.flatMap((r) => r.evidence),
        costSummary: summarizeCost(reports, parentBudget),
      };
    }

    const finalNarrative = parse.data.narrative;
    return {
      mergedNarrative: finalNarrative,
      selectedDecisions: parse.data.selected_decisions as readonly Decision[],
      unresolvedQuestions: parse.data.unresolved_questions,
      recommendations: parse.data.recommendations,
      evidenceAggregate: reports.flatMap((r) => r.evidence) as readonly Evidence[],
      costSummary: summarizeCost(reports, parentBudget),
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────

async function raceWithTimeout(h: SpawnedHead, timeoutMs: number): Promise<HeadReport> {
  if (timeoutMs <= 0) {
    await h.abort('wall-clock budget already exhausted at spawn time');
    throw new Error('wall-clock budget already exhausted');
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      h.abort('wall-clock budget exhausted').catch(() => undefined);
      reject(new Error(`wall-clock budget exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([h.run(), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function summarizeCost(reports: readonly HeadReport[], parentBudget: HeadBudget): MergeResult['costSummary'] {
  return {
    headCount: reports.length,
    totalTokens: reports.reduce((acc, r) => acc + r.tokenUsage.total, 0),
    totalWallClockMs: Math.max(0, ...reports.map((r) => r.wallClockMs)),
    maxDepth: parentBudget.maxDepth,
  };
}

function fallbackNarrative(reports: readonly HeadReport[], rationale: string, errMsg: string): string {
  const lines: string[] = [];
  lines.push(`Merge synthesis unavailable (${errMsg}). Per-head summaries:`);
  lines.push('');
  lines.push(`Reason for split: ${rationale}`);
  lines.push('');
  for (const r of reports) {
    lines.push(`### Head ${r.id} (${r.status})`);
    lines.push(r.summary);
    lines.push('');
  }
  return lines.join('\n');
}

function buildMergePrompt(
  reports: readonly HeadReport[],
  rationale: string,
  strategy: MergeStrategy,
  inheritedContext: readonly SerializedMessage[],
): string {
  const strategyGuidance: Record<MergeStrategy, string> = {
    synthesize: 'Synthesize the heads\' findings into a single coherent narrative. Reconcile disagreements explicitly; prefer the head with stronger evidence.',
    best_of: 'Pick the strongest single head\'s narrative. Briefly cite weaker heads only for what they add.',
    consensus: 'Emphasize areas of agreement across heads. Surface disagreements as explicit unresolved questions.',
  };

  // Last ~6 turns of context as framing; cap to avoid blowing the merge prompt.
  const recentContext = inheritedContext.slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`)
    .join('\n');

  const headSections = reports.map((r) => {
    const evList = r.evidence
      .slice(0, 6)
      .map((e) => `  - [${e.kind}${e.confidence != null ? ` conf=${e.confidence.toFixed(2)}` : ''}] ${e.body.slice(0, 200)}`)
      .join('\n');
    const decList = r.decisions.length === 0
      ? '  (none)'
      : r.decisions.map((d) => `  - Q: ${d.question}\n    A: ${d.choice}\n    Why: ${d.rationale}`).join('\n');
    return `## Head ${r.id} (${r.status})
Summary:
${r.summary}

Decisions:
${decList}

Top evidence:
${evList || '  (none)'}`;
  }).join('\n\n');

  return `You are merging the findings of ${reports.length} parallel reasoning heads.

Split rationale: ${rationale}

Merge strategy: ${strategy}
Strategy guidance: ${strategyGuidance[strategy]}

Recent conversation context:
${recentContext || '(none)'}

Heads' reports:
${headSections}

Produce a structured JSON merge result with:
- narrative: a coherent unified narrative (the response the parent head writes back to the user)
- selected_decisions: the final answers chosen across the heads
- unresolved_questions: any open questions that remain
- recommendations: short imperative next-step suggestions

The narrative should be specific and grounded in the heads' evidence. Do not include
references to the merge process itself.`;
}
