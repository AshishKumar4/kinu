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
import { nanoid } from '../utils/nanoid';
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
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
} from './types';
import { headProducedFindings } from './head-summary';
import { MergeOutputSchema, type MergeOutput } from './merge-schema';
import { evaluateWithMultiModelJudging, median } from '../mcts/evaluation';
import { DEFAULT_CONFIG } from '../config';
import type { LLM, Executor } from '../types/primitives';
import type { WorkMode } from '../prompting/surface';
import { addUsage, usageTotal, type Usage } from '../usage';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

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

/**
 * Where a split's journal rows land.
 *
 * A port rather than the concrete `HeadJournal` because a RECURSIVE split
 * runs on a facet that must not keep a journal of its own. When a depth-1 head
 * journalled locally, its children's spawn/report rows lived on that
 * intermediate facet while their step rows were written to the root, so the
 * surface's `head_journal` -> `head_steps` join could never match and a depth-2
 * head was unreadable from anywhere. Both halves now go to the same place.
 *
 * `HeadJournal` satisfies this structurally; the CF facet supplies an
 * RPC-backed implementation pointed at its root orchestrator. Each method may
 * be async for that reason.
 */
export interface HeadJournalPort {
  recordSplit(rootId: HeadId, rationale: string, spawnedAt: number): void | Promise<void>;
  insertSpawn(input: HeadInput): void | Promise<void>;
  recordReport(report: HeadReport): void | Promise<void>;
  cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void | Promise<void>;
}

/**
 * The ROOT's journal: the port plus the two reads only a run's root can serve.
 *
 * Run reclamation resolves a top-level split's identity against every unfinished
 * run in the store. That is a whole-store operation, so a facet holding an RPC port
 * aimed at its root cannot answer it and must not pretend to — it never needs to,
 * because a recursive split always carries a `parentHeadId` and so never resolves a
 * top-level run. `HeadJournal` satisfies this structurally.
 *
 * ONE CAPABILITY, not two. `abandonRunning` used to be here as well, because
 * reclaiming a run also retired its heads. A re-drive now RE-OPENS them instead, and
 * the transition that does it is `insertSpawn`, which this port already carries — so
 * the terminal writer is no longer any of this controller's business.
 */
export interface HeadRootJournal extends HeadJournalPort {
  findResumableRun(task: string): HeadId | null;
}

function isRootJournal(journal: HeadJournalPort): journal is HeadRootJournal {
  return 'findResumableRun' in journal;
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

/**
 * NOTHING IS WRITTEN ON A BRANCH A RE-DRIVE TAKES OVER, and the absence is the fix.
 *
 * There used to be a `RECLAIMED_RUN_REASON` here — "Interrupted before it reported.
 * This fork was restarted, and the branches below it are the retry." — stamped onto
 * every unreported row of the reclaimed run by {@link HeadController.resolveTopLevelRun}
 * and rendered verbatim on the Exploration surface. It was the fork twin of the swarm's
 * own defect and it multiplied the same way: the run id was reclaimed, its rows were
 * retired, and then the split minted a FRESH id per head, so one request accumulated
 * `heads.length` aborted rows per re-drive. The owner read that as
 * `Systemfork interrupted` over a pile of failed branches.
 *
 * A head that was spawned and never reported is UNFINISHED WORK. A re-drive re-runs
 * it under its OWN id, so the row is RE-OPENED rather than retired — the shared
 * transition is `HeadJournal.insertSpawn`, which both this controller and the swarm's
 * re-entry reach, and it is the only place either of them resets a head row.
 *
 * The one caller that may still retire a head is the start-of-life reconciliation, for
 * a root whose durable job the resume gate could not re-drive (`heads/reconcile.ts`) —
 * the one place where "no report will arrive" is a true statement.
 */

/** The score a head carries when nothing grounded can be said about it — no
 *  judge is wired, or the one that is could not be reached. Mid-range on
 *  purpose: a 0 would rank a head below one that genuinely failed, and a 1
 *  would credit work nobody scored. */
const NO_GROUNDED_SIGNAL = 0.5;

export class HeadController {
  constructor(
    private readonly runtime: HeadRuntime,
    private readonly journal: HeadJournalPort,
  ) {}

  /**
   * The run identity a top-level split writes under: the unfinished run for
   * this task if there is one, else a fresh id.
   *
   * This is what makes a fork's identity survive a re-drive. A detached fork's
   * background job is re-driven by evict/exit recovery, which for heads means
   * re-running them — they are ephemeral facets with no durable checkpoint, so
   * a resume has nothing else to continue from. Minting a fresh id there turned
   * ONE request into one run per re-drive: the owner saw four near-identical
   * `merged · 5 branches` rows for a single ask, each of which had really spawned
   * and paid for its own five heads.
   *
   * THE RECLAIMED ATTEMPT'S HEADS ARE RE-RUN, not retired. Their ids are derived
   * rather than minted (see {@link run}), so re-spawning them re-opens the rows they
   * already have and one request holds `heads.length` rows however many times it is
   * re-driven. Retiring them and minting fresh ids is what put `heads.length` aborted
   * branches per re-drive on the surface.
   */
  private resolveTopLevelRun(task: string): HeadId {
    const journal = this.journal;
    if (!isRootJournal(journal)) {
      // Not a degrade: minting a fresh id here is exactly the defect above, so a
      // facet's port reaching this is a wiring error and says so.
      throw new Error(
        'A top-level split must run against the ROOT workspace journal — run reclamation reads every '
        + 'unfinished run in the store. A recursive split has to pass parentHeadId.',
      );
    }
    return journal.findResumableRun(task) ?? nanoid();
  }

  /**
   * Run a full split → await → merge cycle for the parent head identified
   * by `parentHeadId` (or undefined if this is the root split from the
   * orchestrator's main turn).
   *
   * Returns the MergeResult; also writes the cached merge into the journal.
   * Fires `onPhase` once on split (with the real head IDs) and once on
   * merge — used by the host to fan out to SSE / event log / UI.
   */
  async run(opts: ({ parentHeadId: null } | { parentHeadId: HeadId; parentDepth: number }) & {
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
    const rootId = opts.rootId ?? opts.parentHeadId ?? this.resolveTopLevelRun(opts.request.rationale);
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

    // Only the root owns run identity and final settlement. Nested reports share its journal.
    if (opts.parentHeadId === null) {
      const splitRecorded = this.journal.recordSplit(rootId, opts.request.rationale, parentBudget.spawnedAt);
      if (splitRecorded !== undefined) await splitRecorded;
    }

    // Spawn all children concurrently, each isolated: a spawn that throws
    // settles only its own head (errored report, journaled below) and never
    // reaches Promise.all, so a sibling's report is never lost with it.
    const spawnPromises = opts.request.heads.map(async (h, idx): Promise<SpawnedHead | HeadReport> => {
      /**
       * THE HEAD'S ID IS DERIVED, NEVER MINTED, and that one change is what makes a
       * re-drive reuse this branch instead of adding one.
       *
       * A head has no durable checkpoint — it is an ephemeral facet — so a re-drive
       * can only re-run it. What it must NOT do is re-run it as a NEW branch: the
       * previous attempt's row was then retired and a fresh `nanoid` row took its
       * place, so one request grew `heads.length` rows per attempt. Derived from the
       * BRANCH POINT and the slot, the id is the same on every attempt, and
       * `HeadJournal.insertSpawn` re-opens the row it already has.
       *
       * KEYED ON THE PARENT and not on the root, which is also a correctness fix: two
       * different parents splitting at the same depth under one root produced the same
       * `${rootId}-d${depth}-${idx}` prefix, and only the random suffix kept them
       * apart. A parent id is unique, so parent-plus-slot is unique without it.
       */
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
        // Per-head model wins over the parent default — enables heterogeneous
        // model fleets (multi-agent debate / panel-of-experts).
        model: h.model ?? opts.model,
        allowedTools: h.allowedTools,
        mergeStrategy: strategy,
      };
      if (opts.missionLabels?.length) Object.assign(input, { missionLabels: opts.missionLabels });
      // Same as recordSplit above: a local journal writes the row before this
      // returns, and nothing may push that write behind a microtask.
      const spawnRecorded = this.journal.insertSpawn(input);
      if (spawnRecorded !== undefined) await spawnRecorded;
      try {
        return await this.runtime.spawnHead(input);
      } catch (err) {
        // Same shape the deadline arm below records: nothing ran, so the usage
        // is unknown (`{}`), and the reason travels in `errorMessage`. Writing
        // the report here moves the row out of `running`.
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
    // Only heads that actually spawned hold a handle. The split event carries
    // exactly these ids — never a head that failed to spawn.
    const handles: SpawnedHead[] = [];
    for (const s of settled) {
      if ('run' in s) handles.push(s);
    }
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
      settled.map(async (s): Promise<HeadReport> => {
        // A head whose spawn failed already banked its errored report above; it
        // rejoins here in its original slot so the merge still sees every head.
        if (!('run' in s)) return s;
        const h = s;
        const remainingMs = parentBudget.maxWallClockMs === undefined
          ? undefined
          : parentBudget.maxWallClockMs - (Date.now() - startedAt);
        try {
          const report = await raceWithTimeout(h, remainingMs);
          await this.journal.recordReport(report);
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
            toolCalls: [], stepCount: 0,
            // Nothing ran, so nothing was reported: `{}`, not a set of zeros.
            // This head may well have burned tokens before the deadline cut it
            // off — the honest record is that we do not know how many.
            usage: {},
            wallClockMs: Date.now() - startedAt,
            errorMessage: renderThrownChain({ cause: err }),
          };
          await this.journal.recordReport(failed);
          return failed;
        }
      }),
    );

    // Ground each head's report into a real [0,1] outcome (execution-banded
    // when the head left runnable code, else median judge) — the SAME evaluator
    // the MCTS engine uses. Empty when the runtime has no grounding seam.
    const headScores = await this.scoreHeads(rootId, reports, opts.request.rationale, opts.mode);

    // Synthesize via LLM (k-sample median when grounded; n=1 otherwise).
    const mergeResult = await this.merge(
      reports,
      opts.request.rationale,
      strategy,
      opts.inheritedContext,
      parentBudget,
      opts.mode,
      reports.map((r) => r.id),
      headScores,
    );
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
   * Score each head's report. With a grounding seam, each report becomes a
   * candidate "trajectory" passed to the SHARED grounded evaluator
   * (mcts/evaluation.ts): any runnable code it left is executed for a pass/fail
   * band, so a head whose work ran outscores one whose didn't. A non-completed
   * head gets the floor (0) without a judge call. Always returns one entry per
   * head carrying the head's text + status (the Alternate-Takes candidate); when
   * no grounded signal is available the score is a neutral
   * {@link NO_GROUNDED_SIGNAL}.
   *
   * Settled per head, because the evaluator's judge is a PROVIDER call and this
   * caller has no branch to fail. The MCTS engine drives the same evaluator
   * under its own allSettled and answers a judge failure by reporting the
   * branch failed and scoring it 0; there is no equivalent here — a rejection
   * propagates out of `run` and takes the whole split with it, so a single 429
   * discards findings the heads have already produced and paid for, the merge
   * that would have carried them, and the `head_merge` ledger row that is the
   * only durable trace a fork ran at all. The heads' work outlives its judge.
   *
   * A head whose judge could not be reached is therefore scored exactly as one
   * with no grounding seam — that IS its epistemic state — and the reason is
   * stated on the way past, because a neutral score is otherwise
   * indistinguishable from a workspace that never wired a judge.
   */
  private async scoreHeads(
    rootId: HeadId,
    reports: readonly HeadReport[],
    rationale: string,
    mode: WorkMode,
  ): Promise<readonly HeadScore[]> {
    const g = mode === 'plan' ? undefined : this.runtime.grounding;
    // Heads reuse the MCTS judge knobs, so they inherit its clamp: the ensemble
    // shares one per-head-score call pool with check generation, and a request
    // the pool cannot fund is realised lower. Disclosed by name from the
    // evaluator's own answer, once per realised size — the engine discloses it
    // the same way, for the same reason.
    const judgeSamplesRequested = g?.judgeSamples ?? DEFAULT_CONFIG.mcts.judgeSamples;
    const reportedClampedEnsembles = new Set<number>();
    const siblings = reports.map(headTrajectory);
    const settled = await Promise.allSettled(
      reports.map(async (r, i): Promise<HeadScore> => {
        const base = { id: r.id, text: r.summary, status: r.status } as const;
        // No grounding seam → no honest outcome signal; a neutral score keeps
        // the take candidate without inventing a verdict.
        if (!g) return { ...base, score: NO_GROUNDED_SIGNAL, grounding: 'judge' };
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
      const r = reports[i]!;
      // The reason itself, not its `message`: a provider error carries the url
      // and cause that say WHICH judge broke, and AI SDK call errors routinely
      // have an empty message.
      diagnostics.failure(
        'head.score_failed',
        toKinuError({ doing: 'score a head report', cause: outcome.reason, otherwise: 'unavailable' }),
        { headId: r.id },
      );
      return { id: r.id, text: r.summary, status: r.status, score: NO_GROUNDED_SIGNAL, grounding: 'judge' };
    });
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
    if (samples.length === 1) return { ok: true, output: samples[0]! };

    // Score each candidate synthesis with the grounded judge and keep the
    // median — the same median ensemble the MCTS evaluator uses.
    //
    // Settled, for the reason scoreHeads is: the judge is a PROVIDER call, and
    // k valid syntheses are already in hand. `score === null` below already
    // degrades to the first sample, so a judge that answers unusably costs the
    // ensemble and not the merge — but under Promise.all a judge that REJECTS
    // took the whole synthesis with it, discarding those samples and the
    // head_merge row. Only reachable with mergeSamples > 1, which is why no
    // test caught it; k defaults to 1.
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
      return { sample: samples[i]!, score: null };
    });
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
    timeoutHandle = setTimeout(async () => {
      // The deadline first owns the abort, then rejects the caller-visible race:
      // this timer must not leave a live head after it has declared a timeout.
      try {
        await h.abort('wall-clock budget exhausted');
      } catch (cause) {
        // A head that survives its abort is a live facet nobody is waiting
        // for; inside this timer callback there is no caller to throw to, so
        // the failure is STATED here — the classified log the caller-facing
        // zero-budget path above throws for the same reason.
        diagnostics.failure(
          'head.abort_failed',
          toKinuError({ doing: 'abort a head whose wall-clock budget expired', cause, otherwise: 'timeout' }),
          { headId: h.id },
        );
      }
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
  // `addUsage` is absence-preserving, which is the whole reason no gate is
  // needed here: a head aborted before its first model call carries `{}` and
  // contributes nothing, so the accumulator stays empty unless some head really
  // reported. `usageTotal` then answers undefined for exactly that split, and it
  // declines to name a cost rather than claiming the delegation was free.
  const usage = reports.reduce<Usage>((acc, r) => addUsage(acc, r.usage), {});
  return {
    headCount: reports.length,
    headsWithFindings: reports.filter(headProducedFindings).length,
    totalTokens: usageTotal(usage),
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
    // A head the provider never reported on gets "tokens unreported", not
    // "0 tokens" — this narrative goes into the parent's context verbatim, and
    // "0 tokens" would tell the agent the fork was free when in fact its cost is
    // simply unknown.
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
 *  evaluation.ts: text that carries no score → null (dropped, never 0). A judge
 *  that FAILS is not a low score and is not dropped — it propagates, so a
 *  broken judge cannot look like every candidate being unscoreable. */
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
