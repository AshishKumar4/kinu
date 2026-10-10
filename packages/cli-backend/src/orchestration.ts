import { EvolutionEngine, historyTurnPairs, MissionGovernor, runEventSinks, type AgentOrchestratorDeps, type AgentRuntime, type AgentStores, type EventLog, type SessionHistory } from '@kinu.run/core';
import type { LocalAgentSession } from './local-session';

export interface LocalSessionOwner {
  read(): LocalAgentSession;
  turnInFlight(): boolean;
  closed(): boolean;
}

export interface LocalOrchestration {
  readonly deps: AgentOrchestratorDeps;
  readonly engine: EvolutionEngine;
  readonly budget: MissionGovernor;
  readonly eventLog: EventLog;
}

interface LocalOrchestrationInput {
  readonly runtime: AgentRuntime;
  readonly history: SessionHistory;
  readonly stores: AgentStores;
  readonly eventLog: EventLog;
  readonly session: LocalSessionOwner;
  readonly oneShot: boolean;
}

export function createLocalOrchestration(input: LocalOrchestrationInput): LocalOrchestration {
  const budget = new MissionGovernor({
    actor: input.runtime.actor, storage: input.runtime.storage,
    pricing: (spec) => input.session.read().modelPricing(spec),
    onExhausted: ({ error: _error, ...refusal }) => { input.session.read().reportBudgetRefusal(refusal); },
  });

  const engine = new EvolutionEngine(input.runtime, historyTurnPairs(input.history), { governor: budget });

  engine.onEvent((event) => { input.session.read().reportEvolutionEvent(event); });

  return {
    engine, budget, eventLog: input.eventLog,
    deps: {
      host: {
        broadcast: (event) => { input.session.read().emit({ type: 'broadcast', event }); },
        enqueueTurn: (turn) => input.session.read().enqueueTurn(turn),
        turnInFlight: () => input.session.turnInFlight(),
        closed: () => input.session.closed(),
        setTimer: (fn, ms) => { input.session.read().setTimer(fn, ms); },
        reconcileDurableWake: null,
      },
      engine, eventLog: input.eventLog, budget, oneShot: input.oneShot,
      refinementLane: () => input.session.read().runRefinementLane(),
      sinks: runEventSinks({ stores: input.stores }, (event, detail) => input.session.read().logActivity(event, detail)),
    },
  };
}
