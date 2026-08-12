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
    /**
     * A FACTORY, resolved fresh at dispatch time (defaultOptions runs once
     * per fork call, before any detach decision) rather than a plain
     * function — so the backend can capture whatever run-scope is valid AT
     * DISPATCH into the returned closure.
     *
     * This matters because a fork now detaches the instant its spawn is
     * confirmed (the interactive surface's spawn-on-start policy): the
     * CALLING turn can close its own run — nulling the backend's live
     * "current run" pointer — well before the detached exploration reaches
     * its 'split' phase, and always before it reaches 'merge' (which only
     * fires once the whole exploration is done). A plain `onPhase` read the
     * pointer fresh at EACH phase, so 'merge' silently landed nowhere once
     * the pointer had moved on — the fork's cost and result vanished from the
     * durable run-event ledger for every detached fork, not just slow ones.
     * Binding the run id once, at dispatch, makes every phase of ONE fork
     * call land on the SAME run regardless of how long it takes to settle.
     */
    onPhase: () => (event: SplitPhaseEvent) => void;
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
        onPhase: wiring.heads.onPhase(),
        onComplete: wiring.heads.onComplete,
      },
    }),
  };
}
