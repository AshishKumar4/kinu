/**
 * The team and the task-lifetime port as a backend wires them for one actor. What follows from the actor and its
 * workspace's directory is derived here: its depth (`delegationBudgetOf`), its hires' names (`agentNamer`), its clock
 * and its place in the tree. A backend passes only what it alone reaches: its stores, its runtime and its transport.
 */
import type { ActorReference } from '../identity/actor-handle';
import type { WorkspaceActor, WorkspaceActorDirectory } from '../identity/workspace-actors';
import type { TeamToolDeps } from '../delegation/agents-tool';
import { delegationBudgetOf } from './depth';
import type { SubagentRosterStore } from './roster';
import { agentNamer, createTeamToolDeps, type SubagentRuntime } from './support';
import { createTemporaryAgentPort, type TemporaryAgentPort } from './temporary';

/** One actor's team deps. */
export function teamToolDepsFor(deps: Omit<Parameters<typeof createTeamToolDeps>[0], 'delegation' | 'createName' | 'now' | 'treeOwner'> & {
  readonly record: WorkspaceActor;
  readonly directory: Pick<WorkspaceActorDirectory, 'namesFrom' | 'retained'>;
}): TeamToolDeps {
  const { record, directory, ...rest } = deps;

  return createTeamToolDeps({
    ...rest,
    delegation: delegationBudgetOf((actorId) => directory.retained(actorId), record),
    createName: agentNamer(directory, deps.roster),
    now: () => Date.now(),
    treeOwner: record.parentActorId === null ? 'main' : record.actorId,
  });
}

/** The task-lifetime port a backend wires for one hirer, its hires named and timed as its team's are. */
export function temporaryPortFor(deps: {
  readonly roster: SubagentRosterStore;
  readonly runtime: SubagentRuntime;
  readonly directory: Pick<WorkspaceActorDirectory, 'namesFrom'>;
  afterTurn(child: ActorReference, work: () => Promise<void>): void;
}): TemporaryAgentPort {
  return createTemporaryAgentPort({
    roster: deps.roster, runtime: deps.runtime, afterTurn: (child, work) => { deps.afterTurn(child, work); },
    createName: agentNamer(deps.directory, deps.roster), now: () => Date.now(),
  });
}
