/**
 * The one entry an agent's turn surface is built from, for every kind (design v2 §2, §9): its policy decides once what
 * the agent reaches (core `actorReach`) and, with the turn's lane, what the turn reaches (core `turnReach`); one builder
 * makes the tools, instrumentation, claim wrappers, external reach and plan reply over both.
 */
import { actorReach, turnLane, turnReach, type ActorPolicy, type ActorReach, type TurnReach } from '@kinu.run/core';
import type { HostedTaskProfile, HostedTaskTurn } from './hosted-actors';

export interface CapabilityBuilders {
  /** Whether a plan of the agent's, sent back with comments, awaits its answers. */
  awaitsReply(turn: HostedTaskTurn): Promise<boolean>;
  /** An agent's surface over its own hosted actor, its runtime, stores and session. */
  build(turn: HostedTaskTurn, reach: TurnReach, scope: ActorReach): Promise<HostedTaskProfile>;
}

export const ActorCapabilities = {
  /** A turn's surface. Its lane is its hirer's only for an agent that has one (the agent's chat sends the turn's own). */
  async for(builders: CapabilityBuilders, policy: ActorPolicy, turn: HostedTaskTurn): Promise<HostedTaskProfile> {
    const lane = turnLane(policy, turn.parentDriven ? 'hirer' : 'owner');
    const reach = turnReach({ lane, mode: turn.input.mode, driving: turn.driving, ownerSurface: true, awaitsReply: await builders.awaitsReply(turn) });

    return await builders.build(turn, reach, actorReach(policy));
  },
};
