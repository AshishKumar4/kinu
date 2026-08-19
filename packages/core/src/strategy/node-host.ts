/**
 * The node-host CONTRACT: what a host is handed, what it must give back, and the
 * arbiter it may reach while the node runs.
 *
 * Separate from `node-agent.ts`, which implements the loop, and the split is a
 * layering fact rather than tidiness. A backend declares this seam on
 * `types/backend-host.ts`, so whatever the seam's types live in becomes reachable
 * from the mid-turn-injection layer. `node-agent.ts` pulls in the AI SDK, the
 * builtin tool surface and the head inference loop; importing it from a host
 * declaration dragged all of that across a layer boundary and the layer gate
 * refused it, correctly. Everything here is a type over data, so a declaration
 * costs nothing.
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
 * May answer asynchronously, and that is not decoration: when a node runs in a
 * facet rather than in the search's own isolate, the arbiter is on the other
 * side of an RPC and the search's budget is not a value the node's host holds.
 * A synchronous-only arbiter would make hosting a node unrepresentable, so the
 * seam is async and the in-process caller simply returns a value.
 */
export type NodeArbiter = (proposal: BranchProposal) => BranchDecision | Promise<BranchDecision>;

/**
 * Everything a host needs to run one node's loop.
 *
 * Every field is DATA, deliberately: a host may be a Durable Object facet on the
 * far side of an RPC, so anything that cannot be serialised cannot be in here.
 * That constraint is what keeps the in-process and hosted paths honest — if the
 * spec were allowed a closure, the two paths would quietly diverge into two
 * runtimes again, because only one of them could carry it.
 */
export interface NodeRunSpec {
  readonly headInput: HeadInput;
  /** The base system prompt this node's framing is built on. */
  readonly base: string;
  /** The conversation the engine assembled for this node, task last. */
  readonly messages: readonly ModelMessage[];
  readonly isolation: NodeIsolation;
  readonly home: string;
  readonly maxSteps: number;
  /**
   * Whether a proposal could be granted at all — the BUILD-TIME half of the
   * arbitration rule. A request that can only ever be refused must not be
   * offered, because offering it spends a step to learn a limit the surface
   * already knew. Carried as data rather than inferred from the arbiter, because
   * a host's arbiter is an RPC stub and always present.
   */
  readonly canPropose: boolean;
}

/** What one node's loop produced. Serialisable, for the spec's reason. */
export interface NodeLoopResult {
  readonly report: HeadReport;
  readonly reported: CapturedReport | null;
  readonly granted: BranchDecision | null;
  readonly produced: readonly ModelMessage[];
}

/**
 * A host that runs a node's loop somewhere else.
 *
 * The implementation is a backend's, because only a backend can reach both the
 * facet API and the parent stub the loop's live seams have to call back through
 * — which is exactly how a head's mission ledger already works.
 *
 * It takes the SPEC and the live arbiter separately, and the split is the whole
 * boundary rule: a host runs in the SEARCH's isolate, so it may hold a closure,
 * while only the spec is handed across to the node. That is what lets a host
 * publish the arbiter under this node's id for the life of the run and hand the
 * facet an RPC that reaches it, instead of trying to serialise a decision that
 * depends on a budget the node cannot see.
 */
export type NodeLoopHost = (
  spec: NodeRunSpec,
  arbitrate: NodeArbiter | null,
) => Promise<NodeLoopResult>;
