/**
 * Pipeline subjects — the production entry points the layer gate calls.
 *
 * The gate never imports the turn pipeline directly. Every probe reaches
 * production code through this record, so a fault injection can replace
 * exactly one function and the gate measures which layers actually depend on
 * it. That is what turns "the aggregate moved" into "layer X moved".
 *
 * A registry swap only intercepts calls the GATE makes — not calls production
 * modules make to each other. The decomposition therefore has to be
 * dependency-closed, and `unit-layergate.test.ts` proves it is by walking the
 * real import graph: no subject of one layer may be reachable from a subject
 * of another. `SUBJECT_SOURCE` is the map that check runs over, and the same
 * test verifies every entry really exports its symbol.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { buildSystemPromptSync, type SystemPromptOptions } from '../prompt.js';
import { compilePromptSurface } from '../prompting/surface.js';
import { renderAgentsMdSection } from '../prompting/agents-md.js';
import { renderActiveSkillsSection } from '../skills/render.js';
import { resolveActiveSkills } from '../skills/loader.js';
import {
  DynamicContextLedger,
  renderDynamicContextBlock,
  turnLocalContextMessage,
} from '../prompting/volatile-context.js';
import { renderFactsBlock } from '../memory/facts.js';
import { composePrepareStep } from '../prompting/prepare-step.js';
import { pruneStepToolOutputs } from '../prompting/step-prune.js';
import {
  applyCacheBreakpoints,
  cacheableSystem,
  markCacheTail,
  promptCacheOptions,
  resolvePromptCacheStrategy,
} from '../prompting/cache-breakpoints.js';
import { contextWindowForModel } from '../context-window.js';
import { clampSerializedToolResult, clampToolResult } from '../tools/clamp.js';
import { applyFileEdits, readFileSlice } from '../tools/file-edit.js';
import { classifyTurnFailure, planOverflowRecovery } from '../turn-failure.js';
import {
  buildCompactionSummaryPrompt,
  stripCheckpointPreamble,
  wrapCompactionSummary,
} from '../compaction.js';
import { buildDrainBatch } from '../events/hub/drain.js';
import { renderForLLM } from '../events/hub/visibility.js';
import { StepInjections } from '../prompting/step-injections.js';
import { SignalDelivery } from '../orchestrator/signals.js';
import { DrainScheduler } from '../orchestrator/drain-scheduler.js';
import { formatApproval, reviewCommand, withApprovalGate } from '../safety/approval-gate.js';
import { argumentDigest } from '../safety/argument-digest.js';
import { checkMisevolution } from '../scaffold/misevolution.js';
import { decidePromotion } from '../scaffold/shadow.js';
import { selectEvolutionBase } from '../scaffold/archive.js';
import { hybridSearch } from '../memory/hybrid-search.js';
import { reciprocalRankFusion } from '../memory/vector-store.js';
import { delegationFeatures, renderDelegationFeatures } from '../evolution/delegation-features.js';
import {
  craftFailureBlame, craftInvocationError, craftInvocationSites,
} from '../craft/in-episode.js';
import { renderToolSchemaDescription } from '../tools/registry.js';
import {
  deviceChangeNotice,
  devicePresence,
  parseDevicePresence,
} from '../execution/device-status.js';
import {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery,
} from '../orchestrator/turn-lifecycle.js';
import {
  serializeContentForHeads, inheritedContextFromHistory, narrowInheritedRole,
} from '../orchestrator/heads-support.js';

export interface PipelineSubjects {
  // ── context assembly ──
  /** Bound to the caller's runtime handle. Every probe passes `soulOverride`,
   *  so the handle is never read — but the gate still calls the exact function
   *  both backends call, with the exact options they pass. */
  readonly buildSystemPromptSync: (opts: SystemPromptOptions) => string;
  readonly compilePromptSurface: typeof compilePromptSurface;
  readonly renderAgentsMdSection: typeof renderAgentsMdSection;
  readonly renderActiveSkillsSection: typeof renderActiveSkillsSection;
  readonly resolveActiveSkills: typeof resolveActiveSkills;

  // ── volatile context ──
  readonly renderDynamicContextBlock: typeof renderDynamicContextBlock;
  readonly turnLocalContextMessage: typeof turnLocalContextMessage;
  readonly DynamicContextLedger: typeof DynamicContextLedger;
  readonly renderFactsBlock: typeof renderFactsBlock;

  // ── per-step pipeline ──
  readonly composePrepareStep: typeof composePrepareStep;
  readonly pruneStepToolOutputs: typeof pruneStepToolOutputs;
  readonly markCacheTail: typeof markCacheTail;
  readonly applyCacheBreakpoints: typeof applyCacheBreakpoints;
  readonly resolvePromptCacheStrategy: typeof resolvePromptCacheStrategy;
  readonly cacheableSystem: typeof cacheableSystem;
  readonly promptCacheOptions: typeof promptCacheOptions;

  // ── context budget ──
  readonly contextWindowForModel: typeof contextWindowForModel;
  readonly clampToolResult: typeof clampToolResult;
  readonly clampSerializedToolResult: typeof clampSerializedToolResult;

  // ── backend turn driver (the hoisted shared spine) ──
  readonly classifyTurnFailure: typeof classifyTurnFailure;
  readonly planOverflowRecovery: typeof planOverflowRecovery;
  readonly openTurnRun: typeof openTurnRun;
  readonly closeTurnRun: typeof closeTurnRun;
  readonly snapshotCompletedTurn: typeof snapshotCompletedTurn;
  readonly persistMeasuredPromptTokens: typeof persistMeasuredPromptTokens;
  readonly applyOverflowRecovery: typeof applyOverflowRecovery;

  // ── subordinate runtime (the facet inherited-context digest) ──
  readonly serializeContentForHeads: typeof serializeContentForHeads;
  readonly inheritedContextFromHistory: typeof inheritedContextFromHistory;
  readonly narrowInheritedRole: typeof narrowInheritedRole;

  // ── compaction ──
  readonly buildCompactionSummaryPrompt: typeof buildCompactionSummaryPrompt;
  readonly wrapCompactionSummary: typeof wrapCompactionSummary;
  readonly stripCheckpointPreamble: typeof stripCheckpointPreamble;

  // ── event reactor ──
  readonly buildDrainBatch: typeof buildDrainBatch;
  readonly renderForLLM: typeof renderForLLM;
  readonly StepInjections: typeof StepInjections;
  readonly SignalDelivery: typeof SignalDelivery;
  readonly DrainScheduler: typeof DrainScheduler;

  // ── safety gate ──
  readonly reviewCommand: typeof reviewCommand;
  readonly formatApproval: typeof formatApproval;
  readonly withApprovalGate: typeof withApprovalGate;
  readonly argumentDigest: typeof argumentDigest;

  // ── evolution gate ──
  readonly checkMisevolution: typeof checkMisevolution;
  readonly decidePromotion: typeof decidePromotion;
  readonly selectEvolutionBase: typeof selectEvolutionBase;

  // ── memory retrieval ──
  readonly hybridSearch: typeof hybridSearch;
  readonly reciprocalRankFusion: typeof reciprocalRankFusion;

  // ── delegation ──
  readonly delegationFeatures: typeof delegationFeatures;
  readonly renderDelegationFeatures: typeof renderDelegationFeatures;

  // ── in-episode craft fitness ──
  readonly craftInvocationSites: typeof craftInvocationSites;
  readonly craftFailureBlame: typeof craftFailureBlame;
  readonly craftInvocationError: typeof craftInvocationError;

  // ── tool contract ──
  readonly renderToolSchemaDescription: typeof renderToolSchemaDescription;

  // ── file plane ──
  readonly applyFileEdits: typeof applyFileEdits;
  readonly readFileSlice: typeof readFileSlice;

  // ── execution signal ──
  readonly devicePresence: typeof devicePresence;
  readonly deviceChangeNotice: typeof deviceChangeNotice;
  readonly parseDevicePresence: typeof parseDevicePresence;
}

export type SubjectName = keyof PipelineSubjects;

/** Where each subject is defined, relative to `packages/core/src`. The
 *  dependency-closure proof walks the import graph from these files. */
export const SUBJECT_SOURCE = {
  buildSystemPromptSync: 'prompt.ts',
  compilePromptSurface: 'prompting/surface.ts',
  renderAgentsMdSection: 'prompting/agents-md.ts',
  renderActiveSkillsSection: 'skills/render.ts',
  resolveActiveSkills: 'skills/loader.ts',

  renderDynamicContextBlock: 'prompting/volatile-context.ts',
  turnLocalContextMessage: 'prompting/volatile-context.ts',
  DynamicContextLedger: 'prompting/volatile-context.ts',
  renderFactsBlock: 'memory/facts.ts',

  composePrepareStep: 'prompting/prepare-step.ts',
  pruneStepToolOutputs: 'prompting/step-prune.ts',
  markCacheTail: 'prompting/cache-breakpoints.ts',
  applyCacheBreakpoints: 'prompting/cache-breakpoints.ts',
  resolvePromptCacheStrategy: 'prompting/cache-breakpoints.ts',
  cacheableSystem: 'prompting/cache-breakpoints.ts',
  promptCacheOptions: 'prompting/cache-breakpoints.ts',

  contextWindowForModel: 'context-window.ts',
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
  SignalDelivery: 'orchestrator/signals.ts',
  DrainScheduler: 'orchestrator/drain-scheduler.ts',

  reviewCommand: 'safety/approval-gate.ts',
  formatApproval: 'safety/approval-gate.ts',
  withApprovalGate: 'safety/approval-gate.ts',
  argumentDigest: 'safety/argument-digest.ts',

  checkMisevolution: 'scaffold/misevolution.ts',
  decidePromotion: 'scaffold/shadow.ts',
  selectEvolutionBase: 'scaffold/archive.ts',

  hybridSearch: 'memory/hybrid-search.ts',
  reciprocalRankFusion: 'memory/vector-store.ts',

  delegationFeatures: 'evolution/delegation-features.ts',
  renderDelegationFeatures: 'evolution/delegation-features.ts',

  craftInvocationSites: 'craft/in-episode.ts',
  craftFailureBlame: 'craft/in-episode.ts',
  craftInvocationError: 'craft/in-episode.ts',

  renderToolSchemaDescription: 'tools/registry.ts',

  applyFileEdits: 'tools/file-edit.ts',
  readFileSlice: 'tools/file-edit.ts',

  devicePresence: 'execution/device-status.ts',
  deviceChangeNotice: 'execution/device-status.ts',
  parseDevicePresence: 'execution/device-status.ts',
} satisfies Record<SubjectName, string>;

/**
 * Bind the live turn pipeline. `rt` satisfies `buildSystemPromptSync`'s
 * signature only — the gate passes `soulOverride` on every prompt probe, so
 * no storage is touched and the gate stays free of I/O, clocks and RNG.
 */
export function createPipelineSubjects(rt: AgentRuntime): PipelineSubjects {
  return {
    buildSystemPromptSync: (opts) => buildSystemPromptSync(rt, opts),
    compilePromptSurface,
    renderAgentsMdSection,
    renderActiveSkillsSection,
    resolveActiveSkills,

    renderDynamicContextBlock,
    turnLocalContextMessage,
    DynamicContextLedger,
    renderFactsBlock,

    composePrepareStep,
    pruneStepToolOutputs,
    markCacheTail,
    applyCacheBreakpoints,
    resolvePromptCacheStrategy,
    cacheableSystem,
    promptCacheOptions,

    contextWindowForModel,
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
    SignalDelivery,
    DrainScheduler,

    reviewCommand,
    formatApproval,
    withApprovalGate,
    argumentDigest,

    checkMisevolution,
    decidePromotion,
    selectEvolutionBase,

    hybridSearch,
    reciprocalRankFusion,

    delegationFeatures,
    renderDelegationFeatures,

    craftInvocationSites,
    craftFailureBlame,
    craftInvocationError,

    renderToolSchemaDescription,

    applyFileEdits,
    readFileSlice,

    devicePresence,
    deviceChangeNotice,
    parseDevicePresence,
  };
}
