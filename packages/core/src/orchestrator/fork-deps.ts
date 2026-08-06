/**
 * The `agents` tool's fork substrate, fully wired — single-shot + MCTS +
 * branching heads over one strategy registry, with the host-injected
 * infrastructure the LLM must not set. Both backends previously built this
 * identically: the same three registrations and the same defaultOptions
 * closure shape (MCTS gets a fresh SessionWriter + the operator's stored
 * overrides — an explicit LLM budget still wins; heads get the controller,
 * the live conversation as inheritedContext, and the phase/complete sinks).
 * The team/peer halves of AgentsToolDeps stay on each backend's profile.
 */

import type { LanguageModel } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import { createStrategyRegistry } from '../strategy/types.js';
import { createSingleShotStrategy } from '../strategy/single-shot.js';
import { createMCTSStrategy } from '../strategy/mcts.js';
import { createHeadsStrategy } from '../strategy/heads.js';
import type { AgentsForkDeps } from '../tools/agents-tool.js';
import type { SessionWriter } from '../mcts/record-node.js';
import type { MctsSearchStore } from '../mcts/search-store.js';
import type { HeadController, SplitPhaseEvent } from '../heads/controller.js';
import type { MergeResult, SerializedMessage } from '../heads/types.js';
import type { MctsOverrides } from '../config/store.js';

export interface ForkDepsWiring {
  rt: AgentRuntime;
  model: LanguageModel;
  mcts: {
    /** Fresh per fork call — a search must not share another's tree. */
    session: () => SessionWriter;
    search: MctsSearchStore;
    /** The operator's stored overrides (mcts_c / iterations / depth /
     *  branches), read per call so config changes land without a rebuild. */
    overrides: () => MctsOverrides;
  };
  heads: {
    /** Resolved per call (cf: throws until the agent has an owner). */
    controller: () => HeadController;
    inheritedContext: () => SerializedMessage[];
    onPhase: (event: SplitPhaseEvent) => void;
    onComplete: (merge: MergeResult, task: string) => void;
  };
}

export function buildStrategyForkDeps(wiring: ForkDepsWiring): AgentsForkDeps {
  const registry = createStrategyRegistry();
  registry.register(createSingleShotStrategy());
  registry.register(createMCTSStrategy());
  registry.register(createHeadsStrategy());
  return {
    registry,
    rt: wiring.rt,
    model: wiring.model,
    defaultOptions: () => ({
      mcts: { session: wiring.mcts.session(), search: wiring.mcts.search, ...wiring.mcts.overrides() },
      heads: {
        controller: wiring.heads.controller(),
        inheritedContext: wiring.heads.inheritedContext(),
        onPhase: wiring.heads.onPhase,
        onComplete: wiring.heads.onComplete,
      },
    }),
  };
}
