/**
 * `transformContext` over the better-compact ladder. The archive manifest is appended from the durable index,
 * never stored in the plan, so a rolled or degraded summary cannot lose it.
 */

import type { AssistantModelMessage, ModelMessage, TextPart } from 'ai';
import type { KinuExtension, TransformContext } from '@kinu.run/core';
import {
  buildCompactionSummaryPrompt,
  compactsServerSide,
  isServerCompaction,
  stripCheckpointPreamble,
  wrapCompactionSummary,
  COMPACTION_TRIGGER_PERCENT,
  CONTEXT_CHECKPOINT_PREFIX,
} from '@kinu.run/core';
import {
  attachmentCodec,
  createSummaryScheduler,
  createEngine,
  formatTranscript,
  preparePlan,
  toPlanSnapshot,
  transformTurns,
  writeTranscript,
  COMPACTION_PRESETS,
  type BoundaryContextPlan,
  type BoundarySummaryJob,
  type BuildPlanInputs,
  type CodecOps,
  type CompactionProfile,
  type EnginePorts,
  type LadderSpec,
  type PlanSnapshot,
  type ProcessResult,
  type Summarizer,
  type Turn,
} from '@better-compact/core';
import { kinuAttachments, type AttachmentDeps } from './attachments';
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
  profile?: CompactionProfile;
  /** Ledger-reset signal: reset on 'planned' and 'invalidated', keep on 'replayed'. */
  onOutcome?: (event: CompactionOutcomeEvent) => void;
  model?: () => string;
  attachments?: AttachmentDeps;
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
  const profile = deps.profile ?? { ...COMPACTION_PRESETS.light, triggerPercent: COMPACTION_TRIGGER_PERCENT };
  const { attachments, model } = deps;
  const spec: LadderSpec = attachments === undefined || model === undefined ? kinuSpec : { ...kinuSpec, attachments: kinuAttachments(attachments, model) };
  const serverSide = (): boolean => compactsServerSide(model?.());
  const codec = attachmentCodec(kinuCodec, spec.attachments);
  const engine = createEngine(spec, deps.ports);
  const summaryScheduler = createSummaryScheduler(deps.ports.logger);

  /** Per-turn summarizer: a cancelled turn cancels only its own calls and its abort is not a summary failure. */
  const summarizerFor = (signal: AbortSignal | undefined, failure: AbortController | null): Summarizer => ({
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
        failure?.abort(err);

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

  // /compact: target 0; a trigger past the largest turn keeps the last exchanges.
  const buildInputs = (ctx: TransformContext, reportedTokens: number, turns: readonly Turn[]): BuildPlanInputs => ({
    // A bypass drops a plan's summary; a server-compacting model keeps its own in history.
    bypassSummaries: serverSide(),
    sessionKey: ctx.sessionKey,
    contextLimit: ctx.contextWindow,
    triggerRatio: ctx.trigger === 'user'
      ? (Math.max(0, ...turns.map((turn) => codec.estimateTurns([turn]))) + 1) / ctx.contextWindow
      : profile.triggerPercent / 100,
    targetRatio: ctx.trigger === 'user' ? 0 : profile.targetPercent / 100,
    recentToolResultBudgetTokens: profile.recentToolTokens,
    providerReportedTokens: reportedTokens,
    citablePath: (sessionKey, rangeHash) => deps.ports.transcripts.citablePath(sessionKey, rangeHash),
  });

  /** An owner's fold replays up to the ladder's trigger. */
  const savedPlan = (ctx: TransformContext, plan: BoundaryContextPlan): PlanSnapshot => (ctx.trigger === 'user'
    ? { ...toPlanSnapshot(plan), triggerTokens: Math.floor(ctx.contextWindow * profile.triggerPercent / 100) }
    : toPlanSnapshot(plan));

  /**
   * First rung, above every ladder stage: under measured pressure, drop superseded `<dynamic_context>`
   * blocks (woven per step, never in durable history). Gated on the ladder trigger since it breaks the
   * woven prefix; needed because replay prices overhead as of plan build and never sees later blocks.
   */
  function relieveEphemeralPressure(ctx: TransformContext, turns: Turn[]): number {
    const measured = measuredTokens(ctx, turns, 0, codec);
    const triggerTokens = Math.floor(ctx.contextWindow * profile.triggerPercent / 100);

    if (ctx.trigger === 'auto' && measured < triggerTokens) return 0;
    const freed = deps.ephemeral.dropSuperseded();

    if (freed > 0) {
      deps.ports.logger.info('Pruned superseded ephemeral context', {
        sessionKey: ctx.sessionKey, freedTokens: freed, measured, triggerTokens,
      });
    }

    return freed;
  }

  /** An armed rebuild over the prior plan as the monotonic floor. */
  async function forceRebuild(
    { turns, ctx, prior, reportedTokens, summarize }: ForceRebuildInputs,
  ): Promise<ProcessResult> {
    const inputs: BuildPlanInputs = { ...buildInputs(ctx, reportedTokens, turns), force: true, priorPlan: prior ?? undefined };
    let plan = await preparePlan(turns, inputs, spec, deps.ports.logger);

    if (!plan) return { outcome: 'unchanged' };

    if (plan.summaryJobs.length > 0) {
      const summaries = await summarize(plan.summaryJobs);

      if (Object.keys(summaries).length > 0) {
        plan = await preparePlan(
          turns,
          { ...inputs, priorPlan: toPlanSnapshot(plan), assistantSummaries: summaries },
          spec,
          deps.ports.logger,
        ) ?? plan;
      }
    }

    await writeTranscript(plan, { transcripts: deps.ports.transcripts, logger: deps.ports.logger, codec: kinuCodec });

    return { outcome: 'planned', turns: transformTurns(turns, plan.rawTailStartIndex, plan, spec), plan };
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
      budgetTokens: Math.max(100, Math.floor(codec.estimateTurns(prefixTurns) * 0.2)),
    });

    let body: string;

    try {
      body = await deps.summarize(prompt, ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted || ctx.trigger === 'user') throw err;
      deps.ports.logger.warn('Compaction prefix-summary call failed; keeping deterministic summary', {
        error: renderThrownChain({ cause: err }),
      });

      return null;
    }

    if (!body.trim()) return null;

    const upgraded = await preparePlan(
      turns,
      {
        ...buildInputs(ctx, reportedTokens, turns),
        force: true,
        priorPlan: toPlanSnapshot(plan),
        prefixSummary: wrapCompactionSummary(body),
      },
      spec,
      deps.ports.logger,
    );

    if (!upgraded) return null;
    // Same range ⇒ same rangeHash ⇒ transcript already persisted at the same path.
    const transformed = transformTurns(turns, upgraded.rawTailStartIndex, upgraded, spec);
    await deps.ports.plans.save(ctx.sessionKey, savedPlan(ctx, upgraded));

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
      const messages = serverSide() ? sinceServerSummary(ctx.messages) : [...ctx.messages];
      const turns = kinuCodec.encode(messages);

      // Loaded before process (which may replace it) so the upgrade can thread the prior summary.
      const cached = await deps.ports.plans.load(ctx.sessionKey);
      const prior = cached && cached.sessionId === ctx.sessionKey ? cached : null;
      let rollingSummaryAttempted = false;

      // The owner's fold fails whole.
      const failure = new AbortController();
      const strict = ctx.trigger === 'user';
      const signal = strict ? AbortSignal.any([failure.signal, ...(ctx.abortSignal ? [ctx.abortSignal] : [])]) : ctx.abortSignal;
      const summarizer = summarizerFor(signal, strict ? failure : null);

      const summarize = async (jobs: BoundarySummaryJob[]): Promise<Record<string, string>> => {
        rollingSummaryAttempted ||= jobs.some((job) => job.key.startsWith('prefix-summary:'));
        const summaries = await runJobs(ctx.sessionKey, jobs, summarizer);
        // The engine swallows thrown summary calls; an abort mid-batch surfaces here.
        ctx.abortSignal?.throwIfAborted();
        failure.signal.throwIfAborted();

        return summaries;
      };

      const reportedTokens = measuredTokens(ctx, turns, relieveEphemeralPressure(ctx, turns), codec);

      const processed =
        ctx.trigger !== 'auto'
          ? await forceRebuild({ turns, ctx, prior, reportedTokens, summarize })
          : await engine.process({
              bypassSummaries: serverSide(),
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

        return messages.length === ctx.messages.length ? undefined : messages;
      }

      const upgraded =
        processed.outcome === 'planned'
          ? await upgradePrefixSummary({
              turns,
              plan: processed.plan,
              prior,
              ctx,
              reportedTokens,
              rollingSummaryAttempted,
            })
          : null;

      const applied = upgraded ?? processed;

      // The engine and an upgrade save theirs.
      if (upgraded === null && ctx.trigger !== 'auto' && processed.outcome === 'planned') {
        await deps.ports.plans.save(ctx.sessionKey, savedPlan(ctx, processed.plan));
      }

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
function measuredTokens(ctx: TransformContext, turns: Turn[], ephemeralRelief: number, codec: CodecOps): number {
  return Math.max(
    Math.max(0, (ctx.providerReportedTokens ?? 0) - ephemeralRelief),
    codec.estimateTurns(turns) + systemOverheadFloor(ctx),
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

function sinceServerSummary(messages: readonly ModelMessage[]): ModelMessage[] {
  let summary = messages.length - 1;

  while (summary >= 0 && !carriesServerSummary(messages[summary])) summary--;

  if (summary < 0) return [...messages];
  let ask = summary - 1;

  while (ask >= 0 && messages[ask]?.role !== 'user') ask--;

  return messages.slice(ask < 0 ? summary : ask);
}

function carriesServerSummary(message: ModelMessage | undefined): boolean {
  return message?.role === 'assistant' && Array.isArray(message.content)
    && message.content.some((part: Exclude<AssistantModelMessage['content'], string>[number]) => (part.type === 'text' || part.type === 'custom') && isServerCompaction(part.providerOptions));
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
