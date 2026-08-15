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
 * not block the others. Heads run to completion; a deadline is raced only when
 * the caller asked for one. Spend is the mission budget governor's ledger, not
 * a per-head pool — the merge cost summary reports what a split actually cost.
 */

import * as v from 'valibot';
import { nanoid } from '../utils/nanoid.js';
import { jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
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
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
} from './types.js';
import { HeadJournal } from './journal.js';
import { headProducedFindings } from './head-summary.js';
import { MergeOutputSchema, type MergeOutput } from './merge-schema.js';
import { evaluateWithMultiModelJudging, median } from '../mcts/evaluation.js';
import type { LLM, Executor } from '../types/primitives.js';
import type { WorkMode } from '../prompting/surface.js';

/** What the merge LLM should return. Validated by MergeOutputSchema. */
export type MergeLLMFn = (
  prompt: string,
  responseSchema: typeof MergeOutputSchema,
) => Promise<MergeOutput>;

/**
 * Optional execution-grounding seam for the heads path — the SAME grounded
 * evaluator + median ensemble the MCTS engine uses (mcts/evaluation.ts), so a
 * head's outcome and the merge are real signals, not heuristics. When present:
 *   • each head's report is scored by evaluateWithMultiModelJudging → a real
 *     [0,1] outcome (execution band when the head left runnable code, else judge);
 *   • the merge runs `mergeSamples` independent synthesis samples and keeps the
 *     median-scored one (parse-robust: a failed sample is dropped, never a 0).
 * Omitting it preserves the old n=1, neutral-score behavior (tests opt in).
 */
export interface HeadGrounding {
  /** Runs a head's runnable code for a pass/fail verdict (shared executor). */
  readonly executor: Executor;
  /** The explorer model — judges when no cross-model judge is set. */
  readonly explorer: LLM;
  /** Cross-model judge (documented self-enhancement-bias fallback to explorer). */
  readonly judge?: LLM;
  /** Judge ensemble size per head score. Default DEFAULT_CONFIG.mcts.judgeSamples. */
  readonly judgeSamples?: number;
  /** Per-head-score LLM-call budget. Default DEFAULT_CONFIG.mcts.maxEvalLLMCalls. */
  readonly maxEvalLLMCalls?: number;
  /** Independent merge synthesis samples; median-scored one wins. Default
   *  DEFAULT_CONFIG.heads.mergeSamples. */
  readonly mergeSamples?: number;
}

/** What the controller asks the runtime to do per child head. */
export interface SpawnedHead {
  readonly id: HeadId;
  /** Kicks off the head; resolves with its report on completion. */
  run(): Promise<HeadReport>;
  /** Best-effort abort — used when a caller-requested deadline passes. */
  abort(reason: string): Promise<void>;
}

/** Runtime adapter the controller depends on. */
export interface HeadRuntime {
  /** Spawn a head and return a handle. Called once per child in SplitRequest.heads. */
  spawnHead(input: HeadInput): Promise<SpawnedHead>;
  /** Run the merge LLM with structured output enforcement. */
  mergeLLM: MergeLLMFn;
  /** Execution-grounding seam — when set, head scores + the merge are grounded
   *  + ensembled (see HeadGrounding). Omit ⇒ n=1 merge, empty head scores. */
  grounding?: HeadGrounding;
}

/** Build a HeadController. */
/**
 * Phase event the host can subscribe to — fired with the actual head IDs
 * the controller spawned (not a guess from the tool side).
 */
export type SplitPhaseEvent =
  | { kind: 'split'; rootId: HeadId; headIds: readonly HeadId[]; rationale: string }
  /** Carries the whole cost summary rather than a copied-out head count, so a
   *  new outcome figure reaches the run-event ledger without a second edit. */
  | { kind: 'merge'; rootId: HeadId; cost: MergeResult['costSummary']; mergedNarrative: string;
      /** Per-head file changes — carried so the run-event ledger records what a
       *  split actually did to the workspace, not only what it spent. */
      fileChanges: MergeResult['fileChanges'];
      /** Ground no head covered — carried so whether the field earns its tokens
       *  is a query over the ledger rather than a re-read of merges by hand. */
      blindSpots: MergeResult['blindSpots'] };

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
   * Fires `onPhase` once on split (with the real head IDs) and once on
   * merge — used by the host to fan out to SSE / event log / UI.
   */
  async run(opts: {
    parentHeadId: HeadId | null;
    rootId?: HeadId;
    inheritedContext: SerializedMessage[];
    request: SplitRequest;
    parentBudget?: HeadBudget;
    model?: string;
    mode: WorkMode;
    /** Mission-budget labels every head in this split charges. Carried down to
     *  each HeadInput so a head running out of process can find the ledger. */
    missionLabels?: readonly string[];
    onPhase?: (event: SplitPhaseEvent) => void;
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

    const childBudget = deriveChildBudget(parentBudget);

    // Anchor the run identity before spawning so its heads group under one root
    // (top-level splits have a synthetic root with no head row of its own).
    this.journal.recordSplit(rootId, opts.request.rationale, parentBudget.spawnedAt);

    // Spawn all children concurrently.
    const spawnPromises = opts.request.heads.map(async (h, idx) => {
      const id = `${rootId}-d${childBudget.maxDepth + 1}-${idx}-${nanoid(6)}`;
      const input: HeadInput = {
        id,
        rootId,
        parentId: opts.parentHeadId,
        depth: (parentBudget.maxDepth - childBudget.maxDepth),
        task: h.task,
        mode: opts.mode,
        rationale: h.rationale,
        inheritedContext: opts.inheritedContext,
        budget: childBudget,
        // Per-head model wins over the parent default — enables heterogeneous
        // model fleets (multi-agent debate / panel-of-experts).
        model: h.model ?? opts.model,
        allowedTools: h.allowedTools,
        mergeStrategy: strategy,
      };
      if (opts.missionLabels?.length) Object.assign(input, { missionLabels: opts.missionLabels });
      this.journal.insertSpawn(input);
      return this.runtime.spawnHead(input);
    });

    const handles = await Promise.all(spawnPromises);
    const startedAt = Date.now();

    // Fire 'split' with the REAL head ids the controller just spawned.
    opts.onPhase?.({
      kind: 'split',
      rootId,
      headIds: handles.map((h) => h.id),
      rationale: opts.request.rationale,
    });

    // Heads run to completion. Only when the caller asked for a deadline is one
    // raced against — measured from when the heads finished spawning
    // (`startedAt`), NOT from `spawnedAt`: sub-agent cold-start can take tens of
    // seconds and must not be charged against the head's own
    // time-to-produce-a-report.
    const reports = await Promise.all(
      handles.map(async (h): Promise<HeadReport> => {
        const remainingMs = parentBudget.maxWallClockMs === undefined
          ? undefined
          : parentBudget.maxWallClockMs - (Date.now() - startedAt);
        try {
          const report = await raceWithTimeout(h, remainingMs);
          this.journal.recordReport(report);
          return report;
        } catch (err) {
          // Either the abort failed or a requested deadline blew.
          const failed: HeadReport = {
            id: h.id,
            status: 'budget_exceeded',
            summary: 'Head was aborted before producing a report.',
            evidence: [],
            decisions: [],
            artifactRefs: [],
            fileChanges: [],
            childHeadIds: [],
            toolCalls: [],
            steps: [],
            tokenUsage: { input: 0, output: 0, total: 0 },
            wallClockMs: Date.now() - startedAt,
            errorMessage: err instanceof Error ? err.message : String(err),
          };
          this.journal.recordReport(failed);
          return failed;
        }
      }),
    );

    // Ground each head's report into a real [0,1] outcome (execution-banded
    // when the head left runnable code, else median judge) — the SAME evaluator
    // the MCTS engine uses. Empty when the runtime has no grounding seam.
    const headScores = await this.scoreHeads(reports, opts.request.rationale, opts.mode);

    // Synthesize via LLM (k-sample median when grounded; n=1 otherwise).
    const mergeResult = await this.merge(
      reports,
      opts.request.rationale,
      strategy,
      opts.inheritedContext,
      parentBudget,
      opts.mode,
      handles.map((h) => h.id),
      headScores,
    );
    this.journal.cacheMerge(rootId, mergeResult, strategy);
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
   * Score each head's report. With a grounding seam, each report becomes a
   * candidate "trajectory" passed to the SHARED grounded evaluator
   * (mcts/evaluation.ts): any runnable code it left is executed for a pass/fail
   * band, so a head whose work ran outscores one whose didn't. A non-completed
   * head gets the floor (0) without a judge call. Always returns one entry per
   * head carrying the head's text + status (the Alternate-Takes candidate); when
   * no grounding seam is wired the score is a neutral 0.5 (no grounded signal).
   */
  private async scoreHeads(
    reports: readonly HeadReport[],
    rationale: string,
    mode: WorkMode,
  ): Promise<readonly HeadScore[]> {
    const g = mode === 'plan' ? undefined : this.runtime.grounding;
    const siblings = reports.map(headTrajectory);
    return Promise.all(
      reports.map(async (r, i): Promise<HeadScore> => {
        const base = { id: r.id, text: r.summary, status: r.status } as const;
        // No grounding seam → no honest outcome signal; a neutral score keeps
        // the take candidate without inventing a verdict.
        if (!g) return { ...base, score: 0.5, grounding: 'judge' };
        // A head that never completed produced no trustworthy outcome — floor it
        // without a judge call so it ranks below a head that ran.
        if (r.status !== 'completed') return { ...base, score: 0, grounding: 'judge' };
        const evaluation = await evaluateWithMultiModelJudging({
          task: rationale,
          trajectory: siblings[i]!,
          siblings: siblings.filter((_, j) => j !== i),
          executor: g.executor,
          explorer: g.explorer,
          judge: g.judge,
          judgeSamples: g.judgeSamples,
          maxLLMCalls: g.maxEvalLLMCalls,
        });
        return { ...base, score: evaluation.score, grounding: evaluation.grounding };
      }),
    );
  }

  /**
   * Run the merge synthesis.
   *
   * With a grounding seam this is a k-sample median ensemble (mergeSamples
   * independent synthesis samples, each scored by the grounded judge; the
   * median-scored one is kept — parse-failed samples are dropped, never a 0).
   * Without one it is the legacy n=1 call. Either way the prompt carries each
   * head's FULL evidence + artifacts (no 6×200-char clipping) so no finding is
   * lost on the way into the merge.
   */
  async merge(
    reports: readonly HeadReport[],
    rationale: string,
    strategy: MergeStrategy,
    inheritedContext: readonly SerializedMessage[],
    parentBudget: HeadBudget,
    mode: WorkMode,
    headIds: readonly HeadId[] = reports.map((r) => r.id),
    headScores: readonly HeadScore[] = [],
  ): Promise<MergeResult> {
    const grounded = mode !== 'plan' && this.runtime.grounding != null;
    const costSummary = summarizeCost(reports, parentBudget);
    const fileChanges = collectFileChanges(reports);

    // Nothing to synthesize: every head stopped without banking a finding.
    // Asking an LLM to narrate that makes it invent a cause it cannot know — a
    // real split told its parent "the immediate blockage is the sandbox
    // provisioning failure" when both heads had merely run out of budget. So
    // the empty split is reported deterministically and never reaches a model.
    if (costSummary.headsWithFindings === 0) {
      return {
        mergedNarrative: emptySplitNarrative(reports, rationale),
        selectedDecisions: [],
        unresolvedQuestions: [],
        recommendations: [],
        // No head observed anything, so there is no negative space to report —
        // naming one here would be the same invention the empty split exists to
        // prevent.
        blindSpots: [],
        evidenceAggregate: [],
        headIds,
        headScores,
        fileChanges,
        grounded,
        costSummary,
      };
    }

    const prompt = buildMergePrompt(reports, rationale, strategy, inheritedContext, grounded ? headScores : []);
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

  /**
   * One validated merge synthesis, or the median-scored one of `mergeSamples`
   * when grounded. Returns the surfaced error reason when every sample fails
   * (LLM throw / schema invalid) — the caller renders the per-head fallback.
   */
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
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    if (samples.length === 1) return { ok: true, output: samples[0]! };

    // Score each candidate synthesis with the grounded judge and keep the
    // median — the same median ensemble the MCTS evaluator uses.
    const judge = g.judge ?? g.explorer;
    const scored = await Promise.all(
      samples.map(async (s) => ({ sample: s, score: await scoreMergeNarrative(judge, rationale, s.narrative) })),
    );
    const usable = scored.filter((x): x is { sample: MergeOutput; score: number } => x.score !== null);
    if (usable.length === 0) return { ok: true, output: samples[0]! };
    const medianScore = median(usable.map((x) => x.score));
    // Pick the sample whose score is closest to the median.
    const winner = usable.reduce((best, cur) =>
      Math.abs(cur.score - medianScore) < Math.abs(best.score - medianScore) ? cur : best,
    );
    return { ok: true, output: winner.sample };
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/** Await a spawned head, racing a caller-requested deadline when there is one.
 *  `undefined` — the default — means the head runs until it is done, the same
 *  envelope the turn that forked it gets. Shared with the Steer-as-Branch
 *  single-head runner (steer-branch.ts). */
export async function raceWithTimeout(h: SpawnedHead, timeoutMs: number | undefined): Promise<HeadReport> {
  if (timeoutMs === undefined) return h.run();
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

/** Each head's change set, heads that changed nothing omitted. A report arrives
 *  over a DO RPC boundary, so tolerate a missing array exactly as the journal's
 *  step recording does. */
function collectFileChanges(reports: readonly HeadReport[]): MergeResult['fileChanges'] {
  return reports
    .filter((r) => (r.fileChanges?.length ?? 0) > 0)
    .map((r) => ({ id: r.id, changes: r.fileChanges }));
}

function summarizeCost(reports: readonly HeadReport[], parentBudget: HeadBudget): MergeResult['costSummary'] {
  return {
    headCount: reports.length,
    headsWithFindings: reports.filter(headProducedFindings).length,
    totalTokens: reports.reduce((acc, r) => acc + r.tokenUsage.total, 0),
    totalWallClockMs: Math.max(0, ...reports.map((r) => r.wallClockMs)),
    maxDepth: parentBudget.maxDepth,
  };
}

/** The narrative for a split where no head banked anything. Deterministic by
 *  construction: it states each head's status and cost and nothing else, so the
 *  parent cannot be handed a cause that nobody observed. */
function emptySplitNarrative(reports: readonly HeadReport[], rationale: string): string {
  const lines = [
    `No head produced findings. ${reports.length} head(s) were spawned to explore: ${rationale}`,
    '',
  ];
  for (const r of reports) {
    lines.push(
      `- Head ${r.id}: ${r.status}${r.errorMessage ? ` — ${r.errorMessage}` : ''}`
      + ` (${r.tokenUsage.total} tokens, ${Math.round(r.wallClockMs / 100) / 10}s,`
      + ` ${r.toolCalls.length} tool call(s), ${r.steps.length} step(s))`,
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

/** Flatten a head's report into the trajectory the grounded evaluator scores:
 *  its summary + every decision + every evidence body + artifact refs. The
 *  evaluator pulls any JS-family code fence out of this for execution grounding,
 *  so a head that left runnable code is scored on whether it RUNS, not vibes. */
function headTrajectory(r: HeadReport): string {
  const parts: string[] = [r.summary];
  for (const d of r.decisions) parts.push(`Decision — ${d.question}: ${d.choice} (${d.rationale})`);
  for (const e of r.evidence) parts.push(`Evidence [${e.kind}]: ${e.body}`);
  for (const a of r.artifactRefs) parts.push(`Artifact (${a.kind}): ${a.ref}${a.description ? ` — ${a.description}` : ''}`);
  return parts.join('\n').trim();
}

/** Score ONE merge synthesis narrative for how well it answers the split — the
 *  k-sample-median selector over merge candidates. Mirrors a judge sample in
 *  evaluation.ts: unparseable/failed → null (dropped, never 0). */
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
  let text: string;
  try {
    text = await judge.complete(prompt);
  } catch {
    return null;
  }
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

function buildMergePrompt(
  reports: readonly HeadReport[],
  rationale: string,
  strategy: MergeStrategy,
  inheritedContext: readonly SerializedMessage[],
  headScores: readonly HeadScore[] = [],
): string {
  const strategyGuidance = {
    synthesize: 'Synthesize the heads\' findings into a single coherent narrative. Reconcile disagreements explicitly; prefer the head with stronger evidence.',
    best_of: 'Pick the strongest single head\'s narrative. Briefly cite weaker heads only for what they add.',
    consensus: 'Emphasize areas of agreement across heads. Surface disagreements as explicit unresolved questions.',
  } satisfies Record<MergeStrategy, string>;

  // Last ~6 turns of context as framing; cap to avoid blowing the merge prompt.
  const recentContext = inheritedContext.slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`)
    .join('\n');

  const scoreById = new Map(headScores.map((s) => [s.id, s]));
  const headSections = reports.map((r) => {
    // Pass ALL evidence with full bodies — no 6×200-char clipping; the merge is
    // where information must NOT be lost. Same for decisions + artifact refs.
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

  // A head that stopped before banking anything observed nothing. Without this
  // the model reads its silence as a signal and narrates a cause for it.
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
