import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** An agent's own SQLite, under the core stores; its roster rows are copies the workspace sends on each call. */
import type { ModelMessage, UIMessage } from 'ai';
import {
  CHAT_SESSION_ID, EventLog, EvolutionEngine, WorkspaceActorDirectory, runEventSinks, historyTurnPairs, conversationTurnPair, type ConversationTurnPair,
  actorReferenceOf, actorScaffoldPath, createActorHost, createScaffoldSurface, defaultLoopOrigin,
  initWorkspaceSchema, nimbusSessionFiles, recoverActorTurns, MissionGovernor, actorReadHandle, readSessionTranscript, readSubordinateInspection,
  getChatHistoryPage, inheritedContextFromTranscript, turnRequestIndex, turnRequestPage,
  type TurnRequestIndex, type TurnRequestPage, ConversationSearchStore, RunEventRecorder, spendLedger, type SpendLedger, type StepSpendSource,
  readAgentFigures, NO_FIGURES, type AgentFigures,
  localContextTree, type ContextEditor, type ContextTree, type ConversationRecall,
  type ActorHandle, type AgentOwnInspection, type ChatHistoryPage, type PositionPageRequest, type SerializedMessage,
  type SessionTranscriptReader, type SubordinateInspectionResult, type SubordinateReportLedger, type ModelPricing, type SqlExecutor,
  type ActorHost, type ActorReference, type AgentRuntime, type BackendHost, type BoundActor, type HeadReport, type HostedActor,
  type Executor, type JsonObject, type NimbusSandboxHandle, type SqlValue, WORKSPACE_ROOT, cloudPlanes, answersForDrainTurns,
  initPendingSendTables, initTerminalEffectTable, PendingSendStore, contextFill, announcementOf, classifyRunEnd, closeTurnRun, TurnReports,
  PlanReviewStore, type PlanReview,
} from '@kinu.run/core';
import { attempt, detach, diagnostics, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { AgentAnswer, AgentAnswerTexts, AgentStanding, AgentSteps, AgentTurnActivity, ConversationProjection, AgentRecovery, AgentSnapshot, PreparedAgentTurn, StoredRow, TurnRequestAt } from '@kinu.run/core';
import type { AgentWorkspace } from './agent-turn';

const refused = (what: string) => Effect.fail(new KinuError('unsupported', `${what} runs in the workspace object, not in an agent's own isolate.`));

interface AgentRuntimeFiles {
  readonly agent: () => VFS;
  readonly state: () => VFS;
  readonly sql: SqlExecutor;
  readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
}

/** Each copied table's key. An upsert: a replace deletes the row first, cascading through the agent's rows. */
const COPIED_KEY = {
  workspace_identity: ['singleton'], workspace_actors: ['actor_id'], scaffold_versions: ['actor_id', 'version'], actor_config: ['actor_id', 'key'],
} as const;

function upsertRow(storage: DurableObjectStorage, table: keyof typeof COPIED_KEY, row: StoredRow): void {
  const columns = Object.keys(row);
  const values: SqlValue[] = columns.map((column) => row[column] ?? null);
  const key: readonly string[] = COPIED_KEY[table];
  const updates = columns.filter((column) => !key.includes(column)).map((column) => `${column} = excluded.${column}`);

  storage.sql.exec(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
    ...values,
  );
}

/** Whether this database holds `row` in `table` as it is, every column alike. */
function holds(storage: DurableObjectStorage, table: keyof typeof COPIED_KEY, row: StoredRow): boolean {
  const key: readonly string[] = COPIED_KEY[table];

  const [stored, ...more] = storage.sql.exec<StoredRow>(
    `SELECT * FROM ${table} WHERE ${key.map((column) => `${column} = ?`).join(' AND ')}`,
    ...key.map((column) => row[column] ?? null),
  ).toArray();

  return stored !== undefined && more.length === 0 && isDeepStrictEqual({ ...stored }, { ...row });
}

/** Whether this database holds exactly `config` for `actorId`, no row more or less. */
function holdsConfig(storage: DurableObjectStorage, actorId: SqlValue, config: readonly StoredRow[]): boolean {
  const stored = storage.sql.exec<StoredRow>('SELECT * FROM actor_config WHERE actor_id = ?', actorId).toArray();
  const wanted = config.filter((row) => row.actor_id === actorId);

  return stored.length === wanted.length && wanted.every((row) => holds(storage, 'actor_config', row));
}

interface AgentReadable {
  readonly actor: ActorHandle;
  readonly transcript: SessionTranscriptReader;
}

const IdentitySchema = v.object({
  actor: v.looseObject({ actor_id: v.string(), parent_actor_id: v.nullable(v.string()) }),
  workspace: v.looseObject({ id: v.string(), owner_user_id: v.nullable(v.string()) }),
});

export class AgentDatabase {
  private snapshot: AgentSnapshot | undefined;

  private host: ActorHost | undefined;

  private readonly stops = new Map<string, AbortController>();

  private lines: AgentTurnActivity[] = [];

  takeActivity(): AgentTurnActivity[] {
    const taken = this.lines;

    this.lines = [];

    return taken;
  }

  private priced: { readonly model: string; readonly pricing: ModelPricing | null } | null = null;
  private recall: ConversationRecall | null = null;
  private execution: Executor | null = null;

  private readonly sql: SqlExecutor = <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] =>
    this.storage.sql.exec<Extract<T, Record<string, SqlStorageValue>>>(query.join('?'), ...values).toArray();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly workspace: {
      readonly agent: () => NimbusSandboxHandle;
      readonly home: string;
      readonly state: () => NimbusSandboxHandle;
      readonly enqueueTurn: BackendHost['enqueueTurn'];
      readonly broadcast: BackendHost['broadcast'];
      readonly turnInFlight: () => boolean;
      readonly program: AgentWorkspace['program'];
      readonly memory: AgentWorkspace['memory'];
      readonly sayToParent: AgentWorkspace['sayToParent'];
    },
  ) {
    initWorkspaceSchema({
      execRaw: (ddl) => { storage.sql.exec(ddl); },
      sql: this.sql,
      transactionSync: (write) => storage.transactionSync(write),
      exec: { exec: (query, ...bindings) => storage.sql.exec(query, ...bindings) },
    });
    initPendingSendTables((ddl) => { storage.sql.exec(ddl); });
    initTerminalEffectTable((ddl) => { storage.sql.exec(ddl); });
  }

  /** Writes only when the workspace's rows changed, so a read of an unchanged agent writes nothing. */
  adopt(snapshot: AgentSnapshot): void {
    const unchanged = holds(this.storage, 'workspace_identity', snapshot.identity)
      && snapshot.lineage.every((row) => holds(this.storage, 'workspace_actors', row) && holdsConfig(this.storage, row.actor_id ?? null, snapshot.config))
      && snapshot.scaffold.every((row) => holds(this.storage, 'scaffold_versions', row));

    if (!unchanged) {
      this.storage.transactionSync(() => {
        upsertRow(this.storage, 'workspace_identity', snapshot.identity);

        for (const row of snapshot.lineage) {
          upsertRow(this.storage, 'workspace_actors', row);
          this.storage.sql.exec('DELETE FROM actor_config WHERE actor_id = ?', row.actor_id ?? null);
        }

        for (const row of snapshot.config) upsertRow(this.storage, 'actor_config', row);

        for (const row of snapshot.scaffold) this.selectScaffold(row);
      });
    }

    this.snapshot = snapshot;
  }

  private selectScaffold(row: StoredRow): void {
    this.storage.sql.exec("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND version != ? AND status = 'current'", row.actor_id ?? null, row.version ?? null);
    upsertRow(this.storage, 'scaffold_versions', row);
  }

  current(): AgentSnapshot {
    if (this.snapshot !== undefined) return this.snapshot;

    return settleSync(Effect.fail(new KinuError('missing', 'The agent was reached before its workspace sent its rows.')));
  }

  private identity(): v.InferOutput<typeof IdentitySchema> {
    const snapshot = this.current();

    return v.parse(IdentitySchema, { actor: snapshot.lineage.at(-1), workspace: snapshot.identity });
  }

  reference(): ActorReference {
    const { actor, workspace } = this.identity();

    return actorReferenceOf({ actorId: actor.actor_id, workspaceId: workspace.id, parentActorId: actor.parent_actor_id });
  }

  private actorHost(): ActorHost {
    this.host ??= this.buildHost();

    return this.host;
  }

  private buildHost(): ActorHost {
    const storage = this.storage;
    const snapshot = this.current();
    const { workspace } = this.identity();

    const directory = new WorkspaceActorDirectory(this.sql, {
      workspaceId: workspace.id,
      ownerUserId: workspace.owner_user_id,
    });

    const files: AgentRuntimeFiles = {
      agent: () => nimbusSessionFiles(this.workspace.agent(), { home: this.workspace.home }),
      state: () => nimbusSessionFiles(this.workspace.state(), { home: WORKSPACE_ROOT }),
      sql: this.sql,
      storage,
    };

    return createActorHost({
      storage: {
        sql: this.sql,
        transactionSync: (write) => storage.transactionSync(write),
        exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
      },
      directory,
      installedBuild: snapshot.installedBuild,
      workspace: snapshot.workspaceName,
      answered: (turn) => new TurnReports(this.sql).answered(turn),
      runtimeFor: (bound) => this.runtime(bound, files),
      filesFor: async () => ({ vfs: files.agent(), artifactDirectory: snapshot.artifactDirectory }),
      loopFor: (bound) => ({ origin: defaultLoopOrigin(bound.record.origin), parent: null }),
      orchestrationFor: (bound) => ({
        host: this.backendHost(),
        budget: new MissionGovernor({
          storage: bound.runtime.storage,
          actor: bound.handle,
          pricing: (spec) => (this.priced !== null && (spec === undefined || spec === this.priced.model) ? this.priced.pricing : null),
        }),
        sinks: runEventSinks(bound, (event, detail) => { this.lines.push(detail === undefined ? { event } : { event, detail }); }),
        engine: new EvolutionEngine(bound.runtime, historyTurnPairs(bound.stores.history), {
          enabled: false,
          transaction: (body) => { storage.transactionSync(body); },
        }),
        eventLog: new EventLog({ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings) }, bound.handle),
      }),
      contextEvents: () => null,
      sayToParent: (_child, signal) => this.workspace.sayToParent(signal),
      tracing: undefined,
    });
  }

  runtime(bound: BoundActor, files: AgentRuntimeFiles): AgentRuntime {
    const execution = () => this.execution;

    return {
      actor: bound.handle,
      agentStateVfs: files.state(),
      toolFiles: files.agent(),
      storage: {
        vfs: files.agent(),
        home: this.workspace.home,
        sql: files.sql,
        execRaw: (ddl) => { files.storage.sql.exec(ddl); },
        transactionSync: (write) => files.storage.transactionSync(write),
      },
      planes: cloudPlanes(this.workspace.home),
      memory: this.workspace.memory(),
      get executor() {
        const current = execution();

        if (current !== null) return current;

        return settleSync(Effect.fail(new KinuError('missing', "The agent's program ran before its turn was prepared.")));
      },
      get llm() { return settleSync(refused('The reflection model lane')); },
      get craftStore() { return settleSync(refused('Crafted tools')); },
      schedule: {
        after: () => settle(refused('A delayed schedule')),
        cron: () => settle(refused('A cron schedule')),
        fiber: async (_name, fn) => await fn({ stash: () => undefined, snapshot: null }),
      },
      identity: {
        id: bound.handle.actorId,
        name: bound.handle.name,
        scaffold: createScaffoldSurface({ vfs: files.state(), sql: files.sql, actor: bound.handle, path: actorScaffoldPath(bound.record) }),
      },
    };
  }

  backendHost(): BackendHost {
    return {
      broadcast: (event) => { this.workspace.broadcast(event); },
      enqueueTurn: (input) => this.workspace.enqueueTurn(input),
      turnInFlight: () => this.workspace.turnInFlight(),
      closed: () => false,
      setTimer: (fn, ms) => {
        setTimeout(() => detach(attempt({ doing: "running an agent's debounced drain", otherwise: 'io' }, fn).pipe(
          Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('agent.timer_failed', failure); })),
        )), ms);
      },
      reconcileDurableWake: null,
    };
  }

  prepare(turnId: string, prepared: PreparedAgentTurn): void {
    this.priced = { model: prepared.sources.model, pricing: prepared.pricing };
    this.execution = { languages: prepared.languages, execute: (...args) => this.workspace.program(turnId, ...args) };
    this.storage.transactionSync(() => { this.selectScaffold(prepared.scaffold); });
  }

  async acquire(): Promise<HostedActor> {
    return await this.actorHost().acquire(this.reference());
  }

  private transcript() {
    return this.actorHost().bindStores(this.reference()).stores.history.transcript(CHAT_SESSION_ID);
  }

  readable(): AgentReadable {
    const record = this.actorHost().describe(this.reference().actorId);

    if (record === null) return settleSync(Effect.fail(new KinuError('missing', 'The agent is not in its own database.')));

    if (record.retiringAt === null && record.deletedAt === null) {
      const bound = this.actorHost().bindStores(this.reference());

      return { actor: bound.handle, transcript: bound.stores.history.transcript(CHAT_SESSION_ID) };
    }

    const actor = actorReadHandle(this.sql, record);

    return { actor, transcript: readSessionTranscript(this.sql, actor, CHAT_SESSION_ID, null) };
  }

  async inspect(request: AgentOwnInspection): Promise<SubordinateInspectionResult> {
    const { actor, transcript } = this.readable();

    return await readSubordinateInspection({
      sql: this.sql, raw: { exec: (query, ...bindings) => this.storage.sql.exec(query, ...bindings) }, actor, transcriptFor: () => transcript,
    }, request);
  }

  async historyPage(page: PositionPageRequest): Promise<ChatHistoryPage> {
    return await getChatHistoryPage(this.readable().transcript, page);
  }

  /** An answer's text parts and the mode its agent last ran in; null when the id names no answer of this agent's. */
  async answerTexts(messageId: string): Promise<AgentAnswerTexts | null> {
    const bound = this.actorHost().bindStores(this.reference());
    const answer = await bound.stores.history.transcript(CHAT_SESSION_ID).message(messageId);

    if (answer?.role !== 'assistant') return null;

    return {
      texts: answer.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
      workMode: bound.stores.claims.latestTurn()?.workMode ?? 'plan',
    };
  }

  /** One of its answers as its transcript holds it and as it reads; null when the id names none. */
  async answerOf(messageId: string): Promise<AgentAnswer | null> {
    const { transcript } = this.readable();
    const message = await transcript.message(messageId);
    const projected = message === null ? null : await transcript.project(messageId);

    return message === null || projected === null ? null : { message, content: projected.content };
  }

  /** A turn's request and response by its answer's id; null for an id that names none. */
  async turnPair(messageId: string): Promise<ConversationTurnPair | null> {
    return await conversationTurnPair(this.readable().transcript, messageId) ?? null;
  }

  /** Where its chat stands between turns; `contextWindow` is the catalog's for its model. */
  standing(contextWindow: number | null): AgentStanding {
    const { actor, transcript } = this.readable();
    const { eventRecorder } = this.actorHost().bindStores(this.reference()).stores;

    return {
      messageCount: transcript.count(),
      context: contextFill(eventRecorder.readContextMeasures(), contextWindow),
      latestRun: eventRecorder.latestRunHeader(),
      // A steer is a row bound to a turn; an unbound row is the chat's own send, already shown as a message.
      pendingSteers: new PendingSendStore(this.sql, actor.actorId).restore()
        .filter((row) => row.turnId !== null)
        .map((row) => ({ id: row.id, text: row.text, state: 'queued' as const, atStep: null })),
    };
  }

  /** Its runs, as the Runs panel, `/runs`, MCP and the CLI read a workspace's. */
  runs(): RunEventRecorder {
    return this.actorHost().bindStores(this.reference()).stores.eventRecorder;
  }

  /** Its newest `limit` model steps, newest first, and the newest the provider measured. */
  steps(limit: number): AgentSteps {
    const { eventRecorder } = this.actorHost().bindStores(this.reference()).stores;

    return {
      steps: eventRecorder.readRecentByType('step_finish', limit).flatMap((event) => (event.type === 'step_finish' ? [event] : [])),
      newestMeasured: eventRecorder.newestMeasuredStep(),
    };
  }

  /** The metadata of its newest message from a person; null before any. */
  async lastUserMetadata(): Promise<JsonObject | null> {
    return await this.readable().transcript.lastUserMetadata() ?? null;
  }

  /** The answer each drain turn gave, for the replies its workspace owes on them. */
  async drainAnswers(drainTurnIds: readonly string[]): Promise<Readonly<Record<string, string>>> {
    return Object.fromEntries(await answersForDrainTurns(this.readable().transcript, drainTurnIds));
  }

  /** Its conversation's newest rows first, projected as a lane reads them. */
  async newestFirst(limit: number): Promise<readonly ConversationProjection[]> {
    return await this.readable().transcript.newestFirst(limit);
  }

  /** Its plans, newest first, read as its history is: a retained retired agent's too, and no chat is started. */
  planReviews(): readonly PlanReview[] {
    return new PlanReviewStore(this.sql, this.readable().actor).listPage(CHAT_SESSION_ID, { limit: 50 }).items;
  }

  activePlan(): PlanReview | null {
    return new PlanReviewStore(this.sql, this.readable().actor).getActive(CHAT_SESSION_ID);
  }

  messageCount(): number {
    return this.readable().transcript.count();
  }

  async workingContext(): Promise<readonly ModelMessage[]> {
    return (await this.acquire()).session.history;
  }

  conversations(): ConversationRecall {
    const reference = this.reference();

    this.recall ??= new ConversationSearchStore(this.sql, this.actorHost().bindStores(reference).handle,
      (sessionId) => this.actorHost().bindStores(reference).stores.history.transcript(sessionId));

    return this.recall;
  }

  contextTree(editor: ContextEditor): ContextTree {
    return localContextTree(() => ({ claims: this.actorHost().bindStores(this.reference()).stores.claims, events: null }), editor);
  }

  figures(): AgentFigures {
    const actorId = this.readable().actor.actorId;

    return readAgentFigures(this.sql, [actorId]).get(actorId) ?? NO_FIGURES;
  }

  spend(steps: readonly StepSpendSource[]): SpendLedger {
    return spendLedger(new RunEventRecorder(this.sql, this.readable().actor), steps);
  }

  turnRequests(turnId: string): TurnRequestIndex {
    return turnRequestIndex(this.actorHost().bindStores(this.reference()).stores, turnId);
  }

  async turnRequest(at: TurnRequestAt): Promise<TurnRequestPage> {
    return await turnRequestPage(this.actorHost().bindStores(this.reference()).stores, at);
  }

  async inheritedContext(): Promise<SerializedMessage[]> {
    return await inheritedContextFromTranscript(this.readable().transcript);
  }

  async recover(): Promise<AgentRecovery> {
    const host = this.actorHost();

    const recovered = await recoverActorTurns({
      installedBuild: host.installedBuild,
      workspace: this.current().workspaceName,
      // Its hirer holds the report that answers the turn: recovery settles it rather than running it again.
      answered: (turn) => new TurnReports(this.sql).answered(turn),
      resumable: (limit) => host.resumable(limit),
      acquire: async (reference) => {
        const actor = await host.acquire(reference);

        return { runtime: actor.runtime, stores: actor.stores, session: { get turnOpen() { return actor.session.turnOpen; } } };
      },
    });

    // A stalled turn's run is closed, so the agent's chat does not take it up a third time when it next opens.
    for (const turn of recovered.stalled) {
      const { eventRecorder } = (await host.acquire(turn.reference)).stores;
      const open = eventRecorder.openTurn();

      if (open?.turn.turnId !== turn.claim.turnId) continue;
      closeTurnRun(eventRecorder, open.runId, { turnIndex: 0, ...classifyRunEnd({ completed: false, interrupted: false, errorText: `stalled after ${String(turn.claim.epoch)} runs` }) });
    }

    // Named for the hirer's assignment row the turn answered, which its retirement dismisses.
    return {
      stalled: recovered.stalled.map((turn) => ({ turnId: announcementOf(turn.claim.turnId), runs: turn.claim.epoch, workMode: turn.claim.workMode })),
    };
  }

  async answer(completion: NonNullable<HeadReport['canonicalCompletion']>, metadata: JsonObject | null): Promise<void> {
    const transcript = this.transcript();

    if (transcript.newestId() === null) return;

    const entry = await transcript.prepareAssistant({
      id: crypto.randomUUID(), turnId: completion.turnId, runId: completion.runId, parts: completion.outputPartReferences,
      finalText: completion.finalTextReference, ...(metadata !== null && { metadata }),
    });

    this.storage.transactionSync(() => transcript.appendAssistant(entry));
  }

  async history(limit?: number): Promise<UIMessage[]> {
    return await this.readable().transcript.history(limit);
  }

  /** Or reserved and not yet written. */
  admitted(id: string): boolean {
    const { actor, transcript } = this.readable();

    return transcript.has(id) || new PendingSendStore(this.sql, actor.actorId).has(id);
  }

  /** What a turn has told its hirer, kept as its tools answered: only ever more. */
  recordReports(turnId: string, reports: SubordinateReportLedger): void {
    new TurnReports(this.sql).record({ actorId: this.readable().actor.actorId, turnId }, reports);
  }

  reports(turnId: string): SubordinateReportLedger {
    return new TurnReports(this.sql).read({ actorId: this.readable().actor.actorId, turnId });
  }

  interrupt(turnId: string): void {
    this.stop(turnId).abort();
  }

  stop(turnId: string): AbortController {
    const existing = this.stops.get(turnId);

    if (existing !== undefined) return existing;
    const created = new AbortController();

    this.stops.set(turnId, created);

    return created;
  }
}
