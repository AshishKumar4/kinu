/**
 * `transformContext` adapter over the better-compact ladder: encode history, run the engine (replay
 * or new plan), decode. The archive manifest is appended from the durable index, never stored in the
 * plan, so a rolled or degraded summary cannot lose it.
 */

import type { ModelMessage, TextPart } from 'ai';
import type { KinuExtension, TransformContext } from '@kinu.run/core';
import {
  buildCompactionSummaryPrompt,
  stripCheckpointPreamble,
  wrapCompactionSummary,
  CONTEXT_CHECKPOINT_PREFIX,
} from '@kinu.run/core';
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
import { kinuCodec, kinuSpec } from './codec';
import {
  deriveArchiveRange,
  renderArchiveManifest,
  withArchiveManifest,
  type ArchiveIndexStore,
} from './manifest';
import { renderThrownChain } from '@kinu.run/core/obs';

export interface CompactionOutcomeEvent {
  sessionKey: string;
  /** Anything but 'replayed' changed the stream and invalidates frozen positions (e.g. ledger blocks). */
  outcome: 'planned' | 'replayed' | 'invalidated';
  plan?: BoundaryContextPlan;
}

/** Structural view of core's DynamicContextLedger: drop superseded `<dynamic_context>` blocks, return tokens freed. */
export interface EphemeralContextPlane {
  dropSuperseded(): number;
}

export interface CompactionExtensionDeps {
  /** `citablePath` must be readable by the agent's own file tool. */
  ports: EnginePorts;
  archive: ArchiveIndexStore;
  /** Serves both summary kinds; failures degrade to deterministic previews. */
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  ephemeral: EphemeralContextPlane;
  /** Defaults to the light preset. */
  profile?: CompactionProfile;
  /** Ledger-reset signal: reset on 'planned' and 'invalidated', keep on 'replayed'. */
  onOutcome?: (event: CompactionOutcomeEvent) => void;
}

interface ForceRebuildInputs {
  readonly turns: Turn[];
  readonly ctx: TransformContext;
  /** Monotonic floor: pruned tool results stay pruned, summaries are reused. */
  readonly prior: PlanSnapshot | null;
  readonly reportedTokens: number;
  readonly summarize: (jobs: BoundarySummaryJob[]) => Promise<Record<string, string>>;
}

interface PrefixUpgradeInputs {
  readonly turns: Turn[];
  readonly plan: BoundaryContextPlan;
  readonly prior: PlanSnapshot | null;
  readonly ctx: TransformContext;
  readonly reportedTokens: number;
  readonly rollingSummaryAttempted: boolean;
}

export function createCompactionExtension(deps: CompactionExtensionDeps): KinuExtension {
  const profile = deps.profile ?? COMPACTION_PRESETS.light;
  const engine = createEngine(kinuSpec, deps.ports);
  const summaryScheduler = createSummaryScheduler(deps.ports.logger);

  /** Per-turn summarizer: a cancelled turn cancels only its own calls and its abort is not a summary failure. */
  const summarizerFor = (signal: AbortSignal | undefined): Summarizer => ({
    async complete(job) {
      try {
        return await deps.summarize(job.prompt, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        deps.ports.logger.warn('Compaction summary call failed', {
          rangeStartMessageId: job.rangeStartMessageId,
          rangeEndMessageId: job.rangeEndMessageId,
          error: renderThrownChain({ cause: err }),
        });

        return null;
      }
    },
  });

  const runJobs = (
    sessionKey: string,
    jobs: BoundarySummaryJob[],
    summarizer: Summarizer,
  ): Promise<Record<string, string>> =>
    summaryScheduler.summarize({
      sessionKey,
      jobs,
      summarizer,
      concurrency: profile.summarizerConcurrency,
    });

  const buildInputs = (ctx: TransformContext, reportedTokens: number): BuildPlanInputs => ({
    sessionKey: ctx.sessionKey,
    contextLimit: ctx.contextWindow,
    triggerRatio: profile.triggerPercent / 100,
    targetRatio: profile.targetPercent / 100,
    recentToolResultBudgetTokens: profile.recentToolTokens,
    providerReportedTokens: reportedTokens,
    citablePath: (sessionKey, rangeHash) => deps.ports.transcripts.citablePath(sessionKey, rangeHash),
  });

  /**
   * First rung, above every ladder stage: under measured pressure, drop superseded `<dynamic_context>`
   * blocks (woven per step, never in durable history). Gated on the ladder trigger since it breaks the
   * woven prefix; needed because replay prices overhead as of plan build and never sees later blocks.
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

  /** Overflow recovery: rebuild with `force`, using the prior plan as the monotonic floor. */
  async function forceRebuild(
    { turns, ctx, prior, reportedTokens, summarize }: ForceRebuildInputs,
  ): Promise<ProcessResult> {
    const inputs: BuildPlanInputs = { ...buildInputs(ctx, reportedTokens), force: true, priorPlan: prior ?? undefined };
    let plan = buildPlan(turns, inputs, kinuSpec);

    if (!plan) return { outcome: 'unchanged' };

    if (plan.summaryJobs.length > 0) {
      const summaries = await summarize(plan.summaryJobs);

      if (Object.keys(summaries).length > 0) {
        plan = buildPlan(
          turns,
          { ...inputs, priorPlan: toPlanSnapshot(plan), assistantSummaries: summaries },
          kinuSpec,
        ) ?? plan;
      }
    }

    await writeTranscript(plan, { transcripts: deps.ports.transcripts, logger: deps.ports.logger, codec: kinuCodec });
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, kinuSpec);
    await deps.ports.plans.save(ctx.sessionKey, toPlanSnapshot(plan));

    return { outcome: 'planned', turns: transformed, plan };
  }

  /** Replace a last-resort preview prefix summary with an LLM handoff summary and rebuild. Skipped when
   *  already upgraded or when published core already accepted a rolling summary. */
  async function upgradePrefixSummary(
    { turns, plan, prior, ctx, reportedTokens, rollingSummaryAttempted }: PrefixUpgradeInputs,
  ): Promise<Extract<ProcessResult, { outcome: 'planned' }> | null> {
    if (!plan.requiresCustomCompaction) return null;

    // Published core owns rolling attempts and their circuit breaker; never add a second direct call.
    if (rollingSummaryAttempted) return null;

    if (plan.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)) return null;
    const prefixTurns = compactedTurnsForPlan(turns, plan);

    if (prefixTurns.length === 0) return null;

    const previous = prior?.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)
      ? stripCheckpointPreamble(prior.prefixSummary)
      : null;

    const prompt = buildCompactionSummaryPrompt({
      transcript: plan.transcript.content || formatTranscript(prefixTurns, kinuCodec),
      latestUserAsk: latestUserAsk(ctx.messages),
      previousSummary: previous,
      // Agents-SDK budget rule: 20% of the compacted content, floored at 100 tokens.
      budgetTokens: Math.max(100, Math.floor(kinuCodec.estimateTurns(prefixTurns) * 0.2)),
    });

    let body: string;

    try {
      body = await deps.summarize(prompt, ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      deps.ports.logger.warn('Compaction prefix-summary call failed; keeping deterministic summary', {
        error: renderThrownChain({ cause: err }),
      });

      return null;
    }

    if (!body.trim()) return null;

    const upgraded = buildPlan(
      turns,
      {
        ...buildInputs(ctx, reportedTokens),
        force: true,
        priorPlan: toPlanSnapshot(plan),
        prefixSummary: wrapCompactionSummary(body),
      },
      kinuSpec,
    );

    if (!upgraded) return null;
    // Same range ⇒ same rangeHash ⇒ transcript already persisted at the same path.
    const transformed = transformTurns(turns, upgraded.rawTailStartIndex, upgraded, kinuSpec);
    await deps.ports.plans.save(ctx.sessionKey, toPlanSnapshot(upgraded));

    return { outcome: 'planned', turns: transformed, plan: upgraded };
  }

  /** Index the range this plan archived; a prefix missing the last indexed anchor restarts the index. */
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
      ctx.abortSignal?.throwIfAborted();

      if (ctx.messages.length === 0 || ctx.contextWindow <= 0) return undefined;
      const messages = [...ctx.messages];
      const turns = kinuCodec.encode(messages);

      // Loaded before process (which may replace it) so the upgrade can thread the prior summary.
      const cached = await deps.ports.plans.load(ctx.sessionKey);
      const prior = cached && cached.sessionId === ctx.sessionKey ? cached : null;
      let rollingSummaryAttempted = false;

      const summarizer = summarizerFor(ctx.abortSignal);

      const summarize = async (jobs: BoundarySummaryJob[]): Promise<Record<string, string>> => {
        rollingSummaryAttempted ||= jobs.some((job) => job.key.startsWith('prefix-summary:'));
        const summaries = await runJobs(ctx.sessionKey, jobs, summarizer);
        // The engine swallows thrown summary calls; an abort mid-batch surfaces here.
        ctx.abortSignal?.throwIfAborted();

        return summaries;
      };

      const reportedTokens = measuredTokens(ctx, turns, relieveEphemeralPressure(ctx, turns));

      const processed =
        ctx.trigger === 'force'
          ? await forceRebuild({ turns, ctx, prior, reportedTokens, summarize })
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

      ctx.abortSignal?.throwIfAborted();

      if (processed.outcome === 'unchanged') {
        const remaining = prior ? await deps.ports.plans.load(ctx.sessionKey) : null;

        if (prior && remaining === null) {
          deps.onOutcome?.({ sessionKey: ctx.sessionKey, outcome: 'invalidated' });
        }

        return undefined;
      }

      const applied =
        processed.outcome === 'planned'
          ? ((await upgradePrefixSummary({
              turns,
              plan: processed.plan,
              prior,
              ctx,
              reportedTokens,
              rollingSummaryAttempted,
            })) ?? processed)
          : processed;

      ctx.abortSignal?.throwIfAborted();

      if (applied.outcome === 'planned') indexArchivedRange(ctx, turns, applied.plan);

      deps.onOutcome?.({
        sessionKey: ctx.sessionKey,
        outcome: applied.outcome,
        plan: applied.outcome === 'planned' ? applied.plan : undefined,
      });
      // Pure function of the append-only index, so replays render byte-identically and keep the prefix cache.
      const manifest = renderArchiveManifest(deps.archive.list(ctx.sessionKey));

      return kinuCodec.decode(withArchiveManifest(applied.turns, manifest), messages);
    },
  };
}

/** The swarm prefix never contains dynamic-context blocks, so the first rung has nothing to drop. */
const NO_EPHEMERAL_PLANE: EphemeralContextPlane = { dropSuperseded: () => 0 };

export interface SharedPrefixCompactorDeps {
  /** The archived range lands in the workspace VFS, readable by the node's own file tools. */
  ports: EnginePorts;
  archive: ArchiveIndexStore;
  summarize: (prompt: string) => Promise<string>;
  profile?: CompactionProfile;
}

/**
 * Swarm half of the compaction seam (`SwarmRunDeps.compactShared`): the same ladder, entered once per
 * branch point. The caller owns the policy, so this always forces; keyed by the branch point's durable
 * id so re-entry replays byte-stably and siblings share one cacheable prefix.
 */
export function createSharedPrefixCompactor(
  deps: SharedPrefixCompactorDeps,
): (
  messages: readonly ModelMessage[],
  basis: { readonly contextWindow: number; readonly key: string },
) => Promise<readonly ModelMessage[]> {
  const extension = createCompactionExtension({
    ports: deps.ports,
    archive: deps.archive,
    summarize: deps.summarize,
    profile: deps.profile,
    ephemeral: NO_EPHEMERAL_PLANE,
  });

  return async (messages, basis) => {
    if (messages.length === 0) return messages;

    const compacted = await extension.transformContext?.({
      sessionKey: basis.key,
      messages: [...messages],
      system: '',
      contextWindow: basis.contextWindow,
      trigger: 'force',
    });

    return compacted ?? messages;
  };
}

/** Known-overhead floor: the assembled system prompt at chars/4, unseen by the history estimate. */
function systemOverheadFloor(ctx: TransformContext): number {
  return Math.round(ctx.system.length / 4);
}

/** Budgeted pressure: the provider's last total minus `ephemeralRelief`, floored by the history estimate. */
function measuredTokens(ctx: TransformContext, turns: Turn[], ephemeralRelief: number): number {
  return Math.max(
    Math.max(0, (ctx.providerReportedTokens ?? 0) - ephemeralRelief),
    kinuCodec.estimateTurns(turns) + systemOverheadFloor(ctx),
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

/** Latest real user request across the full history, so "Active Task verbatim" is mechanical. */
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
