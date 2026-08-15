/**
 * The compaction extension — Proteus's `transformContext` adapter over the
 * published better-compact ladder engine.
 *
 * Encode the durable history to IR turns, run the engine (cached-plan replay
 * when the prefix still holds, else build/persist/apply a fresh plan), decode
 * back to ModelMessages. Deterministic prune stages run synchronously;
 * assistant-run summaries and the last-resort prefix summary go through ONE
 * injected `summarize` callback:
 *
 *  - assistant runs use the core per-run prompt already embedded in each
 *    summary job by the ladder;
 *  - the first prefix summary uses Proteus's tuned handoff template
 *    (`buildCompactionSummaryPrompt` — Active Task verbatim → Remaining Work,
 *    recall-first, secret redaction, iterative updates), the single summary
 *    spec the old single-shot path used, wrapped in the [CONTEXT CHECKPOINT]
 *    preamble; published core rolls that checkpoint across later deltas.
 *
 * The checkpoint message the model actually reads carries one more thing: the
 * archive manifest (manifest.ts), appended deterministically to the ladder's
 * synthesized turn so the compacted mass is navigable at a glance rather than
 * only greppable. It is rendered from the durable archive index, never from a
 * model call, and never stored in the plan — so a rolled or degraded summary
 * cannot lose it.
 *
 * Everything is injected ports (transcripts/plans/logger/summarize/archive),
 * so the engine runs identically off-backend under test fakes; 2B binds the
 * real workspace-VFS transcript store, durable plan store, archive index and
 * LLM callback, and registers the extension as the default compaction path.
 */

import type { ModelMessage, TextPart } from 'ai';
import type { ProteusExtension, TransformContext } from '@proteus/core';
import {
  buildCompactionSummaryPrompt,
  stripCheckpointPreamble,
  wrapCompactionSummary,
  CONTEXT_CHECKPOINT_PREFIX,
} from '@proteus/core';
import {
  buildPlan,
  createSummaryScheduler,
  createEngine,
  formatTranscript,
  toPlanSnapshot,
  transformTurns,
  writeTranscript,
  COMPACTION_PRESETS,
  type BoundaryContextPlan,
  type BoundarySummaryJob,
  type BuildPlanInputs,
  type CompactionProfile,
  type EnginePorts,
  type PlanSnapshot,
  type ProcessResult,
  type Summarizer,
  type Turn,
} from '@better-compact/core';
import { proteusCodec, proteusSpec } from './codec.js';
import {
  deriveArchiveRange,
  renderArchiveManifest,
  withArchiveManifest,
  type ArchiveIndexStore,
} from './manifest.js';

export interface CompactionOutcomeEvent {
  sessionKey: string;
  /** 'planned' = a NEW plan rewrote the history. 'invalidated' = a cached
   *  plan was discarded after a history rewrite and nothing replaced it, so
   *  the durable view flips back to the raw stream. Both invalidate frozen
   *  positions derived from the previous stream (the DynamicContextLedger's
   *  blocks) — reset on anything but 'replayed', the deterministic cache-warm
   *  replay whose transformed prefix is byte-stable. */
  outcome: 'planned' | 'replayed' | 'invalidated';
  /** The freshly built plan, on 'planned'. */
  plan?: BoundaryContextPlan;
}

/** The ephemeral context plane, as the ladder's first rung reaches it — the
 *  core DynamicContextLedger, structurally, so this package never imports it.
 *  `dropSuperseded` drops every superseded `<dynamic_context>` block, keeps the
 *  newest (live state the model reads), and returns the tokens freed. */
export interface EphemeralContextPlane {
  dropSuperseded(): number;
}

export interface CompactionExtensionDeps {
  /** Engine ports: transcript store (citablePath must be a path the agent's
   *  own file tool can read back), plan store, logger. */
  ports: EnginePorts;
  /** Durable index of this session's archived ranges — the source the
   *  checkpoint's navigation manifest renders from. */
  archive: ArchiveIndexStore;
  /** One LLM call — prompt in, completion text out. Serves both summary
   *  kinds; failures degrade to deterministic previews, never break a turn. */
  summarize: (prompt: string) => Promise<string>;
  /** The ephemeral plane the ladder's first rung prunes. */
  ephemeral: EphemeralContextPlane;
  /** Trigger/target/recent-tool profile. Defaults to the light preset. */
  profile?: CompactionProfile;
  /** Fires whenever the model-visible stream changed shape — the ledger-reset
   *  signal (reset on 'planned' and 'invalidated', keep on 'replayed'). */
  onOutcome?: (event: CompactionOutcomeEvent) => void;
}

export function createCompactionExtension(deps: CompactionExtensionDeps): ProteusExtension {
  const profile = deps.profile ?? COMPACTION_PRESETS.light;
  const engine = createEngine(proteusSpec, deps.ports);
  const summaryScheduler = createSummaryScheduler(deps.ports.logger);

  const summarizer: Summarizer = {
    async complete(job) {
      try {
        return await deps.summarize(job.prompt);
      } catch (err) {
        deps.ports.logger.warn('Compaction summary call failed', {
          rangeStartMessageId: job.rangeStartMessageId,
          rangeEndMessageId: job.rangeEndMessageId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };

  const runJobs = (sessionKey: string, jobs: BoundarySummaryJob[]): Promise<Record<string, string>> =>
    summaryScheduler.summarize({
      sessionKey,
      jobs,
      summarizer,
      concurrency: profile.summarizerConcurrency,
    });

  const buildInputs = (ctx: TransformContext, turns: Turn[], reportedTokens: number): BuildPlanInputs => ({
    sessionKey: ctx.sessionKey,
    contextLimit: ctx.contextWindow,
    triggerRatio: profile.triggerPercent / 100,
    targetRatio: profile.targetPercent / 100,
    recentToolResultBudgetTokens: profile.recentToolTokens,
    providerReportedTokens: reportedTokens,
    citablePath: deps.ports.transcripts.citablePath,
  });

  /**
   * The ladder's FIRST rung, above every better-compact stage: under measured
   * pressure, drop the superseded `<dynamic_context>` blocks.
   *
   * They cannot be a ladder stage — they are woven per model STEP and never
   * reach the durable history a stage operates on — but they are the first
   * thing that should go: stale by definition, re-derivable from live state,
   * and paid for on every request until something removes them. Relieving here
   * means the stages below may not have to run at all, so the tokens freed are
   * subtracted from the pressure the engine is told about.
   *
   * Dropping a frozen block breaks the woven prefix, so this is gated on the
   * ladder's own trigger and nothing else. What that buys, in the two shapes
   * pressure takes:
   *
   *   a plan gets built — the prefix was going to be rewritten anyway (and
   *     `onOutcome` resets the whole ledger), so the rung costs nothing extra
   *     and only gets the accounting right: what it frees is tool output the
   *     stages below no longer have to stub.
   *   a cached plan still replays — the durable history is fine and the excess
   *     is ephemeral. This is the case the rung exists for: the engine's
   *     regrowth guard prices the prefix with the overhead recorded when the
   *     plan was BUILT (`snapshot.overheadTokens`), so blocks appended after
   *     that are invisible to it, and nothing else in the system would ever
   *     drop them. One prefix rebuild bounds a plane that otherwise only grows.
   */
  function relieveEphemeralPressure(ctx: TransformContext, turns: Turn[]): number {
    const measured = measuredTokens(ctx, turns, 0);
    const triggerTokens = Math.floor(ctx.contextWindow * profile.triggerPercent / 100);
    if (ctx.trigger !== 'force' && measured < triggerTokens) return 0;
    const freed = deps.ephemeral.dropSuperseded();
    if (freed > 0) {
      deps.ports.logger.info('Pruned superseded ephemeral context', {
        sessionKey: ctx.sessionKey, freedTokens: freed, measured, triggerTokens,
      });
    }
    return freed;
  }

  /** Overflow recovery: the request cannot be replayed as-is, so a stale
   *  plan's replay is not enough — rebuild with `force`, carrying the prior
   *  plan as the monotonic floor (already-pruned tool results stay pruned,
   *  paid-for summaries are reused). */
  async function forceRebuild(
    turns: Turn[],
    ctx: TransformContext,
    prior: PlanSnapshot | null,
    reportedTokens: number,
    summarize: (jobs: BoundarySummaryJob[]) => Promise<Record<string, string>>,
  ): Promise<ProcessResult> {
    const inputs: BuildPlanInputs = { ...buildInputs(ctx, turns, reportedTokens), force: true, priorPlan: prior ?? undefined };
    let plan = buildPlan(turns, inputs, proteusSpec);
    if (!plan) return { outcome: 'unchanged' };
    if (plan.summaryJobs.length > 0) {
      const summaries = await summarize(plan.summaryJobs);
      if (Object.keys(summaries).length > 0) {
        plan = buildPlan(
          turns,
          { ...inputs, priorPlan: toPlanSnapshot(plan), assistantSummaries: summaries },
          proteusSpec,
        ) ?? plan;
      }
    }
    await writeTranscript(plan, { transcripts: deps.ports.transcripts, logger: deps.ports.logger, codec: proteusCodec });
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, proteusSpec);
    await deps.ports.plans.save(ctx.sessionKey, toPlanSnapshot(plan));
    return { outcome: 'planned', turns: transformed, plan };
  }

  /** When the ladder fell through to the last-resort prefix summary, replace
   *  the deterministic preview with a proper LLM handoff summary built from
   *  core's tuned template, then rebuild so the upgraded summary is what the
   *  model sees this turn AND what future replays carry. Skipped when the
   *  plan already carries an upgraded ([CONTEXT CHECKPOINT]-wrapped) summary
   *  inherited from a prior plan, or when published core already accepted a
   *  rolling summary for an expanded prefix. */
  async function upgradePrefixSummary(
    turns: Turn[],
    plan: BoundaryContextPlan,
    prior: PlanSnapshot | null,
    ctx: TransformContext,
    reportedTokens: number,
    rollingSummaryAttempted: boolean,
  ): Promise<Extract<ProcessResult, { outcome: 'planned' }> | null> {
    if (!plan.requiresCustomCompaction) return null;
    // Published core owns rolling attempts, including validation and its
    // circuit breaker. Never bypass that policy with a second direct call.
    if (rollingSummaryAttempted) return null;
    if (plan.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)) return null;
    const prefixTurns = compactedTurnsForPlan(turns, plan);
    if (prefixTurns.length === 0) return null;

    const previous = prior?.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)
      ? stripCheckpointPreamble(prior.prefixSummary)
      : null;
    const prompt = buildCompactionSummaryPrompt({
      transcript: plan.transcript.content || formatTranscript(prefixTurns, proteusCodec),
      latestUserAsk: latestUserAsk(ctx.messages),
      previousSummary: previous,
      // The agents-SDK budget rule the old path used: 20% of the compacted
      // content, floored at 100 tokens.
      budgetTokens: Math.max(100, Math.floor(proteusCodec.estimateTurns(prefixTurns) * 0.2)),
    });
    let body: string;
    try {
      body = await deps.summarize(prompt);
    } catch (err) {
      deps.ports.logger.warn('Compaction prefix-summary call failed; keeping deterministic summary', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!body.trim()) return null;

    const upgraded = buildPlan(
      turns,
      {
        ...buildInputs(ctx, turns, reportedTokens),
        force: true,
        // The just-built plan is the floor; its snapshot already carries the
        // assistant summaries and preserved tool ids forward.
        priorPlan: toPlanSnapshot(plan),
        prefixSummary: wrapCompactionSummary(body),
      },
      proteusSpec,
    );
    if (!upgraded) return null;
    // Same compacted range ⇒ same rangeHash ⇒ the transcript is already
    // persisted at the same citable path; no second write needed.
    const transformed = transformTurns(turns, upgraded.rawTailStartIndex, upgraded, proteusSpec);
    await deps.ports.plans.save(ctx.sessionKey, toPlanSnapshot(upgraded));
    return { outcome: 'planned', turns: transformed, plan: upgraded };
  }

  /** Index the range this plan just archived. The compacted prefix always
   *  starts at turn 0, so the index records what THIS compaction added and
   *  cites the archive that holds it; a plan whose prefix no longer contains
   *  the last indexed anchor describes a rewritten history, and the index
   *  restarts from it. */
  function indexArchivedRange(ctx: TransformContext, turns: Turn[], plan: BoundaryContextPlan): void {
    const derived = deriveArchiveRange(
      compactedTurnsForPlan(turns, plan),
      plan.rangeHash,
      plan.transcript.relativePath,
      deps.archive.list(ctx.sessionKey),
    );
    if (!derived) return;
    if (derived.reset) deps.archive.clear(ctx.sessionKey);
    deps.archive.append(ctx.sessionKey, derived.range);
  }

  return {
    name: 'compaction',

    async transformContext(ctx: TransformContext): Promise<ModelMessage[] | undefined> {
      if (ctx.messages.length === 0 || ctx.contextWindow <= 0) return undefined;
      const messages = [...ctx.messages];
      const turns = proteusCodec.encode(messages);

      // Loaded before process (which may replace it) so the prefix-summary
      // upgrade can thread the prior summary through as an iterative update.
      const cached = await deps.ports.plans.load(ctx.sessionKey);
      const prior = cached && cached.sessionId === ctx.sessionKey ? cached : null;
      let rollingSummaryAttempted = false;
      const summarize = async (jobs: BoundarySummaryJob[]): Promise<Record<string, string>> => {
        rollingSummaryAttempted ||= jobs.some((job) => job.key.startsWith('prefix-summary:'));
        const summaries = await runJobs(ctx.sessionKey, jobs);
        return summaries;
      };

      // Rung one: the superseded ephemeral blocks, before any tool output is
      // touched. What it frees is what the rest of the ladder no longer has to.
      const reportedTokens = measuredTokens(ctx, turns, relieveEphemeralPressure(ctx, turns));

      const processed =
        ctx.trigger === 'force'
          ? await forceRebuild(turns, ctx, prior, reportedTokens, summarize)
          : await engine.process({
              sessionKey: ctx.sessionKey,
              turns,
              contextLimit: ctx.contextWindow,
              triggerRatio: profile.triggerPercent / 100,
              targetRatio: profile.targetPercent / 100,
              recentToolResultBudgetTokens: profile.recentToolTokens,
              providerReportedTokens: reportedTokens,
              summarize,
            });
      if (processed.outcome === 'unchanged') {
        const remaining = prior ? await deps.ports.plans.load(ctx.sessionKey) : null;
        if (prior && remaining === null) {
          deps.onOutcome?.({ sessionKey: ctx.sessionKey, outcome: 'invalidated' });
        }
        return undefined;
      }

      const applied =
        processed.outcome === 'planned'
          ? ((await upgradePrefixSummary(
              turns,
              processed.plan,
              prior,
              ctx,
              reportedTokens,
              rollingSummaryAttempted,
            )) ?? processed)
          : processed;

      if (applied.outcome === 'planned') indexArchivedRange(ctx, turns, applied.plan);

      deps.onOutcome?.({
        sessionKey: ctx.sessionKey,
        outcome: applied.outcome,
        plan: applied.outcome === 'planned' ? applied.plan : undefined,
      });
      // The manifest is a pure function of the durable index, which only grows
      // when a NEW range is archived — so a replayed plan re-renders it
      // byte-identically and the provider's prefix cache survives.
      const manifest = renderArchiveManifest(deps.archive.list(ctx.sessionKey));
      return proteusCodec.decode(withArchiveManifest(applied.turns, manifest), messages);
    },
  };
}

/** The trigger's known-overhead floor: the assembled system prompt, priced on
 *  the engine's chars/4 scale. The transform sees only the durable history —
 *  the system prompt (and tool schemas it stands in for) rides every request
 *  unseen by the message estimate, which otherwise reads systematically low
 *  until the first provider-reported total lands (production-measured on
 *  workspace-1a4e20: an 8-14k-token gap between the history estimate and the
 *  real per-request prompt). */
function systemOverheadFloor(ctx: TransformContext): number {
  return Math.round(ctx.system.length / 4);
}

/** The pressure the ladder budgets against: the provider's own last total when
 *  there is one, floored by what the history alone must cost.
 *
 *  `ephemeralRelief` is the tokens the first rung just freed. It comes off the
 *  provider total — which is the only term that ever counted the woven blocks —
 *  and the floor holds the result honest before the first report lands. */
function measuredTokens(ctx: TransformContext, turns: Turn[], ephemeralRelief: number): number {
  return Math.max(
    Math.max(0, (ctx.providerReportedTokens ?? 0) - ephemeralRelief),
    proteusCodec.estimateTurns(turns) + systemOverheadFloor(ctx),
  );
}

function compactedTurnsForPlan(turns: Turn[], plan: BoundaryContextPlan): Turn[] {
  const turnIndex = turns.findIndex((turn) => turn.key === plan.rawTailStartMessageId);
  if (turnIndex < 0) return turns.slice(0, plan.rawTailStartIndex);
  const boundary = plan.rawTailItemBoundary;
  if (!boundary) return turns.slice(0, turnIndex);

  const turn = turns[turnIndex];
  const boundaryItemIndex = turn.items.findIndex((item) => item.key === boundary.itemKey);
  if (boundaryItemIndex < 0) return turns.slice(0, turnIndex);
  const endIndex = boundary.side === 'after' ? boundaryItemIndex + 1 : boundaryItemIndex;
  if (endIndex <= 0) return turns.slice(0, turnIndex);
  const items = turn.items.slice(0, endIndex);
  return [
    ...turns.slice(0, turnIndex),
    { ...turn, items, fragmentKey: JSON.stringify(items.map((item) => item.key)) },
  ];
}

/** The most recent real user request across the FULL history (including the
 *  protected tail) — handed to the summary prompt directly so "Active Task
 *  verbatim" is mechanical, not a retrieval the summarizer can fumble. */
function latestUserAsk(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text =
      Array.isArray(message.content)
        ? message.content
            .filter((part): part is TextPart => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
        : message.content;
    if (text.trim()) return text;
  }
  return undefined;
}
