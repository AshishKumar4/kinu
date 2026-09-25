// Validates the gate: each fault patches only subjects its own layer owns, and must crater that layer
// while leaving the others flat, measured against the clean run rather than the locked baseline.

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension';
import { DynamicContextLedger, type DynamicContext } from '../prompting/volatile-context';
import { StepInjections, type RecordedInjection } from '../prompting/step-injections';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../tools/clamp';
import { LAYERS, type Layer } from './layers';
import { observePipeline, scoreAgainstBaseline } from './gate';
import type { PipelineSubjects } from './subjects';
import { renderThrownChain } from '../obs/index';

export interface Fault<S = PipelineSubjects> {
  readonly id: string;
  readonly layer: string;
  /** All owned by `layer` (asserted in tests). */
  readonly patches: readonly (keyof S & string)[];
  readonly models: string;
  readonly inject: (subjects: S) => S;
}

/** Minimum drop, in percentage points, of the faulted layer. */
export const LOCALIZATION_OWN_MIN_PP = 25;

/** Every other layer must move less than this. */
export const LOCALIZATION_OTHER_MAX_PP = 5;

export interface FaultImpact {
  readonly fault: string;
  readonly layer: string;
  /** Drop vs the clean run, in pp. `null` for unmeasured layers, which is not the same as unaffected. */
  readonly dropPp: Readonly<Record<string, number | null>>;
  readonly ownDropPp: number;
  readonly maxOtherDropPp: number;
  readonly localized: boolean;
}

/** Appends every step instead of deduplicating: the prefix-cache regression. */
class UndedupedLedger extends DynamicContextLedger {
  private appended = 0;
  override get size(): number {
    return this.appended;
  }
  override weave(history: ReadonlyArray<ModelMessage>, state: DynamicContext): ModelMessage[] {
    this.appended += 1;

    return [...history, { role: 'user', content: JSON.stringify(state) }];
  }
  override reset(): void {
    this.appended = 0;
  }
}

/** Injections drift to the step tail instead of holding their entry index. */
class DriftingStepInjections<E extends { readonly message: ModelMessage; readonly durable: boolean }> extends StepInjections<E> {
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
    patches: ['compilePromptSurface', 'buildSystemPromptSync', 'admitAgentsMd'],
    models: 'the surface compiler stops filtering unavailable executors, a prefix section renderer drops a line, and AGENTS.md admission stops bounding what it reads — every file is materialized whatever its size',
    inject: (s) => ({
      ...s,
      compilePromptSurface: (opts) => {
        const surface = s.compilePromptSurface(opts);

        return { ...surface, selectableExecutors: surface.executors };
      },
      buildSystemPromptSync: (opts) =>
        s.buildSystemPromptSync(opts).split('\n').filter((line) => !line.startsWith('- Model: ')).join('\n'),
      admitAgentsMd: (candidates) => ({ admit: candidates, referenced: [] }),
    }),
  },
  {
    id: 'volatile-context/plane-regresses',
    layer: 'volatile-context',
    patches: ['renderDynamicContextBlock', 'DynamicContextLedger'],
    models: 'the memory tail falls out of the dynamic-context block and the ledger stops deduplicating',
    inject: (s) => ({
      ...s,
      renderDynamicContextBlock: (ctx) => s.renderDynamicContextBlock({ ...ctx, memoryTail: undefined }),
      DynamicContextLedger: UndedupedLedger,
    }),
  },
  {
    id: 'step-pipeline/budget-and-markers-regress',
    layer: 'step-pipeline',
    patches: ['composePrepareStep', 'pruneStepToolOutputs', 'markCacheTail', 'cacheableSystem', 'resolvePromptCacheStrategy'],
    models: 'the step pipeline drops the extension chain, pruning silently no-ops, and cache breakpoints stop being placed',
    inject: (s) => ({
      ...s,
      composePrepareStep: (pipeline, ctx) => s.composePrepareStep({ ...pipeline, extensions: undefined }, ctx),
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
    models: 'the window table rots back to the default, and the clamp charges its marker on top of the cap instead of inside it',
    inject: (s) => ({
      ...s,
      contextWindowForModel: () => ({ measured: false, window: 128_000 }),
      clampToolResult: async (text) => {
        if (text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) return text;
        const headLen = Math.floor(DEFAULT_TOOL_RESULT_MAX_CHARS * 0.5);

        return `${text.slice(0, headLen)}\n\n[output truncated]\n\n${text.slice(-(DEFAULT_TOOL_RESULT_MAX_CHARS - headLen))}`;
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
      reviewCommand: (command, filesOwner) => {
        const result = s.reviewCommand(command, filesOwner);

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
    id: 'tool-contract/notes-truncated',
    layer: 'tool-contract',
    patches: ['renderToolSchemaDescription'],
    models: 'every note after the first falls out of each tool schema description',
    inject: (s) => ({
      ...s,
      renderToolSchemaDescription: (spec) => s.renderToolSchemaDescription({ ...spec, notes: spec.notes.slice(0, 1) }),
    }),
  },
  {
    id: 'file-plane/edits-land-blind',
    layer: 'file-plane',
    patches: ['applyFileEdits', 'formatFileSlice'],
    models: 'the plane goes quiet: a repeated anchor lands on its first occurrence, and a capped read stops naming the offset that continues it',
    inject: (s) => ({
      ...s,
      formatFileSlice: (range, opts) => {
        const slice = s.formatFileSlice(range, opts);

        return { ...slice, output: slice.output.replace(/\n\n\[[^\]]*\]$/, '') };
      },
      applyFileEdits: (original, edits, path) => {
        const first = edits[0];

        if (first && original.indexOf(first.oldText) !== original.lastIndexOf(first.oldText)) {
          const at = original.indexOf(first.oldText);

          return {
            ok: true,
            content: original.slice(0, at) + first.newText + original.slice(at + first.oldText.length),
            applied: [{ line: 1, removedLines: 1, addedLines: 1 }],
          };
        }

        return s.applyFileEdits(original, edits, path);
      },
    }),
  },
  {
    id: 'craft-fitness/prose-scored-as-execution',
    layer: 'craft-fitness',
    patches: ['craftInvocationSites', 'craftInvocationError'],
    models: 'the signal stops distinguishing code from prose and failures stop naming the tool that raised — ' +
      'a crafted tool merely MENTIONED in a string earns execution credit, and no failure is attributable to anything',
    inject: (s) => ({
      ...s,
      craftInvocationSites: (code, known) => known.filter((name) => code.includes(name)),
      craftInvocationError: (_name, cause) =>
        new Error(renderThrownChain({ cause: cause })),
    }),
  },
]);

async function runFaults<S>(
  subjects: S,
  faults: readonly Fault<S>[],
  layers: readonly Layer<S>[],
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

export function runFaultMatrix(subjects: PipelineSubjects): Promise<FaultImpact[]>;
export function runFaultMatrix<S>(
  subjects: S,
  faults: readonly Fault<S>[],
  layers: readonly Layer<S>[],
): Promise<FaultImpact[]>;
export function runFaultMatrix<S>(
  ...input: [subjects: PipelineSubjects] | [subjects: S, faults: readonly Fault<S>[], layers: readonly Layer<S>[]]
): Promise<FaultImpact[]> {
  if (input.length === 1) return runFaults(input[0], FAULTS, LAYERS);

  return runFaults(input[0], input[1], input[2]);
}

export function renderFaultMatrix(impacts: readonly FaultImpact[]): string {
  const width = Math.max(...impacts.map((i) => i.fault.length));

  return [
    `Fault matrix (own ≥ ${LOCALIZATION_OWN_MIN_PP}pp, every other layer < ${LOCALIZATION_OTHER_MAX_PP}pp)`,
    ...impacts.map((impact) => {
      const leaks = Object.entries(impact.dropPp)
        .filter((entry): entry is [string, number] =>
          entry[0] !== impact.layer && entry[1] !== null && entry[1] > 0)
        .map(([layer, drop]) => `${layer} ${drop.toFixed(1)}pp`);

      return `  ${impact.fault.padEnd(width)}  own ${impact.ownDropPp.toFixed(1).padStart(5)}pp  ` +
        `other ${impact.maxOtherDropPp.toFixed(1).padStart(5)}pp  ` +
        `${impact.localized ? 'LOCALIZED' : 'LEAKED'}${leaks.length ? ` [${leaks.join(', ')}]` : ''}`;
    }),
  ].join('\n');
}
