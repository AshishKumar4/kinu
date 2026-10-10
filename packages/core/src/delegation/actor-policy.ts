/**
 * What an agent is, read from its row by every path that decides by kind (design v2 §9, v3 D): static structure only,
 * never a turn's, a run's or anything that changes. Such a path reads this, never an id compared to the workspace's own
 * agent's.
 */
import type { WorkspaceActor } from '../identity/workspace-actors';

export interface ActorPolicy {
  /** Hierarchy: the agent that hired it, whose turns it answers in a hirer's lane; none for the workspace's own agent. */
  readonly hirer: string | null;
  /** Placement: the workspace's own agent, which acts as the session's user, spends the workspace's missions, and hands
   *  its settled turns to the workspace, whose lanes they are. */
  readonly workspaceAgent: boolean;
}

export function actorPolicy(actor: Pick<WorkspaceActor, 'parentActorId' | 'origin'>): ActorPolicy {
  return { hirer: actor.parentActorId, workspaceAgent: actor.origin === 'system' };
}
