// Binds each dynamic-context plane to the store that answers it, once for both backends.
// `agentDynamicContext` (prompting/volatile-context.ts) owns which planes exist.

import type { AgentRuntime } from '../types/agent-runtime';
import type { AgentStores } from './agent-stores';
import {
  agentDynamicContext,
  type DynamicApproval,
  type DynamicContext,
  type DynamicDelegate,
  type MissingCapability,
  type ActiveRoster,
} from '../prompting/volatile-context';
import { renderFactsForTurn } from '../orchestrator/turn-surface';
import { listRecoveryFindings } from '../evolution/recovery';
import { craftedToolDeclarations } from '../tools/sandbox-contract';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import { SUBMIT_PLAN_TOOL } from '../tools/registry';
import type { ActiveSkillSet } from '../skills/types';
import type { TurnReason } from '../types/turn';
import type { ToolSet } from 'ai';

export interface DynamicContextInput {
  readonly rt: AgentRuntime;
  readonly stores: AgentStores;
  readonly profile: Pick<ResolvedTurnProfile, 'workMode' | 'allowedTools'>;
  readonly tools: ToolSet;
  readonly turn?: TurnReason;
  readonly activeSkills?: ActiveSkillSet;
  /** Read once per turn by the caller (the only await in this plane). */
  readonly memoryTail: string | undefined;
  readonly missingCapabilities: readonly MissingCapability[];
  /** Backend-only planes, as callbacks so no backend re-splices the assembled result. */
  readonly subordinateDelegates?: () => readonly DynamicDelegate[];
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
}

export function subordinateDelegatesOf(
  entries: readonly {
    readonly name: string;
    readonly status: string;
    readonly currentTask: string | null;
  }[],
): DynamicDelegate[] {
  return entries.map((entry) => ({
    kind: 'subordinate',
    name: entry.name,
    phase: entry.status,
    task: entry.currentTask,
  }));
}

/** Nothing clock-derived: a wall-clock field would re-fingerprint the block every step. */
export function collectDynamicContext(input: DynamicContextInput): DynamicContext {
  const { rt, stores } = input;
  const { profile } = input;

  return agentDynamicContext({
    ...(input.turn !== undefined && { turn: input.turn }),
    ...(input.activeSkills !== undefined && { activeSkills: input.activeSkills }),
    mode: {
      workMode: profile.workMode,
      planSubmission: profile.allowedTools.includes(SUBMIT_PLAN_TOOL) && input.tools[SUBMIT_PLAN_TOOL] !== undefined,
    },
    craftedTools: craftedToolDeclarations(input.tools, profile),
    factsBlock: renderFactsForTurn(stores.facts),
    memoryTail: input.memoryTail,
    recoveryFindings: listRecoveryFindings(rt.storage.sql, rt.actor),
    executors: rt.executionRouter?.listExecutors() ?? [],
    // Same cached snapshot the executor row reads, so the two agree.
    devices: rt.deviceTransport?.status().devices,
    runningJobs: stores.jobs.listRunning(),
    openTasks: stores.taskList.listOpen(),
    liveHeadRuns: stores.headJournal.listLive(),
    subordinateDelegates: input.subordinateDelegates?.(),
    approvals: input.approvals?.(),
    missingCapabilities: input.missingCapabilities,
  });
}

