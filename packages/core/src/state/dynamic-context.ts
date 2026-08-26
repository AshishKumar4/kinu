/**
 * Where each plane of the agent's live per-step state is READ FROM.
 *
 * `agentDynamicContext` (prompting/volatile-context.ts) owns which planes exist
 * and when one is omitted rather than rendered empty, and it is deliberately
 * structural — "how a backend journals a head run or registers a job is not
 * this layer's business". That left the binding itself — which store answers
 * each plane — stated once per backend, in two eight-field literals that
 * differed only in how each side happened to name its own fields. This module
 * is that binding, held once.
 *
 * Only the two genuinely per-turn inputs stay arguments: the MEMORY.md tail
 * (the one read behind an await, so the caller closes over it) and the
 * unavailable-MCP roster, which each backend learns from its own connect path.
 */

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

export interface DynamicContextInput {
  readonly rt: AgentRuntime;
  readonly stores: AgentStores;
  /** The turn's MEMORY.md tail — read once per turn behind the only await in
   *  this plane, so the caller passes it rather than re-reading per step. */
  readonly memoryTail: string | undefined;
  /** MCP servers this backend's connect path could not reach. */
  readonly missingCapabilities: readonly MissingCapability[];
  /**
   * The planes only the backend's own stores can answer, passed as typed source
   * callbacks so the assembler stays the ONE place a plane is bound and no
   * backend re-splices fields over the assembled result.
   *
   * - `subordinateDelegates` — this actor's own hires, listed ahead of the
   *   search roster `HeadJournal.listLive()` contributes.
   * - `approvals` — decisions currently parked on the user.
   *
   * Backend-only capability notices join `missingCapabilities` at the adapter
   * boundary instead of widening this shared contract with a one-sided field.
   */
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

/**
 * The live state of one agent, read fresh for ONE model step.
 *
 * Every field comes from its existing store, and nothing is clock-derived: a
 * wall-clock field would re-fingerprint the block on every request and append a
 * block per step.
 */
export function collectDynamicContext(input: DynamicContextInput): DynamicContext {
  const { rt, stores } = input;
  return agentDynamicContext({
    factsBlock: renderFactsForTurn(stores.facts),
    memoryTail: input.memoryTail,
    recoveryFindings: listRecoveryFindings(rt.storage.sql),
    executors: rt.executionRouter?.listExecutors() ?? [],
    runningJobs: stores.jobs.listRunning(),
    openTasks: stores.taskList.listOpen(),
    liveHeadRuns: stores.headJournal.listLive(),
    subordinateDelegates: input.subordinateDelegates?.(),
    approvals: input.approvals?.(),
    missingCapabilities: input.missingCapabilities,
  });
}

