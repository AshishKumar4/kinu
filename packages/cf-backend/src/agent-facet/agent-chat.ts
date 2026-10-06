/** A non-main agent's chat in its own isolate (D9). */
import {
  CHAT_SESSION_ID, ChatSession, EventLog, HeadCapture, PendingSendStore, TerminalTransitions,
  assembleActorTurn, chatTerminalEffects, chatTurnParts, declareTerminalRoster, planHandoffStillOwed, projectJsonValue,
  metadataTier, subordinateTerminalEffects, withCompactionTrigger,
  type ActorTurnLease, type ChatTurnInput, type ComposedRequest, type HostedActor, type OwedEffect, type OwedTerminalEffectsInput,
  type PreparedAgentTurn, type PreparedTurn, type TerminalTransition, type TerminalTurnFacts, type TerminalTurnParts,
  type ProviderEnv, type SessionEvent, type TurnAssemblyRequest, type WorkMode,
} from '@kinu.run/core';
import { createCompactionStateStore, type CompactionStateStore } from '@kinu.run/compaction';
import { attempt, diagnostics, hold, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { AgentDatabase } from './agent-database';
import { FacetSpend, facetTurnSources, facetTurnTools, type AgentWorkspace, type LiveTurn } from './agent-turn';

/** The words reach the room on the turn's own stream. */
const ROOM_EVENTS: ReadonlySet<SessionEvent['type']> = new Set(['turn-start', 'turn-end', 'step-cut', 'error', 'broadcast', 'history-reverted']);

export interface FacetChatDeps {
  readonly actor: HostedActor;
  readonly database: AgentDatabase;
  readonly workspace: AgentWorkspace;
  readonly providers: ProviderEnv;
  readonly storage: DurableObjectStorage;
}

export class FacetChat {
  readonly session: ChatSession;

  private readonly trigger: { readonly state: CompactionStateStore; readonly key: string };

  private readonly spend: FacetSpend;

  private read: PreparedAgentTurn | null = null;

  private activeSkills: readonly string[] = [];

  private terminalTransitions: TerminalTransitions | null = null;

  private readonly closing = new Set<Promise<unknown>>();

  constructor(private readonly deps: FacetChatDeps) {
    const { actor, storage, workspace } = deps;
    const sql = actor.runtime.storage.sql;

    this.trigger = { state: createCompactionStateStore(sql, actor.handle), key: actor.record.actorId };
    this.spend = new FacetSpend(workspace);

    this.session = new ChatSession({
      actorSession: actor.session,
      sessionId: CHAT_SESSION_ID,
      transcript: actor.stores.history.transcript(CHAT_SESSION_ID),
      pendingSends: new PendingSendStore(sql, actor.handle.actorId),
      eventLog: new EventLog({ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings) }, actor.handle),
      eventRecorder: actor.stores.eventRecorder,
      compactionState: this.trigger.state,
      transaction: (body) => storage.transactionSync(body),
      transport: { deliver: (event) => (ROOM_EVENTS.has(event.type) ? workspace.chatEvent(event) : undefined) },
      mintAnswerId: () => crypto.randomUUID(),
      ports: {
        prepareTurn: (item, lease) => this.prepareTurn(item, lease),
        composeRequest: () => this.composeRequest(),
        owedTerminalEffects: (input) => this.owedTerminalEffects(input),
        answerMetadata: async (turnId, texts) => await workspace.answerMetadata(turnId, await texts()),
        owedReport: async (ending, assistantText, narration) => await workspace.owedReport(this.session.currentTurnId ?? '', ending, assistantText, await narration()),
        terminal: () => this.terminal,
        holdTerminalClose: (transition, close) => { this.holdTerminalClose(transition, close); },
        driverGate: () => null,
        armTurnWake: (atMs) => workspace.armWake(atMs),
        taskList: () => actor.stores.taskList,
        // Its jobs run in the workspace, whose settle wakes it.
        hasPendingAsyncWake: () => false,
        steerSkills: (text) => workspace.steerSkills(text, this.activeSkills),
        stillOwed: (metadata) => planHandoffStillOwed(metadata, actor.stores.planReviews),
        birthContext: (drainTurnId) => workspace.birthContext(drainTurnId),
      },
    });
  }

  private async assemble(prepared: PreparedAgentTurn, turn: { readonly id: string; readonly mode: WorkMode; readonly runId: string }, asked: TurnAssemblyRequest, bind?: Parameters<typeof assembleActorTurn>[0]['settle']) {
    const { actor, database, workspace, providers } = this.deps;
    const live: LiveTurn = { dynamic: prepared.dynamic };

    this.read = prepared;

    const tools = facetTurnTools(workspace, prepared, actor, { id: turn.id, mode: turn.mode, live, capture: new HeadCapture(), database });
    const { sources: bundle } = facetTurnSources({ actor, workspace, providers, prepared, spend: this.spend, live, runId: turn.runId, turnId: turn.id });

    return await assembleActorTurn({
      ...bundle,
      toolset: () => tools,
      externalTools: async () => ({}),
      ...(bind !== undefined && { settle: bind }),
    }, asked);
  }

  private async prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn> {
    const { actor, database, workspace } = this.deps;
    const mode = actor.session.workMode;
    const prepared = await workspace.prepareChat({ turnId: lease.turnId, mode, userText: item.text, parentDriven: item.kind === 'programmatic' });

    database.prepare(lease.turnId, prepared);

    const assembled = await this.assemble(prepared, { id: lease.turnId, mode, runId: lease.runId }, request(item, mode), (profile, inputs) => {
      actor.session.bindProfile(lease, profile, inputs);
    });

    this.activeSkills = assembled.activeSkills?.active.map((skill) => skill.name) ?? [];
    const historyLength = actor.session.history.length;
    const { key, state } = this.trigger;

    return {
      execution: withCompactionTrigger(assembled.execution, state, key, historyLength),
      sessionKey: key, contextWindow: assembled.window.contextWindow, historyLength,
    };
  }

  private async composeRequest(): Promise<ComposedRequest> {
    const mode = this.deps.actor.session.workMode;
    const prepared = await this.deps.workspace.prepareChat({ turnId: null, mode, userText: '', parentDriven: false });
    const assembled = await this.assemble(prepared, { id: 'measure', mode, runId: prepared.runId }, { userText: '', workMode: mode });

    return { execution: assembled.execution, profile: assembled.profile, sessionKey: this.trigger.key };
  }

  /** As a CLI hire's: never sleep-time. */
  private owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] {
    const { session } = this.deps.actor;
    const scoped = session.orchestrator.scopedTurn(input.turn);

    const facts: TerminalTurnFacts = {
      messageId: input.messageId,
      status: input.status,
      workMode: session.workMode,
      continuity: 'conversation',
      completed: input.completed,
      userText: input.userText,
      assistantText: input.assistantText,
      scopedTurn: projectJsonValue({ value: scoped }),
      recordedAt: Date.now(),
      // Its lanes run in the workspace; this isolate's engine records nothing.
      evolutionEnabled: false,
    };

    const report = input.owedReport;

    const parts: TerminalTurnParts = {
      ...chatTurnParts(input),
      autoTitle: { mission: null },
      sleepTime: false,
      ...(this.read?.reviewsTurns === true && { advisor: projectJsonValue({ value: session.advisorSnapshot(scoped, input.reachableTools) }) }),
      ...(report !== null && {
        parentReport: {
          text: report.content,
          status: report.status,
          sequenceId: `${this.deps.actor.record.actorId}:turn-end:${input.messageId}`,
          ...(report.quiet === true && { quiet: true as const }),
        },
      }),
    };

    return declareTerminalRoster(facts, parts);
  }

  private get terminal(): TerminalTransitions {
    const { actor, storage, workspace } = this.deps;

    this.terminalTransitions ??= new TerminalTransitions({
      sql: actor.runtime.storage.sql,
      actor: actor.handle,
      effects: {
        ...chatTerminalEffects({ chat: () => this.session, orchestrator: actor.session.orchestrator, engine: { learnFromTurn: async () => {} } }),
        ...subordinateTerminalEffects({
          orchestrator: actor.session.orchestrator,
          hireAdvisor: (advisor) => workspace.hireAdvisor(advisor),
          applyTitle: (subject) => workspace.autoTitle(subject),
          sendReport: (report) => workspace.parentReport(report),
        }),
      },
      now: () => Date.now(),
      transaction: (body) => storage.transactionSync(body),
      turnIsLive: (turnId) => this.session.pumping && this.session.currentTurnId === turnId,
      scheduleRetry: (atMs) => workspace.armWake(atMs),
      settled: async () => {},
    });

    return this.terminalTransitions;
  }

  /** An eviction leaves the effects owed; the workspace's wake re-drives them. */
  private holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void {
    const closing: Promise<unknown> = hold(attempt({ doing: "closing an agent's settled turn", otherwise: 'io' }, close).pipe(
      Effect.catch((failure) => Effect.promise(() => this.terminal.closeFailed(transition, { cause: failure }))),
      Effect.ensuring(Effect.sync(() => { this.closing.delete(closing); })),
    ));

    this.closing.add(closing);
  }

  async idle(): Promise<void> {
    while (this.session.pumpPromise !== null || this.closing.size > 0) {
      await this.session.pumpPromise;
      await Promise.allSettled(this.closing);
    }

    await this.spend.settled();
  }

  wake(): Promise<void> {
    return settle(attempt({ doing: "resuming what an agent's isolate owed", otherwise: 'unavailable' }, async () => {
      this.session.reclaimStrandedEventDeliveries();
      await this.terminal.releaseParked();
      await this.terminal.resumeAll((transition, close) => { this.holdTerminalClose(transition, close); });
      await this.session.flushPendingDrains();
    }).pipe(
      Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('agent.wake_failed', failure); })),
      Effect.ensuring(Effect.sync(() => { this.session.pump(); })),
    ));
  }
}

function request(item: ChatTurnInput, mode: WorkMode): TurnAssemblyRequest {
  const explicitTier = metadataTier(item.metadata);

  return { userText: item.text, workMode: mode, ...(explicitTier !== undefined && { explicitTier }) };
}
