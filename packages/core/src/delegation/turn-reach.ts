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

/** What an agent reaches by what it is, whatever the turn (design v2 §9): computed once from its policy, and read by the
 *  one builder every agent's turn surface is made by. */
export interface ActorReach {
  /** Its programs' surface: the workspace's own (its memory, files, tasks, agents and self, its account), or a hire's,
   *  confined to its web, files and state. */
  readonly surface: 'program' | 'confined';
  /** The workspace's external tools, its owner's MCP servers and its extensions, declared to its eval. */
  readonly external: boolean;
  /** The workspace's lanes: its owner's turns are evolution's verdicts and its fresh ones draw trial arms, it spends the
   *  workspace's missions, its jobs are the workspace's, and the workspace's room streams its turns. */
  readonly lanes: boolean;
  /** Its owner's other workspaces, as peers. */
  readonly peers: boolean;
}

export function actorReach(policy: Pick<ActorPolicy, 'workspaceAgent'>): ActorReach {
  return policy.workspaceAgent
    ? { surface: 'program', external: true, lanes: true, peers: true }
    : { surface: 'confined', external: false, lanes: false, peers: false };
}
