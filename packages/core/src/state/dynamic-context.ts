// Binds each dynamic-context plane to the store answering it, once for both backends.
// `agentDynamicContext` owns which planes exist.

import type { AgentRuntime } from '../types/agent-runtime';
import type { AgentStores } from './agent-stores';
import {
  agentDynamicContext, type DynamicApproval, type DynamicContext, type DynamicDelegate, type MissingCapability, type RuntimeFacts,
} from '../prompting/volatile-context';
import type { ActiveRoster } from '../types/dynamic-context';
import { renderFactsForTurn } from '../orchestrator/turn-surface';
import { listRecoveryFindings } from '../evolution/recovery';
import { listToolLessons, MAX_TOOL_LESSONS, shownLesson } from '../evolution/struggles';
import { craftedToolDeclarations, externalToolDeclarations, runnableSandbox } from '../tools/sandbox-contract';
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
  /** The turn's MCP and extension tools, which only `eval` reaches. */
  readonly externalTools?: ToolSet;
  readonly runtime: RuntimeFacts;
  readonly turn?: TurnReason;
  readonly activeSkills?: ActiveSkillSet;
  /** Read once per turn by the caller. */
  readonly memoryTail: string | undefined;
  readonly missingCapabilities: readonly MissingCapability[];
  /** Down MCP servers (`server` null: the catalog), noted only where `eval` reaches MCP tools. */
  readonly unavailableMcp?: readonly { readonly server: string | null; readonly reason: string }[];
  /** Backend-only planes, as callbacks: no backend re-splices the result. */
  readonly subordinateDelegates?: () => readonly DynamicDelegate[];
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
  /** Slates whose latest source does not build, each `id: why`. */
  readonly failingSlates?: () => readonly string[];
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

/** Nothing finer than the caller's date: a wall-clock field would re-fingerprint the block every step. */
export function collectDynamicContext(input: DynamicContextInput): DynamicContext {
  const { rt, stores } = input;
  const { profile } = input;

  return agentDynamicContext({
    runtime: input.runtime,
    ...(input.turn !== undefined && { turn: input.turn }),
    ...(input.activeSkills !== undefined && { activeSkills: input.activeSkills }),
    mode: {
      workMode: profile.workMode,
      planSubmission: profile.allowedTools.includes(SUBMIT_PLAN_TOOL) && input.tools[SUBMIT_PLAN_TOOL] !== undefined,
    },
    craftedTools: craftedToolDeclarations(input.tools, profile),
    externalTools: externalToolDeclarations(input.tools, input.externalTools ?? {}, profile),
    factsBlock: renderFactsForTurn(stores.facts),
    memoryTail: input.memoryTail,
    recoveryFindings: listRecoveryFindings(rt.storage.sql, rt.actor),
    toolLessons: listToolLessons(rt.storage.sql, rt.actor, Object.keys(input.tools), MAX_TOOL_LESSONS).map(shownLesson),
    executors: rt.executionRouter?.listExecutors() ?? [],
    // Same cached snapshot the executor row reads, so the two agree.
    devices: rt.deviceTransport?.status().devices,
    runningJobs: stores.jobs.listRunning(),
    openTasks: stores.taskList.listOpen(),
    liveHeadRuns: stores.headJournal.listLive(),
    subordinateDelegates: input.subordinateDelegates?.(),
    approvals: input.approvals?.(),
    failingSlates: input.failingSlates?.(),
    missingCapabilities: [
      ...(runnableSandbox(input.tools, profile) === undefined ? [] : input.unavailableMcp ?? []).map(({ server, reason }) => ({
        source: server === null ? 'MCP catalog' : `MCP server "${server}"`, reason,
      })),
      ...input.missingCapabilities,
    ],
  });
}

