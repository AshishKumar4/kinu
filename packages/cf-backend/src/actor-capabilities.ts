/**
 * The one entry an agent's turn surface is built from, for every kind (design v2 §2): its policy and the turn's lane
 * decide once what the turn may reach (core `turnReach`), and the builder its placement names makes the tools,
 * instrumentation, claim wrappers, external reach and plan reply over that reach.
 */
import { turnLane, turnReach, type ActorPolicy, type TurnReach } from '@kinu.run/core';
import type { HostedTaskProfile, HostedTaskTurn } from './hosted-actors';

export interface CapabilityBuilders {
  /** Whether a plan of the agent's, sent back with comments, awaits its answers. */
  awaitsReply(turn: HostedTaskTurn): Promise<boolean>;
  /** An agent's surface over its own runtime and stores. */
  hosted(turn: HostedTaskTurn, reach: TurnReach): Promise<HostedTaskProfile>;
  /**
   * TEMPORARY adapter until design v2 step 7: the workspace agent's surface is still built over the root's accumulator
   * (`ActorAgent.mainTaskProfile`, `actorToolsets`), and folds into `hosted` once step 7 removes it. Listed H in
   * `scripts/root-branches.json`, so step 7 cannot close with it here.
   */
  workspaceAgent(turn: HostedTaskTurn, reach: TurnReach): Promise<HostedTaskProfile>;
}

export const ActorCapabilities = {
  /** A turn's surface. Its lane is its hirer's only for an agent that has one (the agent's chat sends the turn's own). */
  async for(builders: CapabilityBuilders, policy: ActorPolicy, turn: HostedTaskTurn): Promise<HostedTaskProfile> {
    const lane = turnLane(policy, turn.parentDriven ? 'hirer' : 'owner');
    const reach = turnReach({ lane, mode: turn.input.mode, driving: turn.driving, ownerSurface: true, awaitsReply: await builders.awaitsReply(turn) });

    return policy.workspaceAgent ? await builders.workspaceAgent(turn, reach) : await builders.hosted(turn, reach);
  },
};
