/**
 * What one turn of an agent may reach by whom it answers (design v2 §1.6, §2): decided here once for every host, the
 * cloud's workspace agent and hires and the CLI's alike.
 */
import type { JsonObject } from '../utils/json';
import type { WorkMode } from '../types/turn';
import type { TurnAuthorship } from '../orchestrator/turn-authorship';
import { planSubmissionReach } from '../plans/review';
import type { ActorPolicy } from './actor-policy';

/** Whose lane a turn runs in: its hirer's only when the agent has one; an agent without a hirer answers its owner. */
export type TurnLane = 'owner' | 'hirer';

export function turnLane(policy: Pick<ActorPolicy, 'hirer'>, authorship: TurnAuthorship): TurnLane {
  return policy.hirer !== null && authorship === 'hirer' ? 'hirer' : 'owner';
}

export interface TurnReach {
  /** The hirer's lane reports to the hirer. */
  readonly report: boolean;
  /** The owner's lane asks the owner, where the host shows the owner this agent's questions. */
  readonly askOwner: boolean;
  /** The owner's lane submits a plan, where its mode and driving message allow one and the host reviews this agent's plans. */
  readonly submitPlan: boolean;
  /** The owner's lane answers the comments of a plan the owner sent back. */
  readonly replyToComment: boolean;
}

export function turnReach(input: {
  readonly lane: TurnLane;
  readonly mode: WorkMode;
  readonly driving: JsonObject | undefined;
  /** Whether the host shows the owner this agent's questions and plans: every agent's on the cloud, the root's alone on
   *  the CLI. */
  readonly ownerSurface: boolean;
  /** Whether a plan of the agent's, sent back with comments, awaits its answers. */
  readonly awaitsReply: boolean;
}): TurnReach {
  const owner = input.lane === 'owner' && input.ownerSurface;

  return {
    report: input.lane === 'hirer',
    askOwner: owner,
    submitPlan: owner && planSubmissionReach(input.mode, input.driving),
    replyToComment: owner && input.awaitsReply,
  };
}
