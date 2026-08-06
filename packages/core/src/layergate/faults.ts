/**
 * Fault injection — the validation of the gate itself.
 *
 * A per-layer score is only worth something if a regression inside one layer
 * actually craters THAT layer and leaves the others flat. So each layer gets a
 * synthetic single-layer regression, and the matrix reports what every slice
 * did. The bar: the faulted layer drops at least LOCALIZATION_OWN_MIN_PP, and
 * no other layer moves by LOCALIZATION_OTHER_MAX_PP or more. A layer that
 * fails it has a wrong decomposition, not a bad fault.
 *
 * A fault may patch several subjects — a real regression is a module changing,
 * not one function — but only subjects its own layer owns. Anything else would
 * be a multi-layer fault, and the isolation question would be meaningless.
 * The reference is the CLEAN run, not the locked baseline, so the matrix
 * measures the fault and nothing else.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension.js';
import { EphemeralContextLedger, type SystemStateContext } from '../prompting/volatile-context.js';
import { StepInjections, type RecordedInjection } from '../prompting/step-injections.js';
import { LAYERS, type Layer } from './layers.js';
import { observePipeline, scoreAgainstBaseline } from './gate.js';
import type { PipelineSubjects, SubjectName } from './subjects.js';

export interface Fault<S = PipelineSubjects> {
  readonly id: string;
  /** The layer whose code this regression lives in. */
  readonly layer: string;
  /** Subjects it patches — all owned by `layer` (asserted in tests). */
  readonly patches: readonly (keyof S & string)[];
  /** The real-world regression class it models. */
  readonly models: string;
  readonly inject: (subjects: S) => S;
}

/** The faulted layer must lose at least this many percentage points. */
export const LOCALIZATION_OWN_MIN_PP = 25;
/** Every other layer must move less than this. */
export const LOCALIZATION_OTHER_MAX_PP = 5;

export interface FaultImpact {
  readonly fault: string;
  readonly layer: string;
  /** Conformance drop vs the clean run, in percentage points, per layer.
   *  `null` for layers with no slice — they cannot move because nothing
   *  measures them, which is not the same as being unaffected. */
  readonly dropPp: Readonly<Record<string, number | null>>;
  readonly ownDropPp: number;
  readonly maxOtherDropPp: number;
  readonly localized: boolean;
}

/** The ledger stops recognising an unchanged state and appends every turn —
 *  the prefix-cache regression the fingerprint gate exists to prevent. */
class UndedupedLedger extends EphemeralContextLedger {
  private appended = 0;
  override get size(): number {
    return this.appended;
  }
  override weave(history: ReadonlyArray<ModelMessage>, state: SystemStateContext): ModelMessage[] {
    this.appended += 1;
    return [...history, { role: 'user', content: JSON.stringify(state) }];
  }
  override reset(): void {
    this.appended = 0;
  }
}

/** Injections drift to the tail of whatever step drains them instead of
 *  holding their entry index — the mid-turn cache-busting regression. */
class DriftingStepInjections<E extends { readonly message: ModelMessage }> extends StepInjections<E> {
  private own: Array<RecordedInjection<E>> = [];
  override get recorded(): ReadonlyArray<RecordedInjection<E>> {
    return this.own;
  }
  override drain(ctx: PrepareStepContext, incoming: ReadonlyArray<E>): ModelMessage[] | undefined {
    for (const entry of incoming) this.own.push({ ...entry, index: ctx.messages.length });
    if (this.own.length === 0) return undefined;
    return [...ctx.messages, ...this.own.map((entry) => entry.message)];
  }
  override replayInto(responseMessages: ReadonlyArray<ModelMessage>): ModelMessage[] {
    return [...responseMessages, ...this.own.map((entry) => entry.message)];
  }
  override reset(): void {
    this.own = [];
  }
}

export const FAULTS: readonly Fault[] = Object.freeze([
  {
    id: 'context-assembly/prefix-renderers-regress',
    layer: 'context-assembly',
    patches: ['compilePromptSurface', 'buildSystemPromptSync', 'renderAgentsMdSection'],
    models: 'the surface compiler stops filtering unavailable executors, a prefix section renderer drops a line, and the AGENTS.md budget stops being applied',
    inject: (s) => ({
      ...s,
      compilePromptSurface: (opts) => {
        const surface = s.compilePromptSurface(opts);
        return { ...surface, selectableExecutors: surface.executors };
      },
      buildSystemPromptSync: (opts) =>
        s.buildSystemPromptSync(opts).split('\n').filter((line) => !line.startsWith('- Model: ')).join('\n'),
      renderAgentsMdSection: (files) => s.renderAgentsMdSection(files, Number.MAX_SAFE_INTEGER),
    }),
  },
  {
    id: 'volatile-context/plane-regresses',
    layer: 'volatile-context',
    patches: ['renderSystemStateBlock', 'turnLocalContextMessage', 'EphemeralContextLedger'],
    models: 'the memory tail falls out of the system-state block, the device notice falls out of the turn tail, and the ledger stops deduplicating',
    inject: (s) => ({
      ...s,
      renderSystemStateBlock: (ctx) => s.renderSystemStateBlock({ ...ctx, memoryTail: undefined }),
      turnLocalContextMessage: (ctx) => s.turnLocalContextMessage({ ...ctx, deviceNotice: null }),
      EphemeralContextLedger: UndedupedLedger,
    }),
  },
  {
    id: 'step-pipeline/budget-and-markers-regress',
    layer: 'step-pipeline',
    patches: ['composePrepareStep', 'pruneStepToolOutputs', 'markCacheTail', 'cacheableSystem', 'resolvePromptCacheStrategy'],
    models: 'the step pipeline drops the extension chain, pruning silently no-ops, and cache breakpoints stop being placed',
    inject: (s) => ({
      ...s,
      composePrepareStep: (_extensions, ctx, plan, prune) => s.composePrepareStep(undefined, ctx, plan, prune),
      pruneStepToolOutputs: () => undefined,
      markCacheTail: (messages) => [...messages],
      cacheableSystem: (system) => system,
      resolvePromptCacheStrategy: (providerId, modelId) => {
        const strategy = s.resolvePromptCacheStrategy(providerId, modelId);
        return strategy.kind === 'openai-compat' ? { ...strategy, markers: false } : strategy;
      },
    }),
  },
  {
    id: 'context-budget/policy-regresses',
    layer: 'context-budget',
    patches: ['contextWindowForModel', 'clampToolResult'],
    models: 'the window table rots back to the default and the clamp head/tail split shifts',
    inject: (s) => ({
      ...s,
      contextWindowForModel: () => 128_000,
      clampToolResult: async (text, opts = {}) => {
        const maxChars = opts.maxChars ?? 40_000;
        if (text.length <= maxChars) return text;
        const headLen = Math.floor(maxChars * 0.5);
        return `${text.slice(0, headLen)}\n\n[output truncated]\n\n${text.slice(-(maxChars - headLen))}`;
      },
    }),
  },
  {
    id: 'backend-turn-driver/settle-spine-regresses',
    layer: 'backend-turn-driver',
    patches: ['closeTurnRun', 'snapshotCompletedTurn', 'classifyTurnFailure'],
    models: 'run_end loses the error evidence, a failed tool stops flagging the turn, and an oversized rate-limit stops counting as an overflow',
    inject: (s) => ({
      ...s,
      closeTurnRun: (recorder, runId, opts) => {
        const { error: _dropped, ...rest } = opts;
        s.closeTurnRun(recorder, runId, rest);
      },
      snapshotCompletedTurn: (acc, opts) => ({ ...s.snapshotCompletedTurn(acc, opts), hadError: false }),
      classifyTurnFailure: (error) => s.classifyTurnFailure(error),
    }),
  },
  {
    id: 'subordinate-runtime/digest-leaks-payloads',
    layer: 'subordinate-runtime',
    patches: ['serializeContentForHeads', 'inheritedContextFromHistory'],
    models: 'file payloads stop being reduced to references and the parent-history cap stops applying',
    inject: (s) => ({
      ...s,
      serializeContentForHeads: (content) => JSON.stringify(content),
      inheritedContextFromHistory: (history) => s.inheritedContextFromHistory(history, Number.MAX_SAFE_INTEGER),
    }),
  },
  {
    id: 'compaction/handoff-contract-regresses',
    layer: 'compaction',
    patches: ['buildCompactionSummaryPrompt', 'wrapCompactionSummary'],
    models: 'the pending-asks section falls out of the summary spec and the checkpoint preamble changes shape',
    inject: (s) => ({
      ...s,
      buildCompactionSummaryPrompt: (input) =>
        s.buildCompactionSummaryPrompt(input).replace(/## Pending User Asks\n[^\n]*\n\n/, ''),
      wrapCompactionSummary: (summary) => `[CONTEXT CHECKPOINT]\n\n${summary}`,
    }),
  },
  {
    id: 'event-drain/self-wake-loop',
    layer: 'event-drain',
    patches: ['buildDrainBatch', 'renderForLLM'],
    models: 'the drain stops excluding the agent\'s own events and the rendered view stops flagging self-causation — the self-wake loop, twice over',
    inject: (s) => ({
      ...s,
      buildDrainBatch: (events) =>
        s.buildDrainBatch(events.map((e) => (e.ingress === 'self_emit' ? { ...e, ingress: 'sandbox_cb' } : e))),
      renderForLLM: (event) => ({ ...s.renderForLLM(event), is_self_caused: false }),
    }),
  },
  {
    id: 'mid-turn-injection/splice-drift',
    layer: 'mid-turn-injection',
    patches: ['StepInjections'],
    models: 'injections drift to the tail of whichever step re-applies them instead of holding their entry index',
    inject: (s) => ({ ...s, StepInjections: DriftingStepInjections }),
  },
  {
    id: 'safety-gate/severity-collapse',
    layer: 'safety-gate',
    patches: ['reviewCommand', 'formatApproval', 'argumentDigest'],
    models: 'deny decisions decay into gate, the approval prose stops naming its rules, and the digest is truncated below collision resistance',
    inject: (s) => ({
      ...s,
      reviewCommand: (command) => {
        const result = s.reviewCommand(command);
        return result.decision === 'deny' ? { ...result, decision: 'gate' } : result;
      },
      formatApproval: (result) => (result.decision === 'allow' ? '' : `Approval review: ${result.decision}`),
      argumentDigest: (args) => s.argumentDigest(args).slice(0, 8),
    }),
  },
  {
    id: 'evolution-gate/acceptance-weakens',
    layer: 'evolution-gate',
    patches: ['checkMisevolution', 'decidePromotion'],
    models: 'the network-egress criterion stops matching and the shadow regression veto is dropped',
    inject: (s) => ({
      ...s,
      checkMisevolution: (source) => s.checkMisevolution(source.replace(/\bfetch\s*\(/g, 'noop(')),
      decidePromotion: (pending, config) =>
        s.decidePromotion(pending, { ...config, maxRegressions: Number.MAX_SAFE_INTEGER }),
    }),
  },
  {
    id: 'memory-retrieval/fusion-constant-regresses',
    layer: 'memory-retrieval',
    patches: ['reciprocalRankFusion'],
    models: 'the RRF constant collapses to 0, so top-1 hits dominate instead of cross-source agreement',
    inject: (s) => ({
      ...s,
      reciprocalRankFusion: (lists) => s.reciprocalRankFusion(lists, 0),
    }),
  },
  {
    id: 'delegation/evidence-undercounts',
    layer: 'delegation',
    patches: ['delegationFeatures', 'renderDelegationFeatures'],
    models: 'subordinate spawns stop being counted and the rendered evidence drops its wall clock',
    inject: (s) => ({
      ...s,
      delegationFeatures: (turn) => ({ ...s.delegationFeatures(turn), teamCalls: 0 }),
      renderDelegationFeatures: (features) =>
        s.renderDelegationFeatures(features).replace(/, [\d.]+(?:min|s) wall clock$/, ''),
    }),
  },
  {
    id: 'tool-contract/doctrine-truncated',
    layer: 'tool-contract',
    patches: ['renderToolSchemaDescription'],
    models: 'the avoid-when doctrine falls out of every tool schema description',
    inject: (s) => ({
      ...s,
      renderToolSchemaDescription: (spec) =>
        s.renderToolSchemaDescription(spec).split('\n').filter((line) => !line.startsWith('Avoid when:')).join('\n'),
    }),
  },
  {
    id: 'execution-signal/presence-overreports',
    layer: 'execution-signal',
    patches: ['devicePresence', 'deviceChangeNotice'],
    models: 'a registered-but-offline device reports as connected and the reconnect notice stops firing',
    inject: (s) => ({
      ...s,
      devicePresence: (status) => (status.registered ? 'connected' : s.devicePresence(status)),
      deviceChangeNotice: (previous, current) => (current === 'connected' ? null : s.deviceChangeNotice(previous, current)),
    }),
  },
]);

export async function runFaultMatrix<S = PipelineSubjects>(
  subjects: S,
  faults: readonly Fault<S>[] = FAULTS as unknown as readonly Fault<S>[],
  layers: readonly Layer<S>[] = LAYERS as unknown as readonly Layer<S>[],
): Promise<FaultImpact[]> {
  const clean = await observePipeline(subjects, layers);
  const reference = Object.fromEntries(clean);
  const impacts: FaultImpact[] = [];
  for (const fault of faults) {
    const report = scoreAgainstBaseline(await observePipeline(fault.inject(subjects), layers), reference, layers);
    const dropPp: Record<string, number | null> = {};
    let ownDropPp = 0;
    let maxOtherDropPp = 0;
    for (const score of report.layers) {
      const drop = score.conformance === null ? null : (1 - score.conformance) * 100;
      dropPp[score.layer] = drop;
      if (drop === null) continue;
      if (score.layer === fault.layer) ownDropPp = drop;
      else maxOtherDropPp = Math.max(maxOtherDropPp, drop);
    }
    impacts.push({
      fault: fault.id,
      layer: fault.layer,
      dropPp,
      ownDropPp,
      maxOtherDropPp,
      localized: ownDropPp >= LOCALIZATION_OWN_MIN_PP && maxOtherDropPp < LOCALIZATION_OTHER_MAX_PP,
    });
  }
  return impacts;
}

export function renderFaultMatrix(impacts: readonly FaultImpact[]): string {
  const width = Math.max(...impacts.map((i) => i.fault.length));
  return [
    `Fault matrix (own ≥ ${LOCALIZATION_OWN_MIN_PP}pp, every other layer < ${LOCALIZATION_OTHER_MAX_PP}pp)`,
    ...impacts.map((impact) => {
      const leaks = Object.entries(impact.dropPp)
        .filter(([layer, drop]) => layer !== impact.layer && drop !== null && drop > 0)
        .map(([layer, drop]) => `${layer} ${(drop as number).toFixed(1)}pp`);
      return `  ${impact.fault.padEnd(width)}  own ${impact.ownDropPp.toFixed(1).padStart(5)}pp  ` +
        `other ${impact.maxOtherDropPp.toFixed(1).padStart(5)}pp  ` +
        `${impact.localized ? 'LOCALIZED' : 'LEAKED'}${leaks.length ? ` [${leaks.join(', ')}]` : ''}`;
    }),
  ].join('\n');
}
