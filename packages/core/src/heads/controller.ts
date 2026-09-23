/**
 * HeadController: split, await, merge for branching heads, over a `HeadRuntime` port.
 * Heads settle independently (Promise.allSettled).
 */

import * as v from 'valibot';
import { nanoid } from '../utils/nanoid';
import { REAL_CLOCK, type Clock } from '../types/clock';
import { jsonObjectOnlyInstruction } from '../prompts/structured';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import {
  type HeadId,
  type HeadInput,
  type HeadReport,
  type HeadBudget,
  type SplitRequest,
  type MergeResult,
  type HeadScore,
  type MergeStrategy,
  type SerializedMessage,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
} from './types';
import { headProducedFindings } from './head-summary';
import { MergeOutputSchema, type MergeOutput } from './merge-schema';
import { evaluateWithMultiModelJudging, median } from '../mcts/evaluation';
import { DEFAULT_CONFIG } from '../config';
import type { LLM, Executor } from '../types/primitives';
import type { WorkMode } from '../types/turn';
import { addUsage, usageTotal, type Usage } from '../usage';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import { defaultLoopOrigin } from '../scaffold/loop-origin';

export type MergeLLMFn = (
  prompt: string,
  responseSchema: typeof MergeOutputSchema,
) => Promise<MergeOutput>;

/** Optional grounding seam: the same grounded evaluator and median ensemble as MCTS (mcts/evaluation.ts). Omitted: n=1 merge, neutral head scores. */
export interface HeadGrounding {
  readonly executor: Executor;
  /** Judges when no cross-model judge is set. */
  readonly explorer: LLM;
  readonly judge?: LLM;
  /** Default DEFAULT_CONFIG.mcts.judgeSamples. */
  readonly judgeSamples?: number;
  /** Default DEFAULT_CONFIG.mcts.maxEvalLLMCalls. */
  readonly maxEvalLLMCalls?: number;
  /** Median-scored sample wins. Default DEFAULT_CONFIG.heads.mergeSamples. */
  readonly mergeSamples?: number;
}

/**
 * A port so a recursive split writes to the root's journal: spawn/report rows and step rows must
 * land in the same place for the `head_journal` -> `head_steps` join. Methods may be async (RPC).
 */
export interface HeadJournalPort {
  recordSplit(rootId: HeadId, rationale: string, spawnedAt: number): void | Promise<void>;
  insertSpawn(input: HeadInput): void | Promise<void>;
  recordReport(report: HeadReport): void | Promise<void>;
  cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void | Promise<void>;
}

/**
 * The root's journal. Run reclamation is a whole-store read, so a facet's RPC port cannot serve it;
 * a recursive split always carries `parentHeadId` and never needs it. `abandonRunning` is deliberately absent.
 */
export interface HeadRootJournal extends HeadJournalPort {
  findResumableRun(task: string): HeadId | null;
}

function isRootJournal(journal: HeadJournalPort): journal is HeadRootJournal {
  return 'findResumableRun' in journal;
}

export interface SpawnedHead {
  readonly id: HeadId;
  run(): Promise<HeadReport>;
  /** Best-effort. */
  abort(reason: string): Promise<void>;
}

export interface HeadRuntime {
  spawnHead: (input: HeadInput) => Promise<SpawnedHead>;
  mergeLLM: MergeLLMFn;
  /** When set, head scores and the merge are grounded and ensembled (see HeadGrounding). */
  grounding?: HeadGrounding;
}

/** Fired with the head IDs the controller actually spawned. */
export type SplitPhaseEvent =
  | { kind: 'split'; rootId: HeadId; headIds: readonly HeadId[]; rationale: string }
  | { kind: 'merge'; rootId: HeadId; cost: MergeResult['costSummary']; mergedNarrative: string;
      fileChanges: MergeResult['fileChanges'];
      blindSpots: MergeResult['blindSpots'] };

/**
 * Re-entry reopens unfinished heads under their existing IDs through `HeadJournal.insertSpawn`,
 * the only place a head row is reset; it does not terminalize them. Only start-of-life
 * reconciliation (`heads/reconcile.ts`) may retire a head.
 */

/** Mid-range on purpose: 0 would rank below a head that failed, 1 would credit unscored work. */
const NO_GROUNDED_SIGNAL = 0.5;

export interface MergeRequest {
  readonly reports: readonly HeadReport[];
  readonly rationale: string;
  readonly strategy: MergeStrategy;
  readonly inheritedContext: readonly SerializedMessage[];
  readonly parentBudget: HeadBudget;
  readonly mode: WorkMode;
  readonly headIds?: readonly HeadId[];
  readonly headScores?: readonly HeadScore[];
}

export class HeadController {
  constructor(
    private readonly runtime: HeadRuntime,
    private readonly journal: HeadJournalPort,
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  /**
   * The unfinished run for this task if there is one, else a fresh id, so a re-drive of a detached
   * fork reuses its run. Reclaimed heads are re-run under their derived ids, not retired.
   */
  private resolveTopLevelRun(task: string): HeadId {
    const journal = this.journal;

    if (!isRootJournal(journal)) {
      // A facet's port reaching this is a wiring error: minting a fresh id would split the run.
      throw new Error(
        'A top-level split must run against the ROOT workspace journal — run reclamation reads every '
        + 'unfinished run in the store. A recursive split has to pass parentHeadId.',
      );
    }

    return journal.findResumableRun(task) ?? nanoid();
  }

  /** Full split, await, merge cycle; fires `onPhase` on split (real head IDs) and on merge. */
  async run(opts: ({ parentHeadId: null } | { parentHeadId: HeadId; parentDepth: number }) & {
    rootId?: HeadId;
    inheritedContext: SerializedMessage[];
    request: SplitRequest;
    parentBudget: HeadBudget;
    model?: string;
    mode: WorkMode;
    /** Carried to each HeadInput so an out-of-process head can find the ledger. */
    missionLabels?: readonly string[];
    onPhase?: (event: SplitPhaseEvent) => void;
  }): Promise<MergeResult> {
    const rootId = opts.rootId ?? opts.parentHeadId ?? this.resolveTopLevelRun(opts.request.rationale);
    const strategy: MergeStrategy = opts.request.mergeStrategy ?? DEFAULT_MERGE_STRATEGY;

    const parentBudget = opts.parentBudget;

    if (parentBudget.maxDepth <= 0) {
      throw new Error('Cannot split: max depth reached');
    }

    if (opts.request.heads.length === 0) {
      throw new Error('Cannot split: no head tasks provided');
    }

    const childBudget = deriveChildBudget(parentBudget);

    // Only the root owns run identity and final settlement. Nested reports share its journal.
    if (opts.parentHeadId === null) {
      const splitRecorded = this.journal.recordSplit(rootId, opts.request.rationale, parentBudget.spawnedAt);

      if (splitRecorded !== undefined) await splitRecorded;
    }

    // A spawn that throws settles only its own head and never reaches Promise.all.
    const spawnPromises = opts.request.heads.map(async (h, idx): Promise<SpawnedHead | HeadReport> => {
      // Derived from the parent and slot, never minted: a re-drive re-opens the same row via
      // `HeadJournal.insertSpawn`. Keyed on the parent, which is unique, not the root.
      const id = `${opts.parentHeadId ?? rootId}-d${childBudget.maxDepth + 1}-${idx}`;

      const input: HeadInput = {
        id,
        rootId,
        parentId: opts.parentHeadId,
        depth: opts.parentHeadId === null ? 1 : opts.parentDepth + 1,
        task: h.task,
        mode: opts.mode,
        rationale: h.rationale,
        inheritedContext: opts.inheritedContext,
        budget: childBudget,
        // Per-head model wins over the parent default.
        model: h.model ?? opts.model,
        allowedTools: h.allowedTools,
        mergeStrategy: strategy,
        // A fork explores under the loop it forks from, via the per-kind default.
        loop: defaultLoopOrigin('head'),
      };

      if (opts.missionLabels?.length) Object.assign(input, { missionLabels: opts.missionLabels });
      // A local journal writes the row before this returns; nothing may push that write behind a microtask.
      const spawnRecorded = this.journal.insertSpawn(input);

      if (spawnRecorded !== undefined) await spawnRecorded;

      try {
        return await this.runtime.spawnHead(input);
      } catch (err) {
        // Nothing ran: usage is unknown (`{}`), and the reason travels in `errorMessage`.
        const failed: HeadReport = {
          id,
          status: 'errored',
          summary: 'Head failed to spawn before producing a report.',
          evidence: [],
          decisions: [],
          artifactRefs: [],
          fileChanges: [],
          childHeadIds: [],
          toolCalls: [],
          stepCount: 0,
          usage: {},
          wallClockMs: 0,
          errorMessage: renderThrownChain({ cause: err }),
        };

        await this.journal.recordReport(failed);

        return failed;
      }
    });

    const settled = await Promise.all(spawnPromises);
    // Only heads that spawned hold a handle; the split event carries exactly these ids.
    const handles: SpawnedHead[] = [];

    for (const s of settled) {
      if ('run' in s) handles.push(s);
    }

    const startedAt = this.clock.now();

    opts.onPhase?.({
      kind: 'split',
      rootId,
      headIds: handles.map((h) => h.id),
      rationale: opts.request.rationale,
    });

    const reports = await Promise.all(
      settled.map(async (s): Promise<HeadReport> => {
        // A failed-spawn head rejoins in its original slot so the merge still sees every head.
        if (!('run' in s)) return s;
        const h = s;

        try {
          const report = await h.run();
          await this.journal.recordReport(report);

          return report;
        } catch (err) {
          const failed: HeadReport = {
            id: h.id,
            status: 'errored',
            summary: 'Head failed before producing a report.',
            evidence: [],
            decisions: [],
            artifactRefs: [],
            fileChanges: [],
            childHeadIds: [],
            toolCalls: [], stepCount: 0,
            // The head never reported, so its usage is unknown: `{}`, not zeros.
            usage: {},
            wallClockMs: this.clock.now() - startedAt,
            errorMessage: renderThrownChain({ cause: err }),
          };

          await this.journal.recordReport(failed);

          return failed;
        }
      }),
    );

    const headScores = await this.scoreHeads(rootId, reports, opts.request.rationale, opts.mode);

    const mergeResult = await this.merge({
      reports,
      rationale: opts.request.rationale,
      strategy,
      inheritedContext: opts.inheritedContext,
      parentBudget,
      mode: opts.mode,
      headIds: reports.map((r) => r.id),
      headScores,
    });

    if (opts.parentHeadId === null) await this.journal.cacheMerge(rootId, mergeResult, strategy);
    opts.onPhase?.({
      kind: 'merge',
      rootId,
      cost: mergeResult.costSummary,
      mergedNarrative: mergeResult.mergedNarrative,
      fileChanges: mergeResult.fileChanges,
      blindSpots: mergeResult.blindSpots,
    });

    return mergeResult;
  }

  /**
   * One score per head (text + status for Alternate-Takes). Settled per head: a judge is a provider
   * call, and a rejection must not discard the split's findings and its `head_merge` row. An unreachable
   * judge scores as {@link NO_GROUNDED_SIGNAL}, with the reason logged.
   */
  private async scoreHeads(
    rootId: HeadId,
    reports: readonly HeadReport[],
    rationale: string,
    mode: WorkMode,
  ): Promise<readonly HeadScore[]> {
    const g = mode === 'plan' ? undefined : this.runtime.grounding;
    // Heads reuse the MCTS judge knobs and inherit its clamp; a realised size below the request is
    // disclosed once per size, as the engine does.
    const judgeSamplesRequested = g?.judgeSamples ?? DEFAULT_CONFIG.mcts.judgeSamples;
    const reportedClampedEnsembles = new Set<number>();
    const siblings = reports.map(headTrajectory);

    const settled = await Promise.allSettled(
      reports.map(async (r, i): Promise<HeadScore> => {
        const base = { id: r.id, text: r.summary, status: r.status } as const;

        if (!g) return { ...base, score: NO_GROUNDED_SIGNAL, grounding: 'judge' };

        // A head that never completed is floored without a judge call.
        if (r.status !== 'completed') return { ...base, score: 0, grounding: 'judge' };

        const evaluation = await evaluateWithMultiModelJudging({
          task: rationale,
          trajectory: siblings[i],
          siblings: siblings.filter((_, j) => j !== i),
          executor: g.executor,
          explorer: g.explorer,
          judge: g.judge,
          judgeSamples: g.judgeSamples,
          maxLLMCalls: g.maxEvalLLMCalls,
        });

        const realised = evaluation.judgeSamplesAttempted;

        if (realised > 0 && realised < judgeSamplesRequested && !reportedClampedEnsembles.has(realised)) {
          reportedClampedEnsembles.add(realised);
          diagnostics.event('head.judge_ensemble_clamped', {
            rootId,
            judgeSamplesRequested,
            judgeSamplesRealised: realised,
            maxEvalLLMCalls: g.maxEvalLLMCalls ?? DEFAULT_CONFIG.mcts.maxEvalLLMCalls,
          });
        }

        return { ...base, score: evaluation.score, grounding: evaluation.grounding };
      }),
    );

    return settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const r = reports[i];
      // The reason itself, not its `message`: provider errors carry url and cause, and SDK errors often have an empty message.
      diagnostics.failure(
        'head.score_failed',
        toKinuError({ doing: 'score a head report', cause: outcome.reason, otherwise: 'unavailable' }),
        { headId: r.id },
      );

      return { id: r.id, text: r.summary, status: r.status, score: NO_GROUNDED_SIGNAL, grounding: 'judge' };
    });
  }

  /** The merge prompt carries each head's full evidence and artifacts so no finding is lost. */
  async merge(request: MergeRequest): Promise<MergeResult> {
    const { reports, rationale, strategy, inheritedContext, parentBudget, mode } = request;
    const headIds = request.headIds ?? reports.map((r) => r.id);
    const headScores = request.headScores ?? [];
    const grounded = mode !== 'plan' && this.runtime.grounding != null;
    const costSummary = summarizeCost(reports, parentBudget);
    const fileChanges = collectFileChanges(reports);

    // Every head stopped without banking a finding: report deterministically. A model asked to narrate
    // this invents a cause.
    if (costSummary.headsWithFindings === 0) {
      return {
        mergedNarrative: emptySplitNarrative(reports, rationale),
        selectedDecisions: [],
        unresolvedQuestions: [],
        recommendations: [],
        // No head observed anything, so there is no negative space to report.
        blindSpots: [],
        evidenceAggregate: [],
        headIds,
        headScores,
        fileChanges,
        grounded,
        costSummary,
      };
    }

    const prompt = buildMergePrompt({ reports, rationale, strategy, inheritedContext, headScores: grounded ? headScores : [] });

    const fallback = (errMsg: string): MergeResult => ({
      mergedNarrative: fallbackNarrative(reports, rationale, errMsg),
      selectedDecisions: reports.flatMap((r) => r.decisions),
      unresolvedQuestions: [],
      recommendations: [],
      blindSpots: [],
      evidenceAggregate: reports.flatMap((r) => r.evidence),
      headIds,
      headScores,
      fileChanges,
      grounded,
      costSummary,
    });

    const merged = await this.synthesize(prompt, rationale, grounded);

    if (!merged.ok) return fallback(merged.error);

    return {
      mergedNarrative: merged.output.narrative,
      selectedDecisions: merged.output.selected_decisions,
      unresolvedQuestions: merged.output.unresolved_questions,
      recommendations: merged.output.recommendations,
      blindSpots: merged.output.blind_spots,
      evidenceAggregate: reports.flatMap((r) => r.evidence),
      headIds,
      headScores,
      fileChanges,
      grounded,
      costSummary,
    };
  }

  /** Returns the surfaced error reason when every sample fails; the caller renders the per-head fallback. */
  private async synthesize(
    prompt: string,
    rationale: string,
    grounded: boolean,
  ): Promise<{ ok: true; output: MergeOutput } | { ok: false; error: string }> {
    const g = grounded ? this.runtime.grounding : undefined;
    const k = Math.max(1, g?.mergeSamples ?? 1);

    const sampleOne = async (): Promise<{ ok: true; output: MergeOutput } | { ok: false; error: string }> => {
      let out: MergeOutput;

      try {
        out = await this.runtime.mergeLLM(prompt, MergeOutputSchema);
      } catch (err) {
        return { ok: false, error: renderThrownChain({ cause: err }) };
      }

      const parse = v.safeParse(MergeOutputSchema, out);

      return parse.success
        ? { ok: true, output: parse.output }
        : { ok: false, error: `merge schema invalid: ${parse.issues.map((i) => i.message).join('; ')}` };
    };

    if (k === 1 || !g) return sampleOne();

    const results = await Promise.all(Array.from({ length: k }, sampleOne));
    const samples = results.filter((r): r is { ok: true; output: MergeOutput } => r.ok).map((r) => r.output);

    if (samples.length === 0) {
      const firstError = results.find((r): r is { ok: false; error: string } => !r.ok);

      return { ok: false, error: firstError?.error ?? 'all merge samples failed' };
    }

    if (samples.length === 1) return { ok: true, output: samples[0] };

    // Settled, as in scoreHeads: a rejecting judge must not discard valid samples and the head_merge row.
    const judge = g.judge ?? g.explorer;

    const settled = await Promise.allSettled(
      samples.map(async (s) => ({ sample: s, score: await scoreMergeNarrative(judge, rationale, s.narrative) })),
    );

    const scored = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      // The reason itself, not its `message` — see scoreHeads.
      diagnostics.failure(
        'merge.sample_score_failed',
        toKinuError({ doing: 'score a merge sample', cause: outcome.reason, otherwise: 'unavailable' }),
        { sampleIndex: i },
      );

      return { sample: samples[i], score: null };
    });

    const usable = scored.filter((x): x is { sample: MergeOutput; score: number } => x.score !== null);

    if (usable.length === 0) return { ok: true, output: samples[0] };
    const medianScore = median(usable.map((x) => x.score));

    const winner = usable.reduce((best, cur) =>
      Math.abs(cur.score - medianScore) < Math.abs(best.score - medianScore) ? cur : best,
    );

    return { ok: true, output: winner.sample };
  }
}

/** Heads that changed nothing are omitted; tolerates a missing array from the RPC boundary. */
function collectFileChanges(reports: readonly HeadReport[]): MergeResult['fileChanges'] {
  return reports
    .filter((r) => (r.fileChanges?.length ?? 0) > 0)
    .map((r) => ({ id: r.id, changes: r.fileChanges }));
}

function summarizeCost(reports: readonly HeadReport[], parentBudget: HeadBudget): MergeResult['costSummary'] {
  // `addUsage` preserves absence, so `usageTotal` is undefined when no head reported a cost.
  const usage = reports.reduce<Usage>((acc, r) => addUsage(acc, r.usage), {});

  return {
    headCount: reports.length,
    headsWithFindings: reports.filter(headProducedFindings).length,
    totalTokens: usageTotal(usage),
    totalWallClockMs: Math.max(0, ...reports.map((r) => r.wallClockMs)),
    maxDepth: parentBudget.maxDepth,
  };
}

/** Deterministic: states each head's status and cost only, so no unobserved cause reaches the parent. */
function emptySplitNarrative(reports: readonly HeadReport[], rationale: string): string {
  const lines = [
    `No head produced findings. ${reports.length} head(s) were spawned to explore: ${rationale}`,
    '',
  ];

  for (const r of reports) {
    // "tokens unreported", not "0 tokens": this text reaches the parent's context verbatim.
    const total = usageTotal(r.usage);
    lines.push(
      `- Head ${r.id}: ${r.status}${r.errorMessage ? ` — ${r.errorMessage}` : ''}`
      + ` (${total === undefined ? 'tokens unreported' : `${total} tokens`},`
      + ` ${Math.round(r.wallClockMs / 100) / 10}s,`
      + ` ${r.toolCalls.length} tool call(s), ${r.stepCount} step(s))`,
    );
  }

  lines.push(
    '',
    'Nothing was learned about the task. This is a failed delegation, not information '
    + 'about the task or the environment: do not infer a cause from it, and do not repeat '
    + 'it back as a finding.',
  );

  return lines.join('\n');
}

/** The evaluator executes any JS-family code fence in this text, so runnable work is scored on whether it runs. */
function headTrajectory(r: HeadReport): string {
  const parts: string[] = [r.summary];

  for (const d of r.decisions) parts.push(`Decision — ${d.question}: ${d.choice} (${d.rationale})`);

  for (const e of r.evidence) parts.push(`Evidence [${e.kind}]: ${e.body}`);

  for (const a of r.artifactRefs) parts.push(`Artifact (${a.kind}): ${a.ref}${a.description ? ` — ${a.description}` : ''}`);

  return parts.join('\n').trim();
}

/** No score in the text: null (dropped, never 0). A failing judge propagates rather than looking unscoreable. */
async function scoreMergeNarrative(judge: LLM, rationale: string, narrative: string): Promise<number | null> {
  const prompt = `You are scoring how well a synthesized answer resolves a task that was explored by several parallel reasoning heads.

Task / split rationale:
${evidenceWindow(rationale, EVIDENCE_BUDGETS.mergeRationale)}

Synthesized answer:
${evidenceWindow(narrative, EVIDENCE_BUDGETS.mergeNarrative)}

Score from 0.0 to 1.0 for how completely and correctly the answer resolves the task: specific and grounded beats vague.
JSON shape:
{"score": <float 0.0-1.0>, "rationale": "<15 words max>"}
${jsonObjectOnlyInstruction()}`;

  const text = await judge.complete(prompt);
  const match = text.match(/"score"\s*:\s*(-?\d+(?:\.\d+)?)/);

  if (!match) return null;
  const score = Number(match[1]);

  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null;
}

function fallbackNarrative(reports: readonly HeadReport[], rationale: string, errMsg: string): string {
  const lines: string[] = [];
  lines.push(`Merge synthesis unavailable (${errMsg}). Per-head summaries:`);
  lines.push('');
  lines.push(`Reason for split: ${rationale}`);
  lines.push('');

  for (const r of reports) {
    lines.push(`### Head ${r.id} (${r.status}${headProducedFindings(r) ? '' : ' — produced no findings'})`);
    lines.push(r.summary);
    lines.push('');
  }

  return lines.join('\n');
}

interface MergePromptInput {
  readonly reports: readonly HeadReport[];
  readonly rationale: string;
  readonly strategy: MergeStrategy;
  readonly inheritedContext: readonly SerializedMessage[];
  readonly headScores: readonly HeadScore[];
}

function buildMergePrompt({ reports, rationale, strategy, inheritedContext, headScores }: MergePromptInput): string {
  const strategyGuidance = {
    synthesize: 'Synthesize the heads\' findings into a single coherent narrative. Reconcile disagreements explicitly; prefer the head with stronger evidence.',
    best_of: 'Pick the strongest single head\'s narrative. Briefly cite weaker heads only for what they add.',
    consensus: 'Emphasize areas of agreement across heads. Surface disagreements as explicit unresolved questions.',
  } satisfies Record<MergeStrategy, string>;

  const recentContext = inheritedContext.slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`)
    .join('\n');

  const scoreById = new Map(headScores.map((s) => [s.id, s]));

  const headSections = reports.map((r) => {
    // All evidence with full bodies: the merge is where information must not be lost.
    const evList = r.evidence.length === 0
      ? '  (none)'
      : r.evidence
        .map((e) => `  - [${e.kind}${e.confidence != null ? ` conf=${e.confidence.toFixed(2)}` : ''}${e.ref ? ` ref=${e.ref}` : ''}] ${e.body}`)
        .join('\n');

    const decList = r.decisions.length === 0
      ? '  (none)'
      : r.decisions.map((d) => `  - Q: ${d.question}\n    A: ${d.choice}\n    Why: ${d.rationale}`).join('\n');

    const artList = r.artifactRefs.length === 0
      ? ''
      : `\n\nArtifacts:\n${r.artifactRefs.map((a) => `  - (${a.kind}) ${a.ref}${a.description ? ` — ${a.description}` : ''}`).join('\n')}`;

    const s = scoreById.get(r.id);
    const scoreTag = s ? ` — grounded outcome ${s.score.toFixed(2)} (${s.grounding})` : '';
    const emptyTag = headProducedFindings(r) ? '' : ' — PRODUCED NO FINDINGS';

    return `## Head ${r.id} (${r.status}${emptyTag})${scoreTag}
Summary:
${r.summary}

Decisions:
${decList}

Evidence:
${evList}${artList}`;
  }).join('\n\n');

  const scoreGuidance = headScores.length > 0
    ? '\nEach head carries a grounded outcome score (execution-verified when it left runnable code); weight higher-scoring heads more heavily when they conflict.\n'
    : '';

  // Without this the model reads a head's silence as a signal and narrates a cause.
  const emptyCount = reports.length - reports.filter(headProducedFindings).length;

  const emptyGuidance = emptyCount > 0
    ? `\n${emptyCount} of ${reports.length} heads are marked PRODUCED NO FINDINGS: they stopped before recording anything. Say plainly that they did not complete and contributed nothing. Do NOT state or imply why they stopped, and do NOT turn their silence into a claim about the environment, the tooling, or the task.\n`
    : '';

  return `You are merging the findings of ${reports.length} parallel reasoning heads.

Split rationale: ${rationale}

Merge strategy: ${strategy}
Strategy guidance: ${strategyGuidance[strategy]}
${scoreGuidance}${emptyGuidance}
Recent conversation context:
${recentContext || '(none)'}

Heads' reports:
${headSections}

JSON object shape with EXACTLY these keys and types (use [] for empty lists):
{
  "narrative": "<coherent unified narrative — the response the parent head writes back to the user>",
  "selected_decisions": [{ "question": "<question>", "choice": "<final answer>", "rationale": "<why>" }],
  "unresolved_questions": ["<open question>"],
  "recommendations": ["<short imperative next step>"],
  "blind_spots": ["<aspect of the task NO head addressed>"]
}
selected_decisions, unresolved_questions, recommendations and blind_spots MUST be JSON arrays (never objects).
The narrative should be specific and grounded in the heads' evidence; do not reference the merge process itself.
blind_spots is the one field you cannot fill by summarizing the reports: re-read the split rationale, consider what a complete answer to it would have to cover, and name the parts NO head looked at. A question a head RAISED is an unresolved_question; a blind spot is ground none of them thought to check, so nothing in their reports points at it — heads given adjacent tasks tend to share an assumption, and that shared assumption is what to look for. Return [] if the heads covered the task between them: an empty list is the honest answer, and a generic entry is worse than none.
${jsonObjectOnlyInstruction()}`;
}
