/**
 * An actor's tool surface: `buildBuiltinTools` plus the `agents` delegation tool.
 * `agents` lives here, not in that factory, because registering it there closes a runtime import cycle.
 */

import type { ToolSet } from 'ai';
import { buildToolSurface, type BuiltinToolDeps, type CodemodeBuilder } from '../tools/builtins';
import { createAgentsTool, type AgentsToolDeps } from './agents-tool';
import { withEffectClaims, type EffectClaimDeps } from '../tools/effect-claim';

// Not `ActorToolDeps`: cf-backend's actor-agent.ts already owns that name.
export interface ActorToolsetDeps extends BuiltinToolDeps {
  /** Deps for `agents`; registered when any group is wired, actions gate per group. */
  agents?: AgentsToolDeps;
  /** Durable once-only boundary for tools whose effects leave the process. */
  effectClaims: EffectClaimDeps;
  /** Builds `eval` over the finished surface (builtins plus `agents`); runs before the effect-claim wrap. */
  codemode?: CodemodeBuilder;
}

/** Every builtin, plus `agents` when any delegation group is wired, each behind its replay policy (tools/effect-claim.ts). */
export function buildActorTools(deps: ActorToolsetDeps): ToolSet {
  let extra: ToolSet | undefined;

  if (deps.agents && (deps.agents.swarm || deps.agents.team || deps.agents.peers)) {
    extra = { agents: createAgentsTool(deps.agents) };
  }

  return withEffectClaims(buildToolSurface({ ...deps, extra }), deps.effectClaims);
}

export {
  PEER_REPLY_TOPIC,
  type AgentsToolDeps, type AgentsSwarmDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './agents-tool';
