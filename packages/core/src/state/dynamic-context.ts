// Binds each dynamic-context plane to the store answering it, once for both backends.
// `agentDynamicContext` owns which planes exist.

import type { AgentRuntime } from '../types/agent-runtime';
import type { AgentStores } from './agent-stores';
import {
  agentDynamicContext, type DynamicApproval, type DynamicContext, type DynamicDelegate, type MissingCapability, type RuntimeFacts,
  type SecretsInContext,
} from '../prompting/volatile-context';
import type { MailInContext } from '../mail/in-context';
import type { ActiveRoster, ShownLesson } from '../types/dynamic-context';
import { renderFactsForTurn } from '../orchestrator/turn-surface';
import { listRecoveryFindings } from '../evolution/recovery';
import { listToolLessons, MAX_TOOL_LESSONS, shownLesson } from '../evolution/struggles';
import { craftedToolDeclarations, externalToolDeclarations, runnableSandbox } from '../tools/sandbox-contract';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import { SUBMIT_PLAN_TOOL } from '../tools/registry';
import type { ActiveSkillSet } from '../skills/types';
import type { TurnReason } from '../types/turn';
import type { ToolSet } from 'ai';
import type { Fact, FactsStore } from '../memory/facts';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { ASKED, type Holds } from '../utils/held-reads';

/** The rows a dynamic block reads from its agent's stores. */
export interface DynamicReads {
  readonly facts: Pick<FactsStore, 'recentTopK' | 'all'>;
  readonly recoveryFindings: () => string[];
  readonly toolLessons: (tools: readonly string[]) => ShownLesson[];
  readonly runningJobs: AgentStores['jobs']['listRunning'];
  readonly awaitedJobs: AgentStores['jobs']['countAwaited'];
  readonly openTaskState: AgentStores['taskList']['openState'];
  readonly openTasks: AgentStores['taskList']['listOpen'];
  readonly liveHeadRuns: AgentStores['headJournal']['listLive'];
}

/**
 * An agent's dynamic-block reads through `holds`: a Durable Object reads each once until a statement through its
 * executors writes a table the read selects from. Every writer named below runs over the agent's `sql`.
 */
export function dynamicReads(stores: AgentStores, sql: SqlExecutor, actor: ActorHandle, holds: Holds = ASKED): DynamicReads {
  // scoreToolLessons and the rewrite that replaces a lesson; one entry per tool set, its names a line each.
  const lessons = holds.holdEach(['tool_lessons'], (names: string) => listToolLessons(sql, actor, names === '' ? [] : names.split('\n'), MAX_TOOL_LESSONS)
    .map(shownLesson));

  return {
    // FactsStore's upsert, observe and forget, and a fork's section import.
    facts: {
      recentTopK: holds.holdEach(['agent_facts'], (k: number) => stores.facts.recentTopK(k)),
      all: holds.hold(['agent_facts'], () => stores.facts.all()),
    },
    // recordLesson.
    recoveryFindings: holds.hold(['lessons'], () => listRecoveryFindings(sql, actor)),
    toolLessons: (tools) => lessons(tools.join('\n')),
    // BackgroundJobStore's create, settle, fail, cancel, reclaim, deferResume, dismiss and clear.
    runningJobs: holds.holdEach(['background_jobs'], (limit: number | undefined) => stores.jobs.listRunning(limit)),
    awaitedJobs: holds.hold(['background_jobs'], () => stores.jobs.countAwaited()),
    openTaskState: holds.hold(['agent_tasks'], () => stores.taskList.openState()),
    // TaskListStore's add and updates.
    openTasks: holds.holdEach(['agent_tasks'], (limit: number | undefined) => stores.taskList.listOpen(limit)),
    // HeadJournal's split, spawn, report, interrupt, abandon and merge.
    liveHeadRuns: holds.holdEach(['head_journal', 'head_runs'], (limit: number | undefined) => stores.headJournal.listLive(limit)),
  };
}

export interface DynamicContextInput {
  readonly rt: AgentRuntime;
  readonly stores: AgentStores;
  /** Its store reads, held by a host that holds them; absent, read afresh. */
  readonly reads?: DynamicReads;
  readonly profile: Pick<ResolvedTurnProfile, 'workMode' | 'allowedTools'>;
  readonly tools: ToolSet;
  /** The turn's MCP and extension tools, which only `eval` reaches. */
  readonly externalTools?: ToolSet;
  readonly runtime: RuntimeFacts;
  readonly turn?: TurnReason;
  readonly activeSkills?: ActiveSkillSet;
  /** Read once per turn by the caller. */
  readonly memoryTail: string | undefined;
  /** The account's facts, read once per turn by the caller; absent where no account is wired. */
  readonly accountFacts?: readonly Fact[];
  readonly missingCapabilities: readonly MissingCapability[];
  /** Down MCP servers (`server` null: the catalog), noted only where `eval` reaches MCP tools. */
  readonly unavailableMcp?: readonly { readonly server: string | null; readonly reason: string }[];
  /** Backend-only planes, as callbacks: no backend re-splices the result. */
  readonly subagentDelegates?: () => readonly DynamicDelegate[];
  readonly approvals?: () => ActiveRoster<DynamicApproval>;
  /** Slates whose latest source does not build, each `id: why`. */
  readonly failingSlates?: () => readonly string[];
  /** The owner's secrets granted to the workspace, as it last read them. */
  readonly secrets?: SecretsInContext;
  /** The agent's unread mail, read once per turn by the caller; absent where it has no box. */
  readonly mail?: ActiveRoster<MailInContext>;
}

export function subagentDelegatesOf(
  entries: readonly {
    readonly name: string;
    readonly status: string;
    readonly currentTask: string | null;
  }[],
): DynamicDelegate[] {
  return entries.map((entry) => ({
    kind: 'subagent',
    name: entry.name,
    phase: entry.status,
    task: entry.currentTask,
  }));
}

/** Nothing finer than the caller's date: a wall-clock field would re-fingerprint the block every step. */
export function collectDynamicContext(input: DynamicContextInput): DynamicContext {
  const { rt, profile } = input;
  const reads = input.reads ?? dynamicReads(input.stores, rt.storage.sql, rt.actor);

  return agentDynamicContext({
    runtime: input.runtime,
    ...(input.turn !== undefined && { turn: input.turn }),
    ...(input.activeSkills !== undefined && { activeSkills: input.activeSkills }),
    mode: {
      workMode: profile.workMode,
      planSubmission: profile.allowedTools.includes(SUBMIT_PLAN_TOOL) && input.tools[SUBMIT_PLAN_TOOL] !== undefined,
    },
    // With crafting off the section stays silent: no tool is offered, and none is asked for.
    ...(rt.actor.config.getCrafting() && { craftedTools: craftedToolDeclarations(input.tools, profile) }),
    externalTools: externalToolDeclarations(input.tools, input.externalTools ?? {}, profile),
    factsBlock: renderFactsForTurn(reads.facts, input.accountFacts),
    memoryTail: input.memoryTail,
    recoveryFindings: reads.recoveryFindings(),
    toolLessons: reads.toolLessons(Object.keys(input.tools)),
    executors: rt.executionRouter?.listExecutors() ?? [],
    // Same cached snapshot the executor row reads, so the two agree.
    devices: rt.deviceTransport?.status().devices,
    runningJobs: reads.runningJobs(),
    openTasks: reads.openTasks(),
    liveHeadRuns: reads.liveHeadRuns(),
    subagentDelegates: input.subagentDelegates?.(),
    approvals: input.approvals?.(),
    ...(input.mail !== undefined && { mail: input.mail }),
    failingSlates: input.failingSlates?.(),
    ...(input.secrets !== undefined && { secrets: input.secrets }),
    missingCapabilities: [
      ...(runnableSandbox(input.tools, profile) === undefined ? [] : input.unavailableMcp ?? []).map(({ server, reason }) => ({
        source: server === null ? 'MCP catalog' : `MCP server "${server}"`, reason,
      })),
      ...input.missingCapabilities,
    ],
  });
}

