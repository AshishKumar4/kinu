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
  EphemeralContextLedger,
  renderSystemStateBlock,
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
import { classifyTurnFailure, planOverflowRecovery } from '../turn-failure.js';
import {
  buildCompactionSummaryPrompt,
  stripCheckpointPreamble,
  wrapCompactionSummary,
} from '../compaction.js';
import { buildDrainBatch } from '../events/hub/drain.js';
import { renderForLLM } from '../events/hub/visibility.js';
import { StepInjections } from '../prompting/step-injections.js';
import { EventInjectionBuffer } from '../orchestrator/event-injection.js';
import { DrainScheduler } from '../orchestrator/drain-scheduler.js';
import { formatApproval, reviewCommand, withApprovalGate } from '../safety/approval-gate.js';
import { argumentDigest, stableStringify } from '../safety/argument-digest.js';
import { checkMisevolution } from '../scaffold/misevolution.js';
import { decidePromotion } from '../scaffold/shadow.js';
import { selectEvolutionBase } from '../scaffold/archive.js';
import { hybridSearch } from '../memory/hybrid-search.js';
import { reciprocalRankFusion } from '../memory/vector-store.js';
import { delegationFeatures, renderDelegationFeatures } from '../evolution/delegation-features.js';
import { renderToolSchemaDescription } from '../tools/registry.js';
import {
  deviceChangeNotice,
  devicePresence,
  parseDevicePresence,
} from '../execution/device-status.js';

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
  readonly renderSystemStateBlock: typeof renderSystemStateBlock;
  readonly turnLocalContextMessage: typeof turnLocalContextMessage;
  readonly EphemeralContextLedger: typeof EphemeralContextLedger;
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
  readonly classifyTurnFailure: typeof classifyTurnFailure;
  readonly planOverflowRecovery: typeof planOverflowRecovery;

  // ── compaction ──
  readonly buildCompactionSummaryPrompt: typeof buildCompactionSummaryPrompt;
  readonly wrapCompactionSummary: typeof wrapCompactionSummary;
  readonly stripCheckpointPreamble: typeof stripCheckpointPreamble;

  // ── event reactor ──
  readonly buildDrainBatch: typeof buildDrainBatch;
  readonly renderForLLM: typeof renderForLLM;
  readonly StepInjections: typeof StepInjections;
  readonly EventInjectionBuffer: typeof EventInjectionBuffer;
  readonly DrainScheduler: typeof DrainScheduler;

  // ── safety gate ──
  readonly reviewCommand: typeof reviewCommand;
  readonly formatApproval: typeof formatApproval;
  readonly withApprovalGate: typeof withApprovalGate;
  readonly argumentDigest: typeof argumentDigest;
  readonly stableStringify: typeof stableStringify;

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

  // ── tool contract ──
  readonly renderToolSchemaDescription: typeof renderToolSchemaDescription;

  // ── execution signal ──
  readonly devicePresence: typeof devicePresence;
  readonly deviceChangeNotice: typeof deviceChangeNotice;
  readonly parseDevicePresence: typeof parseDevicePresence;
}

export type SubjectName = keyof PipelineSubjects;

/** Where each subject is defined, relative to `packages/core/src`. The
 *  dependency-closure proof walks the import graph from these files. */
export const SUBJECT_SOURCE: Record<SubjectName, string> = {
  buildSystemPromptSync: 'prompt.ts',
  compilePromptSurface: 'prompting/surface.ts',
  renderAgentsMdSection: 'prompting/agents-md.ts',
  renderActiveSkillsSection: 'skills/render.ts',
  resolveActiveSkills: 'skills/loader.ts',

  renderSystemStateBlock: 'prompting/volatile-context.ts',
  turnLocalContextMessage: 'prompting/volatile-context.ts',
  EphemeralContextLedger: 'prompting/volatile-context.ts',
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

  buildCompactionSummaryPrompt: 'compaction.ts',
  wrapCompactionSummary: 'compaction.ts',
  stripCheckpointPreamble: 'compaction.ts',

  buildDrainBatch: 'events/hub/drain.ts',
  renderForLLM: 'events/hub/visibility.ts',
  StepInjections: 'prompting/step-injections.ts',
  EventInjectionBuffer: 'orchestrator/event-injection.ts',
  DrainScheduler: 'orchestrator/drain-scheduler.ts',

  reviewCommand: 'safety/approval-gate.ts',
  formatApproval: 'safety/approval-gate.ts',
  withApprovalGate: 'safety/approval-gate.ts',
  argumentDigest: 'safety/argument-digest.ts',
  stableStringify: 'safety/argument-digest.ts',

  checkMisevolution: 'scaffold/misevolution.ts',
  decidePromotion: 'scaffold/shadow.ts',
  selectEvolutionBase: 'scaffold/archive.ts',

  hybridSearch: 'memory/hybrid-search.ts',
  reciprocalRankFusion: 'memory/vector-store.ts',

  delegationFeatures: 'evolution/delegation-features.ts',
  renderDelegationFeatures: 'evolution/delegation-features.ts',

  renderToolSchemaDescription: 'tools/registry.ts',

  devicePresence: 'execution/device-status.ts',
  deviceChangeNotice: 'execution/device-status.ts',
  parseDevicePresence: 'execution/device-status.ts',
};

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

    renderSystemStateBlock,
    turnLocalContextMessage,
    EphemeralContextLedger,
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

    buildCompactionSummaryPrompt,
    wrapCompactionSummary,
    stripCheckpointPreamble,

    buildDrainBatch,
    renderForLLM,
    StepInjections,
    EventInjectionBuffer,
    DrainScheduler,

    reviewCommand,
    formatApproval,
    withApprovalGate,
    argumentDigest,
    stableStringify,

    checkMisevolution,
    decidePromotion,
    selectEvolutionBase,

    hybridSearch,
    reciprocalRankFusion,

    delegationFeatures,
    renderDelegationFeatures,

    renderToolSchemaDescription,

    devicePresence,
    deviceChangeNotice,
    parseDevicePresence,
  };
}
