/**
 * The compaction extension — Proteus's `transformContext` adapter over the
 * vendored better-compact ladder engine.
 *
 * Encode the durable history to IR turns, run the engine (cached-plan replay
 * when the prefix still holds, else build/persist/apply a fresh plan), decode
 * back to ModelMessages. Deterministic prune stages run synchronously;
 * assistant-run summaries and the last-resort prefix summary go through ONE
 * injected `summarize` callback:
 *
 *  - assistant runs use the vendored per-run prompt already embedded in each
 *    summary job by the ladder;
 *  - the prefix summary uses core's tuned handoff template
 *    (`buildCompactionSummaryPrompt` — Active Task verbatim → Remaining Work,
 *    recall-first, secret redaction, iterative updates), the single summary
 *    spec the old single-shot path used, wrapped in the [CONTEXT CHECKPOINT]
 *    preamble so upgraded plans are recognizable and sticky across replays.
 *
 * Everything is injected ports (transcripts/plans/logger/summarize), so the
 * engine runs identically off-backend under test fakes; 2B binds the real
 * workspace-VFS transcript store, durable plan store, and LLM callback, and
 * registers the extension as the default compaction path.
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
  createEngine,
  formatTranscript,
  summarizeJobs,
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
} from './engine/index.js';
import { proteusCodec, proteusSpec } from './codec.js';

export interface CompactionOutcomeEvent {
  sessionKey: string;
  /** 'planned' = a NEW plan rewrote the history — frozen positions derived
   *  from the previous stream (the EphemeralContextLedger's blocks) are
   *  invalid and must reset. 'replayed' = deterministic cache-warm replay of
   *  the persisted plan — the transformed prefix is byte-stable, so frozen
   *  positions still hold. */
  outcome: 'planned' | 'replayed';
  /** The freshly built plan, on 'planned'. */
  plan?: BoundaryContextPlan;
}

export interface CompactionExtensionDeps {
  /** Engine ports: transcript store (citablePath must be a path the agent's
   *  own file tool can read back), plan store, logger. */
  ports: EnginePorts;
  /** One LLM call — prompt in, completion text out. Serves both summary
   *  kinds; failures degrade to deterministic previews, never break a turn. */
  summarize: (prompt: string) => Promise<string>;
  /** Trigger/target/recent-tool profile. Defaults to the light preset. */
  profile?: CompactionProfile;
  /** Fires whenever the transform rewrote history — the 2B ledger-reset
   *  signal (reset on 'planned', keep on 'replayed'). */
  onOutcome?: (event: CompactionOutcomeEvent) => void;
}

export function createCompactionExtension(deps: CompactionExtensionDeps): ProteusExtension {
  const profile = deps.profile ?? COMPACTION_PRESETS.light;
  const engine = createEngine(proteusSpec, deps.ports);

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

  const runJobs = (jobs: BoundarySummaryJob[]): Promise<Record<string, string>> =>
    summarizeJobs({ jobs, summarizer, logger: deps.ports.logger, concurrency: profile.summarizerConcurrency });

  const buildInputs = (ctx: TransformContext): BuildPlanInputs => ({
    sessionKey: ctx.sessionKey,
    contextLimit: ctx.contextWindow,
    triggerRatio: profile.triggerPercent / 100,
    targetRatio: profile.targetPercent / 100,
    recentToolResultBudgetTokens: profile.recentToolTokens,
    providerReportedTokens: ctx.providerReportedTokens,
    citablePath: deps.ports.transcripts.citablePath,
  });

  /** Overflow recovery: the request cannot be replayed as-is, so a stale
   *  plan's replay is not enough — rebuild with `force`, carrying the prior
   *  plan as the monotonic floor (already-pruned tool results stay pruned,
   *  paid-for summaries are reused). */
  async function forceRebuild(
    turns: Turn[],
    ctx: TransformContext,
    prior: PlanSnapshot | null,
  ): Promise<ProcessResult> {
    const inputs: BuildPlanInputs = { ...buildInputs(ctx), force: true, priorPlan: prior ?? undefined };
    let plan = buildPlan(turns, inputs, proteusSpec);
    if (!plan) return { outcome: 'unchanged' };
    if (plan.summaryJobs.length > 0) {
      const summaries = await runJobs(plan.summaryJobs);
      if (Object.keys(summaries).length > 0) {
        plan = buildPlan(turns, { ...inputs, assistantSummaries: summaries }, proteusSpec) ?? plan;
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
   *  inherited from a prior plan. */
  async function upgradePrefixSummary(
    turns: Turn[],
    plan: BoundaryContextPlan,
    prior: PlanSnapshot | null,
    ctx: TransformContext,
  ): Promise<Extract<ProcessResult, { outcome: 'planned' }> | null> {
    if (!plan.requiresCustomCompaction) return null;
    if (plan.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)) return null;
    const prefixTurns = turns.slice(0, plan.rawTailStartIndex);
    if (prefixTurns.length === 0) return null;

    const previous = prior?.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)
      ? stripCheckpointPreamble(prior.prefixSummary)
      : null;
    const prompt = buildCompactionSummaryPrompt({
      transcript: formatTranscript(prefixTurns, proteusCodec),
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
        ...buildInputs(ctx),
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

      const processed =
        ctx.trigger === 'force'
          ? await forceRebuild(turns, ctx, prior)
          : await engine.process({
              sessionKey: ctx.sessionKey,
              turns,
              contextLimit: ctx.contextWindow,
              triggerRatio: profile.triggerPercent / 100,
              targetRatio: profile.targetPercent / 100,
              recentToolResultBudgetTokens: profile.recentToolTokens,
              providerReportedTokens: ctx.providerReportedTokens,
              summarize: runJobs,
            });
      if (processed.outcome === 'unchanged') return undefined;

      const applied =
        processed.outcome === 'planned'
          ? ((await upgradePrefixSummary(turns, processed.plan, prior, ctx)) ?? processed)
          : processed;

      deps.onOutcome?.({
        sessionKey: ctx.sessionKey,
        outcome: applied.outcome,
        plan: applied.outcome === 'planned' ? applied.plan : undefined,
      });
      return proteusCodec.decode(applied.turns, messages);
    },
  };
}

/** The most recent real user request across the FULL history (including the
 *  protected tail) — handed to the summary prompt directly so "Active Task
 *  verbatim" is mechanical, not a retrieval the summarizer can fumble. */
function latestUserAsk(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part): part is TextPart => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    if (text.trim()) return text;
  }
  return undefined;
}
