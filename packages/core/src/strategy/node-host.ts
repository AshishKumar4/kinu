/**
 * The node-run contract. Separate from `node-agent.ts` so layers that only name a
 * node's run do not import the AI SDK and tool surface across a gated boundary.
 */

import type { ModelMessage } from 'ai';
import type { HeadInput, HeadReport } from '../heads/types';
import type { BranchProposal } from './swarm';
import type { BranchDecision } from './swarm-budget';
import type { NodeIsolation } from './node-workspace';

export interface CapturedReport {
  readonly status: string;
  readonly content: string;
}

/** Async because the budget lives with the search, not the node; the node reads its verdict as a return value. */
export type NodeArbiter = (proposal: BranchProposal) => BranchDecision | Promise<BranchDecision>;

/** Data only: no closures, so a spec can be built away from where it is consumed. */
export interface NodeRunSpec {
  readonly headInput: HeadInput;
  readonly base: string;
  /** Task last. */
  readonly messages: readonly ModelMessage[];
  readonly isolation: NodeIsolation;
  readonly home: string;
}

export interface NodeLoopResult {
  readonly report: HeadReport;
  readonly reported: CapturedReport | null;
  readonly granted: BranchDecision | null;
  readonly produced: readonly ModelMessage[];
  /**
   * Languages of the executor the loop actually ran on, which may differ from the
   * caller's (a provisioned home is rebuilt); `readProposalCode` depends on it.
   */
  readonly languages: readonly [string, ...string[]];
}

