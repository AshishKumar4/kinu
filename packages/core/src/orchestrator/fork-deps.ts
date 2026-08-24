/**
 * The `agents` tool's swarm substrate, fully wired: the host-injected
 * infrastructure the LLM must not set, assembled identically by both backends
 * so neither can drift from the other. The team/peer halves of AgentsToolDeps
 * stay on each backend's profile.
 */

import type { LanguageModel } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime';
import type { AgentsForkDeps } from '../tools/agents-tool';
import type { CostModel } from '../mcts/cost';
import type { NodeLoopHost } from '../strategy/node-agent';
import type { NodeHomeHost } from '../strategy/node-workspace';

export interface ForkDepsWiring {
  rt: AgentRuntime;
  model: LanguageModel;
  /**
   * What the resolved model charges — the pre-run spend gate's pricing route.
   * Backends pass the ModelCatalogSession they already hold for the context
   * window and the mission ledger; `model` above is a `LanguageModel`, which
   * carries neither the spec it was built from nor a rate.
   *
   * Optional so a host with no catalog keeps today's behaviour: the gate blends
   * and its refusal says it blended.
   */
  costModel?: () => CostModel;
  /**
   * Where a tool-using swarm node's loop runs. A factory, for `costModel`'s
   * reason.
   *
   * PLATFORM-ONLY, and declared as such in `scripts/capability-parity.lock.json`
   * rather than left as an accident: a host is a Durable Object facet, and the
   * CLI backend runs one process with no facet API to reach. There is nothing for
   * it to wire against, so it wires nothing.
   *
   * Absent is not a degrade. The loop body is the same function either way, so a
   * node without a host loses its storage boundary and keeps its tools, its
   * transcript, its home and its credential — which is exactly what every node
   * had before this seam existed. A throw here would have made the CLI worse at
   * running searches in exchange for nothing.
   */
  nodeHost?: () => NodeLoopHost;
  /**
   * The three host-owned things a node's private home needs, as a factory
   * returning a promise — see `AgentsForkDeps.nodeHome`. *Isolation*.
   *
   * LOCAL-ONLY, and declared as such in `scripts/capability-parity.lock.json`
   * rather than left as an accident. It is the exact mirror of `nodeHost` above:
   * that one is a Durable Object facet and the CLI has no facet API to reach,
   * this one is a uid-0 view of an in-isolate filesystem and the hosted backend
   * reaches its workspace by RPC — a filesystem call with no pid acts as the
   * session user, and `confinePrincipal` is a method on `SqliteVFS` with no RPC
   * form. Two of the three members do not exist on that side of the boundary.
   *
   * Wired by the CLI from `WorkspaceBundle.privileged()`, which holds the uid-0
   * view and the principal registry, plus the workspace's own `SqlDatabase` for
   * the uid allocation.
   *
   * Absent is not a degrade so much as a different graded run: a node with no
   * home keeps its tools, its transcript and its credential, reports
   * `shared-origin-plane`, and is graded on what it REPORTS — which is what
   * every node did before this seam had a caller.
   */
  nodeHome?: () => Promise<NodeHomeHost>;
  /**
   * The shared-prefix compaction ladder for *Inherited context* — the real
   * better-compact path (packages/compaction), which core only names as a seam. Absent
   * leaves `SwarmRunDeps.compactShared` absent: a parent past its window inherits
   * verbatim until the provider refuses, the seam's documented loud failure.
   */
  compactShared?: AgentsForkDeps['compactShared'];
}

export function buildStrategyForkDeps(wiring: ForkDepsWiring): AgentsForkDeps {
  return {
    rt: wiring.rt,
    model: wiring.model,
    costModel: wiring.costModel,
    nodeHost: wiring.nodeHost,
    nodeHome: wiring.nodeHome,
    compactShared: wiring.compactShared,
  };
}
