import type { LanguageModel, ToolSet } from 'ai';
import { spyOn } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { EventLog } from '../src/events/hub/log';
import type { SpendGate } from '../src/mission-budget';
import { ChatSession, type SessionEvent } from '../src/orchestrator/chat-session';
import { initPendingSendTables, PendingSendStore } from '../src/orchestrator/inbox';
import { initTerminalEffectTable } from '../src/orchestrator/terminal-effects';
import { TerminalTransitions } from '../src/orchestrator/terminal-transition';
import { assembleActorTurn } from '../src/orchestrator/turn-assembly';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import type { AgentTracing } from '../src/obs/agent-tracing';
import { fixtureCompaction, fixtureRunSources, hostedSeatsOver } from './helpers-actor-host';
import { makeSqlExec } from './helpers';

export async function sessionFixture(input: {
  readonly model: LanguageModel;
  readonly tools?: ToolSet;
  readonly budget?: SpendGate;
  readonly tracing?: AgentTracing;
  readonly actorId?: ReturnType<typeof crypto.randomUUID>;
  readonly main?: boolean;
}) {
  const { rt, testSql } = createTestRuntime();
  const db = testSql.db;
  const seats = hostedSeatsOver({ rt, db, tracing: input.tracing, model: () => input.model });
  const minted = input.actorId === undefined ? null : spyOn(crypto, 'randomUUID').mockReturnValueOnce(input.actorId);

  const actor = await (async () => {
    try {
      if (input.main) return await seats.host.acquire({
        actorId: rt.actor.actorId, workspaceId: rt.actor.workspaceId, parentActorId: null,
      });

      return (await seats.seat('tester', 'agent')).actor;
    } finally { minted?.mockRestore(); }
  })();

  const tools = input.tools ?? {};
  const sessionKey = actor.handle.actorId;
  const events: SessionEvent[] = [];
  const transaction = <T>(body: () => T): T => db.transaction(body)();

  initPendingSendTables(rt.storage.execRaw);
  initTerminalEffectTable(rt.storage.execRaw);

  const terminal = new TerminalTransitions({
    sql: rt.storage.sql, actor: actor.handle, effects: {}, now: Date.now, transaction,
    turnIsLive: () => actor.session.inFlight,
    scheduleRetry: async () => {}, settled: async () => {}, hold: (close) => close(),
  });

  const sources = {
    ...fixtureRunSources(actor, () => input.model),
    ...(input.budget !== undefined && { budget: input.budget }),
    toolset: () => tools,
    externalTools: async () => ({}),
    wiredToolNames: () => Object.keys(tools),
    codemodeCapabilities: () => [],
  };

  const chat = new ChatSession({
    actorSession: actor.session,
    sessionId: sessionKey,
    transcript: actor.stores.history.transcript(CHAT_SESSION_ID),
    pendingSends: new PendingSendStore(rt.storage.sql, actor.handle.actorId),
    eventLog: new EventLog(makeSqlExec(db), actor.handle),
    eventRecorder: actor.stores.eventRecorder,
    compactionState: fixtureCompaction(sessionKey).state,
    transaction,
    transport: { deliver: (event) => { events.push(event); } },
    mintAnswerId: () => crypto.randomUUID(),
    ports: {
      prepareTurn: async (item, lease) => {
        const assembled = await assembleActorTurn({
          ...sources,
          settle: (profile, authority) => actor.session.bindProfile(lease, profile, authority),
        }, { userText: item.text, workMode: actor.session.workMode });

        return {
          execution: assembled.execution,
          sessionKey, contextWindow: assembled.window.contextWindow,
          historyLength: actor.session.history.length,
        };
      },
      composeRequest: async () => {
        const assembled = await assembleActorTurn(sources, { userText: '', workMode: 'build' });

        return { execution: assembled.execution, profile: assembled.profile, sessionKey };
      },
      owedTerminalEffects: () => [], terminal: () => terminal,
      driverGate: () => null, armTurnWake: async () => {},
      taskList: () => actor.stores.taskList, hasPendingAsyncWake: () => false,
      steerSkills: async () => null, stillOwed: () => true,
    },
  });

  return {
    chat, actor, events, seats,
    close: () => { chat.close(); seats.host.releaseAll(); testSql.close(); },
  };
}
