import type { LanguageModel, ToolSet } from 'ai';
import { spyOn } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { EventLog } from '../src/events/hub/log';
import type { SpendGate } from '../src/mission-budget';
import { ChatSession, type ChatSessionPorts, type SessionEvent } from '../src/orchestrator/chat-session';
import { initPendingSendTables, PendingSendStore } from '../src/orchestrator/inbox';
import { initTerminalEffectTable } from '../src/orchestrator/terminal-effects';
import { TerminalTransitions } from '../src/orchestrator/terminal-transition';
import { assembleActorTurn } from '../src/orchestrator/turn-assembly';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import type { AgentTracing } from '../src/obs/agent-tracing';
import type { RunTurnSources } from '../src/orchestrator/turn-assembly';
import type { HostedActor } from '../src/state/actor-host';
import type { CacheWarming, CacheWarmingLane } from '../src/providers/cache-warming';
import { fixtureCompaction, fixtureRunSources, hostedSeatsOver } from './helpers-actor-host';
import { makeSqlExec } from './helpers';

export async function sessionFixture(input: {
  readonly model: LanguageModel;
  readonly tools?: ToolSet;
  readonly budget?: SpendGate;
  readonly tracing?: AgentTracing;
  readonly actorId?: ReturnType<typeof crypto.randomUUID>;
  readonly main?: boolean;
  /** Ports a case answers itself, in place of the fixture's. */
  readonly ports?: Partial<Pick<ChatSessionPorts, 'prepareTurn' | 'owedTerminalEffects' | 'armTurnWake' | 'runs'>>;
  /** Wraps the fixture's own preparation, for a case that fails or holds some turns' and prepares the rest. */
  readonly aroundPrepare?: (prepare: ChatSessionPorts['prepareTurn']) => ChatSessionPorts['prepareTurn'];
  /** The models and catalog a case's turns are assembled from, in place of the fixture's one model. */
  readonly sources?: Partial<Pick<RunTurnSources, 'models' | 'profileInputs'>>;
  readonly cacheWarming?: (actor: HostedActor) => CacheWarmingLane;
  /** Hears each event as the session's room does, the moment it is sent. */
  readonly onEvent?: (event: SessionEvent) => void;
  /** Wraps the session's commits, for a case that refuses one as its storage would. */
  readonly aroundCommit?: (commit: <T>(body: () => T) => T) => <T>(body: () => T) => T;
}) {
  const { rt, testSql } = createTestRuntime();
  const db = testSql.db;
  const seats = hostedSeatsOver({ rt, db, tracing: input.tracing, model: () => input.model });
  const minted = input.actorId === undefined ? null : spyOn(crypto, 'randomUUID').mockReturnValueOnce(input.actorId);

  const actor = await (async () => {
    try {
      if (input.main) return await seats.host.acquire({
        actorId: rt.actor.actorId, workspaceId: rt.actor.workspaceId, parentActorId: null,
      }, { kind: 'actor' });

      return (await seats.seat('tester', 'agent')).actor;
    } finally { minted?.mockRestore(); }
  })();

  const tools = input.tools ?? {};
  const sessionKey = actor.handle.actorId;
  const events: SessionEvent[] = [];
  const eventLog = new EventLog(makeSqlExec(db), actor.handle);
  const committed = <T>(body: () => T): T => db.transaction(body)();
  const transaction = input.aroundCommit?.(committed) ?? committed;

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
    ...input.sources,
  };

  const chat = new ChatSession({
    actorSession: actor.session,
    sessionId: sessionKey,
    transcript: actor.stores.history.transcript(CHAT_SESSION_ID),
    pendingSends: new PendingSendStore(rt.storage.sql, actor.handle.actorId),
    eventLog,
    eventRecorder: actor.stores.eventRecorder,
    compactionState: fixtureCompaction(sessionKey).state,
    transaction,
    transport: { deliver: (event) => { events.push(event); input.onEvent?.(event); } },
    mintAnswerId: () => crypto.randomUUID(),
    ports: {
      prepareTurn: (input.aroundPrepare ?? ((own) => own))(async (item, _lease, _opening, round) => {
        const assembled = await assembleActorTurn({
          ...sources,
          settle: (profile, authority) => { round.bind(profile, authority); },
        }, { userText: item.text, workMode: actor.session.workMode, ...(round.frozen !== null && { frozen: round.frozen }) });

        return {
          execution: assembled.execution,
          sessionKey, contextWindow: assembled.window.contextWindow,
          historyLength: actor.session.history.length,
        };
      }),
      composeRequest: async () => {
        const assembled = await assembleActorTurn(sources, { userText: '', workMode: 'build' });

        return { execution: assembled.execution, profile: assembled.profile, sessionKey };
      },
      owedTerminalEffects: () => [], terminal: () => terminal,
      driverGate: () => null,
      openWork: async () => ({ tasks: actor.stores.taskList.listOpen(), asyncWakePending: false }),
      steerSkills: async () => null, stillOwed: () => true,
      ...(input.cacheWarming !== undefined && { cacheWarming: warmingOver(input.cacheWarming(actor)) }),
      ...input.ports,
    },
  });

  return {
    chat, actor, events, seats, eventLog,
    close: () => { chat.close(); seats.host.releaseAll(); testSql.close(); },
  };
}

/** A lane in this process, as the session asks it: its answers are at hand. */
function warmingOver(lane: CacheWarmingLane): CacheWarming {
  return {
    noteRequest: async (lastRequestAt) => lane.noteRequest(lastRequestAt),
    armAfterTurn: async (input) => lane.armAfterTurn(input),
  };
}
