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
import type { AgentRuntime } from '../types/agent-runtime';
import { createStrategyRegistry } from '../strategy/types';
import { createSingleShotStrategy } from '../strategy/single-shot';
import { createMCTSStrategy } from '../strategy/mcts';
import { createHeadsStrategy } from '../strategy/heads';
import type { AgentsForkDeps } from '../tools/agents-tool';
import type { SessionWriter } from '../mcts/record-node';
import type { MctsSearchStore } from '../mcts/search-store';
import type { CostModel } from '../mcts/cost';
import type { MCTSProgressEvent } from '../types/mcts';
import type { HeadController, SplitPhaseEvent } from '../heads/controller';
import type { MergeResult, SerializedMessage } from '../heads/types';
import type { MctsOverrides } from '../config/store';

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
  mcts: {
    /** Fresh per fork call — a search must not share another's tree. */
    session: () => SessionWriter;
    search: MctsSearchStore;
    /** The operator's stored overrides (mcts_c / iterations / depth /
     *  branches), read per call so config changes land without a rebuild. */
    overrides: () => MctsOverrides;
    /**
     * Per-iteration progress sink — the MCTS twin of `heads.onPhase`, and a
     * FACTORY for the same reason: a fork detaches the instant its spawn is
     * confirmed, so whatever run-scope is valid at DISPATCH has to be bound
     * once, here, rather than read fresh at each event.
     *
     * Without it a search is invisible while it runs. Only the lifetime
     * evolution cycle ever passed `onProgress` into runMCTS, so an
     * agent-initiated search — every search an operator actually watches —
     * broadcast nothing at all, and the tree only moved when a surface
     * happened to poll. Optional: a backend with no live search surface (the
     * CLI, whose `mcts` command is a one-shot inspection) wires nothing.
     */
    onProgress?: () => (event: MCTSProgressEvent) => void;
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
    costModel: wiring.costModel,
    defaultOptions: () => {
      const mcts = {
        session: wiring.mcts.session(),
        search: wiring.mcts.search,
        ...wiring.mcts.overrides(),
      };
      const onProgress = wiring.mcts.onProgress?.();
      if (onProgress) Object.assign(mcts, { onProgress });
      return {
        mcts,
        heads: {
          controller: wiring.heads.controller(),
          inheritedContext: wiring.heads.inheritedContext(),
          onPhase: wiring.heads.onPhase(),
          onComplete: wiring.heads.onComplete,
        },
      };
    },
  };
}
