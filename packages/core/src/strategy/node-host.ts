/**
 * The NODE-RUN CONTRACT: what one node's loop is handed, what it gives back, and
 * the arbiter it may reach while the node runs.
 *
 * Separate from `node-agent.ts`, which implements the loop, and the split is a
 * layering fact rather than tidiness. `node-agent.ts` pulls in the AI SDK, the
 * builtin tool surface and the head inference loop, so every layer that needs to
 * NAME a node's run — the strategy surface, the swarm tree, a resume's stored
 * outcome — would drag all of that across a layer boundary the gate refuses,
 * correctly. Everything here is a type over data, so a declaration costs nothing.
 */

import type { ModelMessage } from 'ai';
import type { HeadInput, HeadReport } from '../heads/types';
import type { BranchProposal } from './swarm';
import type { BranchDecision } from './swarm-budget';
import type { NodeIsolation } from './node-workspace';

/** What the node's `report` call left behind, before the engine reads it. */
export interface CapturedReport {
  readonly status: string;
  readonly content: string;
}

/**
 * Arbitrates one node's branch request.
 *
 * May answer asynchronously, and that is not decoration: the search's budget is
 * not a value a node holds, so the arbiter is the search's own function and a
 * node reads its verdict as a return value. A synchronous-only arbiter would
 * make an arbiter that has to ask anything unrepresentable, so the seam is async
 * and the in-process caller simply returns a value.
 */
export type NodeArbiter = (proposal: BranchProposal) => BranchDecision | Promise<BranchDecision>;

/**
 * Everything one node's loop needs that is not a live seam.
 *
 * Every field is DATA, deliberately, and that survived the transport it was
 * written for: a spec allowed a closure is a spec that can only be built where it
 * is consumed, and the split between this and a node's live seams — the model, the
 * actor, the callbacks that reach the search mid-run — is what keeps the loop's
 * inputs readable as one value.
 */
export interface NodeRunSpec {
  readonly headInput: HeadInput;
  /** The base system prompt this node's framing is built on. */
  readonly base: string;
  /** The conversation the engine assembled for this node, task last. */
  readonly messages: readonly ModelMessage[];
  readonly isolation: NodeIsolation;
  readonly home: string;
}

/** What one node's loop produced. */
export interface NodeLoopResult {
  readonly report: HeadReport;
  readonly reported: CapturedReport | null;
  readonly granted: BranchDecision | null;
  readonly produced: readonly ModelMessage[];
  /**
   * What the executor the loop actually ran on could execute.
   *
   * Reported by the loop rather than read off the caller, because the two are not
   * necessarily the same runtime: a node with a provisioned home runs on a
   * rebuilt one. Reading the caller's list to parse such a node's proposal is
   * reading one runtime's capability as another's — and the proposal fence
   * (`readProposalCode`) is exactly what that list decides.
   */
  readonly languages: readonly [string, ...string[]];
}

