// Every probe reaches production code through this record so a fault can swap one function. Swaps
// only intercept gate calls, so layers must be dependency-closed (proved by unit-layergate.test.ts).

import type { AgentRuntime } from '../../packages/core/src/types/agent-runtime';
import { buildSystemPromptSync, type SystemPromptOptions } from '../../packages/core/src/prompt';
import { compilePromptSurface } from '../../packages/core/src/prompting/surface';
import { admitAgentsMd, renderAgentsMdSection } from '../../packages/core/src/prompting/agents-md';
import { renderActiveSkillsSection } from '../../packages/core/src/skills/render';
import { resolveActiveSkills } from '../../packages/core/src/skills/loader';
import {
  DynamicContextLedger,
  renderDynamicContextBlock,
} from '../../packages/core/src/prompting/volatile-context';
import { renderFactsBlock } from '../../packages/core/src/memory/facts';
import { composePrepareStep } from '../../packages/core/src/prompting/prepare-step';
import { pruneStepToolOutputs } from '../../packages/core/src/prompting/step-prune';
import {
  applyCacheBreakpoints,
  cacheableSystem,
  markCacheTail,
  promptCacheOptions,
  resolvePromptCacheStrategy,
} from '../../packages/core/src/prompting/cache-breakpoints';
import { modelWindow } from '../../packages/core/src/context-window';
import { clampSerializedToolResult, clampToolResult } from '../../packages/core/src/tools/clamp';
import { applyFileEdits, formatFileSlice } from '../../packages/core/src/tools/file-edit';
import { scanFileWindow } from '../../packages/core/src/tools/file-scan';
import { withMountTable } from '../../packages/core/src/vfs/mounts';
import { classifyTurnFailure, planOverflowRecovery } from '../../packages/core/src/turn-failure';
import {
  buildCompactionSummaryPrompt,
  stripCheckpointPreamble,
  wrapCompactionSummary,
} from '../../packages/core/src/compaction';
import { buildDrainBatch } from '../../packages/core/src/events/hub/drain';
import { renderForLLM } from '../../packages/core/src/events/hub/visibility';
import { StepInjections } from '../../packages/core/src/prompting/step-injections';
import { Inbox } from '../../packages/core/src/orchestrator/inbox';
import { DrainScheduler } from '../../packages/core/src/orchestrator/drain-scheduler';
import { reviewCommand } from '../../packages/core/src/safety/command-review';
import { formatApproval, gateExec } from '../../packages/core/src/safety/approval-gate';
import { argumentDigest } from '../../packages/core/src/safety/argument-digest';
import { checkMisevolution } from '../../packages/core/src/safety/misevolution';
import { drawArm, trialDecision } from '../../packages/core/src/evolution/trial-rules';
import { hybridSearch } from '../../packages/core/src/memory/hybrid-search';
import { reciprocalRankFusion } from '../../packages/core/src/memory/vector-store';
import { delegationFeatures, renderDelegationFeatures } from '../../packages/core/src/evolution/delegation-features';
import {
  craftFailureBlame, craftInvocationError, craftInvocationSites,
} from '../../packages/core/src/craft/in-episode';
import { renderToolSchemaDescription } from '../../packages/core/src/tools/registry';
import {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery,
} from '../../packages/core/src/orchestrator/turn-lifecycle';
import {
  serializeContentForHeads, inheritedContextFromHistory, narrowInheritedRole,
} from '../../packages/core/src/orchestrator/heads-support';

export interface PipelineSubjects {
  /** Probes pass `soulOverride`, so the runtime handle is never read. */
  readonly buildSystemPromptSync: (opts: SystemPromptOptions) => string;
  readonly compilePromptSurface: typeof compilePromptSurface;
  readonly admitAgentsMd: typeof admitAgentsMd;
  readonly renderAgentsMdSection: typeof renderAgentsMdSection;
  readonly renderActiveSkillsSection: typeof renderActiveSkillsSection;
  readonly resolveActiveSkills: typeof resolveActiveSkills;

  readonly renderDynamicContextBlock: typeof renderDynamicContextBlock;
  readonly DynamicContextLedger: typeof DynamicContextLedger;
  readonly renderFactsBlock: typeof renderFactsBlock;

  readonly composePrepareStep: typeof composePrepareStep;
  readonly pruneStepToolOutputs: typeof pruneStepToolOutputs;
  readonly markCacheTail: typeof markCacheTail;
  readonly applyCacheBreakpoints: typeof applyCacheBreakpoints;
  readonly resolvePromptCacheStrategy: typeof resolvePromptCacheStrategy;
  readonly cacheableSystem: typeof cacheableSystem;
  readonly promptCacheOptions: typeof promptCacheOptions;

  readonly modelWindow: typeof modelWindow;
  readonly clampToolResult: typeof clampToolResult;
  readonly clampSerializedToolResult: typeof clampSerializedToolResult;

  readonly classifyTurnFailure: typeof classifyTurnFailure;
  readonly planOverflowRecovery: typeof planOverflowRecovery;
  readonly openTurnRun: typeof openTurnRun;
  readonly closeTurnRun: typeof closeTurnRun;
  readonly snapshotCompletedTurn: typeof snapshotCompletedTurn;
  readonly persistMeasuredPromptTokens: typeof persistMeasuredPromptTokens;
  readonly applyOverflowRecovery: typeof applyOverflowRecovery;

  readonly serializeContentForHeads: typeof serializeContentForHeads;
  readonly inheritedContextFromHistory: typeof inheritedContextFromHistory;
  readonly narrowInheritedRole: typeof narrowInheritedRole;

  readonly buildCompactionSummaryPrompt: typeof buildCompactionSummaryPrompt;
  readonly wrapCompactionSummary: typeof wrapCompactionSummary;
  readonly stripCheckpointPreamble: typeof stripCheckpointPreamble;

  readonly buildDrainBatch: typeof buildDrainBatch;
  readonly renderForLLM: typeof renderForLLM;
  readonly StepInjections: typeof StepInjections;
  readonly Inbox: typeof Inbox;
  readonly DrainScheduler: typeof DrainScheduler;

  readonly reviewCommand: typeof reviewCommand;
  readonly formatApproval: typeof formatApproval;
  readonly gateExec: typeof gateExec;
  readonly argumentDigest: typeof argumentDigest;

  readonly checkMisevolution: typeof checkMisevolution;
  readonly trialDecision: typeof trialDecision;
  readonly drawArm: typeof drawArm;

  readonly hybridSearch: typeof hybridSearch;
  readonly reciprocalRankFusion: typeof reciprocalRankFusion;

  readonly delegationFeatures: typeof delegationFeatures;
  readonly renderDelegationFeatures: typeof renderDelegationFeatures;

  readonly craftInvocationSites: typeof craftInvocationSites;
  readonly craftFailureBlame: typeof craftFailureBlame;
  readonly craftInvocationError: typeof craftInvocationError;

  readonly renderToolSchemaDescription: typeof renderToolSchemaDescription;

  readonly applyFileEdits: typeof applyFileEdits;
  readonly scanFileWindow: typeof scanFileWindow;
  readonly formatFileSlice: typeof formatFileSlice;
  readonly withMountTable: typeof withMountTable;

}

export type SubjectName = keyof PipelineSubjects;

/** Relative to `packages/core/src`; the dependency-closure proof walks imports from these files. */
export const SUBJECT_SOURCE = {
  buildSystemPromptSync: 'prompt.ts',
  compilePromptSurface: 'prompting/surface.ts',
  admitAgentsMd: 'prompting/agents-md.ts',
  renderAgentsMdSection: 'prompting/agents-md.ts',
  renderActiveSkillsSection: 'skills/render.ts',
  resolveActiveSkills: 'skills/loader.ts',

  renderDynamicContextBlock: 'prompting/volatile-context.ts',
  DynamicContextLedger: 'prompting/volatile-context.ts',
  renderFactsBlock: 'memory/facts.ts',

  composePrepareStep: 'prompting/prepare-step.ts',
  pruneStepToolOutputs: 'prompting/step-prune.ts',
  markCacheTail: 'prompting/cache-breakpoints.ts',
  applyCacheBreakpoints: 'prompting/cache-breakpoints.ts',
  resolvePromptCacheStrategy: 'prompting/cache-breakpoints.ts',
  cacheableSystem: 'prompting/cache-breakpoints.ts',
  promptCacheOptions: 'prompting/cache-breakpoints.ts',

  modelWindow: 'context-window.ts',
  clampToolResult: 'tools/clamp.ts',
  clampSerializedToolResult: 'tools/clamp.ts',

  classifyTurnFailure: 'turn-failure.ts',
  planOverflowRecovery: 'turn-failure.ts',
  openTurnRun: 'orchestrator/turn-lifecycle.ts',
  closeTurnRun: 'orchestrator/turn-lifecycle.ts',
  snapshotCompletedTurn: 'orchestrator/turn-lifecycle.ts',
  persistMeasuredPromptTokens: 'orchestrator/turn-lifecycle.ts',
  applyOverflowRecovery: 'orchestrator/turn-lifecycle.ts',

  serializeContentForHeads: 'orchestrator/heads-support.ts',
  inheritedContextFromHistory: 'orchestrator/heads-support.ts',
  narrowInheritedRole: 'orchestrator/heads-support.ts',

  buildCompactionSummaryPrompt: 'compaction.ts',
  wrapCompactionSummary: 'compaction.ts',
  stripCheckpointPreamble: 'compaction.ts',

  buildDrainBatch: 'events/hub/drain.ts',
  renderForLLM: 'events/hub/visibility.ts',
  StepInjections: 'prompting/step-injections.ts',
  Inbox: 'orchestrator/inbox.ts',
  DrainScheduler: 'orchestrator/drain-scheduler.ts',

  reviewCommand: 'safety/command-review.ts',
  formatApproval: 'safety/approval-gate.ts',
  gateExec: 'safety/approval-gate.ts',
  argumentDigest: 'safety/argument-digest.ts',

  checkMisevolution: 'safety/misevolution.ts',
  trialDecision: 'evolution/trial-rules.ts',
  drawArm: 'evolution/trial-rules.ts',

  hybridSearch: 'memory/hybrid-search.ts',
  reciprocalRankFusion: 'memory/vector-store.ts',

  delegationFeatures: 'evolution/delegation-features.ts',
  renderDelegationFeatures: 'evolution/delegation-features.ts',

  craftInvocationSites: 'craft/in-episode.ts',
  craftFailureBlame: 'craft/in-episode.ts',
  craftInvocationError: 'craft/in-episode.ts',

  renderToolSchemaDescription: 'tools/registry.ts',

  applyFileEdits: 'tools/file-edit.ts',
  scanFileWindow: 'tools/file-scan.ts',
  formatFileSlice: 'tools/file-edit.ts',
  withMountTable: 'vfs/mounts.ts',

} satisfies Record<SubjectName, string>;

/** `rt` only satisfies the signature: probes pass `soulOverride`, so the gate stays free of I/O, clocks and RNG. */
export function createPipelineSubjects(rt: AgentRuntime): PipelineSubjects {
  return {
    buildSystemPromptSync: (opts) => buildSystemPromptSync(rt, opts),
    compilePromptSurface,
    admitAgentsMd,
    renderAgentsMdSection,
    renderActiveSkillsSection,
    resolveActiveSkills,

    renderDynamicContextBlock,
    DynamicContextLedger,
    renderFactsBlock,

    composePrepareStep,
    pruneStepToolOutputs,
    markCacheTail,
    applyCacheBreakpoints,
    resolvePromptCacheStrategy,
    cacheableSystem,
    promptCacheOptions,

    modelWindow,
    clampToolResult,
    clampSerializedToolResult,

    classifyTurnFailure,
    planOverflowRecovery,
    openTurnRun,
    closeTurnRun,
    snapshotCompletedTurn,
    persistMeasuredPromptTokens,
    applyOverflowRecovery,

    serializeContentForHeads,
    inheritedContextFromHistory,
    narrowInheritedRole,

    buildCompactionSummaryPrompt,
    wrapCompactionSummary,
    stripCheckpointPreamble,

    buildDrainBatch,
    renderForLLM,
    StepInjections,
    Inbox,
    DrainScheduler,

    reviewCommand,
    formatApproval,
    gateExec,
    argumentDigest,

    checkMisevolution,
    trialDecision,
    drawArm,

    hybridSearch,
    reciprocalRankFusion,

    delegationFeatures,
    renderDelegationFeatures,

    craftInvocationSites,
    craftFailureBlame,
    craftInvocationError,

    renderToolSchemaDescription,

    applyFileEdits,
    scanFileWindow,
    formatFileSlice,
    withMountTable,

  };
}
