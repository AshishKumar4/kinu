/**
 * An ACTOR's tool surface: `buildBuiltinTools` plus the one tool that factory
 * cannot hold — `agents`, the delegation tool.
 *
 * The split is a layering fact, not a preference. `agents`' implementation IS
 * the search engine: tools/agents-tool.ts → strategy/swarm-run.ts →
 * strategy/node-agent.ts, and a node's own tool surface comes back out of
 * `buildBuiltinTools`. Registering the tool inside that factory therefore closed
 * a four-module runtime import cycle, and a value cycle is not a style
 * complaint: the module-scope reader at the far end of the equivalent ring
 * through heads/head-tools.ts hit the temporal dead zone, which made a test FILE
 * fail to load and its six tests disappear from the count rather than fail.
 *
 * Nothing was made lazy to hide that. Instead the surface is composed in the one
 * place where the ordering is unambiguous, and the confined surfaces stay below
 * it: `HEAD_BUILTIN_TOOLS` never contained `agents` (heads/types.ts), so a head
 * or a swarm node linking the delegation tool only to filter it back out was
 * paying for a dependency it is defined not to have.
 *
 * One composition step per surface, and no second definition of any tool: this
 * is the SAME `buildBuiltinTools` output, with one more entry.
 */

import type { ToolSet } from 'ai';
import { buildBuiltinTools, type BuiltinToolDeps } from './builtins';
import { createAgentsTool, type AgentsToolDeps } from './agents-tool';

// Named for the toolset rather than the actor because cf-backend's actor-agent.ts
// already owns an `ActorToolDeps` — the actor PROFILE's deps (team / peers /
// report / submitPlan), which is what feeds `agents` below, not this factory.
export interface ActorToolsetDeps extends BuiltinToolDeps {
  /** The `agents` delegation tool's deps: fork substrate (StrategyRegistry +
   *  model + host-injected infra) and/or subordinate + peer transports. The
   *  tool is registered when ANY group is wired; actions gate per group. */
  agents?: AgentsToolDeps;
}

/**
 * The builtin surface an actor is given: every tool `buildBuiltinTools` emits,
 * plus `agents` when this actor's deps wire any delegation group. Per-action
 * gating (fork / team / peers) lives in `createAgentsTool`, so an actor with
 * only `team` sees hire/ask/send and no swarm.
 */
export function buildActorTools(deps: ActorToolsetDeps): ToolSet {
  const tools = buildBuiltinTools(deps);
  if (deps.agents && (deps.agents.fork || deps.agents.team || deps.agents.peers)) {
    tools.agents = createAgentsTool(deps.agents);
  }
  return tools;
}

// The delegation deps contracts (and the reserved peer-reply topic) live with
// the tool that consumes them — tools/agents-tool.ts — and are re-exported here
// for the backends that implement them, beside the factory that registers it.
export {
  PEER_REPLY_TOPIC,
  type AgentsToolDeps, type AgentsForkDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './agents-tool';
