import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** An agent's own SQLite, under the core stores; its roster rows are copies the workspace sends on each call. */
import type { ModelMessage, UIMessage } from 'ai';
import {
  CHAT_SESSION_ID, EventLog, EvolutionEngine, WorkspaceActorDirectory, runEventSinks, historyTurnPairs, conversationTurnPair, type ConversationTurnPair,
  actorReferenceOf, actorScaffoldPath, createActorHost, createScaffoldSurface, defaultLoopOrigin,
  initAgentIsolateSchema, nimbusSessionFiles, recoverActorTurns, MissionGovernor, readSubordinateInspection,
  drawnStep, getChatHistoryPage, inheritedContextFromTranscript, turnRequestIndex, turnRequestPage,
  type TurnRequestIndex, type TurnRequestPage, RunEventRecorder, spendLedger, type SpendLedger, type StepSpendSource,
  readAgentFigures, NO_FIGURES, type AgentFigures,
  localContextTree, readableActor, type ReadableActor, type ContextEditor, type ContextTree, type ConversationRecall,
  type AgentOwnInspection, type ChatHistoryPage, type PositionPageRequest, type SerializedMessage,
  type SubordinateInspectionResult, type SubordinateReportLedger, type ModelPricing, type SqlExecutor,
  type ActorHost, type ActorReference, type AgentRuntime, type BackendHost, type BoundActor, type HeadReport, type HostedActor,
  type Executor, type JsonObject, type NimbusSandboxFiles, type SqlValue, WORKSPACE_ROOT, cloudPlanes, answersForDrainTurns,
  initPendingSendTables, initTerminalEffectTable, PendingSendStore, contextFill, announcementOf, TurnReports,
  PlanReviewStore, OwnerQuestionStore, AgentSequence, TurnFactsStore, type PlanReview, type TurnFacts,
  forkArtifactPath, localForkConversationSource, localForkConversationTarget, type ForkConversationSource, type ForkConversationTarget,
  InProcessDeliveries, type DeliveryAnswer, type OwedDelivery, holdConfig, holdRunHeads,
  writesSnapshotRows, HeldReads, type SqlExec,
} from '@kinu.run/core';
import { attempt, detach, diagnostics, hold, KinuError, logged, settle, settleSync } from '@kinu.run/core/obs';
import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { AgentAnswer, AgentAnswerTexts, AgentStanding, AgentStandingReport, AgentSteps, AgentTurnActivity, ConversationProjection, AgentRecovery, AgentSnapshot, PreparedAgentTurn, StoredRow, TurnRequestAt, FactsKey, FrozenAuthority } from '@kinu.run/core';
import type { AgentWorkspace, TurnBound } from './agent-turn';

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

const IdentitySchema = v.object({
  actor: v.looseObject({ actor_id: v.string(), parent_actor_id: v.nullable(v.string()) }),
  workspace: v.looseObject({ id: v.string(), owner_user_id: v.nullable(v.string()) }),
});

export class AgentDatabase {
  private snapshot: AgentSnapshot | undefined;

  private host: ActorHost | undefined;

  /** Its host's directory: rows an adoption replaces are read again there (`forget`). */
  private directory: WorkspaceActorDirectory | undefined;

  private lines: AgentTurnActivity[] = [];

  takeActivity(): AgentTurnActivity[] {
    const taken = this.lines;

    this.lines = [];

    return taken;
  }

  private relayed: Promise<unknown> = Promise.resolve();

  /** A line logged while a turn runs rides its next tool call or its end; one logged with no turn running reaches the
   *  workspace's log as it is logged, in order: an offer's yield, logged with no turn left to end, is never stranded. */
  private relayActivity(): void {
    if (this.workspace.turnInFlight()) return;
    this.relayed = this.relayed.then(() => hold(logged('agent.activity_relay_failed', { doing: "relaying an agent's activity to its workspace", otherwise: 'io' }, async () => {
      const lines = this.takeActivity();

      if (lines.length > 0) await this.workspace.logActivity(lines);
    })));
  }

  private priced: { readonly model: string; readonly pricing: ModelPricing | null } | null = null;
  private execution: Executor | null = null;

  /** Reads held between this database's statements: `sql` and `exec` drop them. Every write passes one of the two but
   *  DDL and {@link adopt}'s copied rows (identity, lineage, scaffold), which nothing here holds; its config rows follow
   *  a delete through `exec`, which drops the held config. */
  readonly held = new HeldReads();

  private readonly sql: SqlExecutor = <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    // Before it runs: a statement that throws may still have written.
    if (writesSnapshotRows(query)) this.adopted = null;
    this.held.written(query);

    return this.storage.sql.exec<Extract<T, Record<string, SqlStorageValue>>>(query.join('?'), ...values).toArray();
  };

  /** For stores that take a raw statement. */
  readonly exec: SqlExec = {
    exec: (query, ...bindings) => {
      this.held.written(query);

      return this.storage.sql.exec(query, ...bindings);
    },
  };

  /** The rows this database was last made to hold, as the workspace sent them; null once it wrote one of them itself. */
  private adopted: string | null = null;


  /** Its message count, held: SessionTranscript's record and truncate, and a fork's reset and staging, run over `sql`. */
  private readonly heldMessageCount = this.held.hold(['conversation_entries'], () => this.readable().transcript.count());

  /** Its plans and questions as its standing tells them, held: PlanReviewStore's and OwnerQuestionStore's writes run
   *  over `sql`, and a fork's import of questions too. */
  private readonly heldPlans = this.held.hold(['plan_reviews'], () => new PlanReviewStore(this.sql, this.readable().actor).standing());

  private readonly heldQuestions = this.held.hold(['owner_questions'], () => new OwnerQuestionStore(this.sql, this.readable().actor).revision());

  /** Its steers, held: PendingSendStore's reserve and retire run over `sql`. */
  private readonly steers = this.held.hold(['pending_steers'], () => new PendingSendStore(this.sql, this.readable().actor.actorId).restore()
    // A steer is a row bound to a turn; an unbound row is the chat's own send, already shown as a message.
    .filter((row) => row.turnId !== null)
    .map((row) => ({ id: row.id, text: row.text, state: 'queued' as const, atStep: null })));

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly workspace: {
      readonly agent: () => NimbusSandboxFiles;
      readonly home: string;
      readonly state: () => NimbusSandboxFiles;
      readonly enqueueTurn: BackendHost['enqueueTurn'];
      /** A delivery of this isolate's own (a signal it raised, its events' drain), handed to its chat (design v2 §1). */
      readonly admitDelivery: (delivery: OwedDelivery) => Promise<DeliveryAnswer>;
      readonly broadcast: BackendHost['broadcast'];
      readonly turnInFlight: () => boolean;
      readonly program: AgentWorkspace['program'];
      readonly memory: AgentWorkspace['memory'];
      readonly sayToParent: AgentWorkspace['sayToParent'];
      readonly receipts: AgentWorkspace['receipts'];
      readonly logActivity: AgentWorkspace['logActivity'];
    },
  ) {
    // Run heads, held: every run_events write here is a recorder's persist over `sql`, whose publish advances them.
    holdRunHeads(this.sql);
    // Its config, held: every actor_config write passes `sql` or `exec` (the stores, and adopt's replacement).
    holdConfig(this.sql, this.held);
    initAgentIsolateSchema({
      execRaw: (ddl) => { storage.sql.exec(ddl); },
      sql: this.sql,
      transactionSync: (write) => storage.transactionSync(write),
      exec: this.exec,
    });
    initPendingSendTables((ddl) => { storage.sql.exec(ddl); });
    initTerminalEffectTable((ddl) => { storage.sql.exec(ddl); });
  }

  /** Writes only when the workspace's rows changed, so a read of an unchanged agent writes nothing. Rows read before
   *  ones it already holds are not adopted: a call that reached it late would put back what its workspace changed since
   *  (the owner's model pin among them). */
  adopt(snapshot: AgentSnapshot): void {
    const held = this.snapshot?.order;

    if (held !== undefined && held.activation === snapshot.order.activation && snapshot.order.seq < held.seq) return;

    // The rows it was last made to hold, unwritten since: nothing to read or write.
    const rows = JSON.stringify([snapshot.identity, snapshot.lineage, snapshot.config, snapshot.scaffold]);

    if (rows === this.adopted) {
      this.snapshot = snapshot;

      return;
    }

    const unchanged = holds(this.storage, 'workspace_identity', snapshot.identity)
      && snapshot.lineage.every((row) => holds(this.storage, 'workspace_actors', row) && holdsConfig(this.storage, row.actor_id ?? null, snapshot.config))
      && snapshot.scaffold.every((row) => holds(this.storage, 'scaffold_versions', row));

    if (!unchanged) {
      this.storage.transactionSync(() => {
        upsertRow(this.storage, 'workspace_identity', snapshot.identity);

        for (const row of snapshot.lineage) {
          upsertRow(this.storage, 'workspace_actors', row);
          // Through `exec`, which drops the held config (`holdConfig`) before the copied rows replace it.
          this.exec.exec('DELETE FROM actor_config WHERE actor_id = ?', row.actor_id ?? null);
        }

        for (const row of snapshot.config) upsertRow(this.storage, 'actor_config', row);

        for (const row of snapshot.scaffold) this.selectScaffold(row);
      });
      const adopted = snapshot.lineage.map((row) => v.parse(v.string(), row.actor_id));

      this.directory?.forget(adopted);
    }

    this.adopted = rows;
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

  /** The identity parsed from the rows {@link adopted} names: an adoption of other rows, or a write to them, moves it. */
  private parsedIdentity: { readonly rows: string; readonly identity: v.InferOutput<typeof IdentitySchema> } | null = null;

  private identity(): v.InferOutput<typeof IdentitySchema> {
    const rows = this.adopted;

    if (rows !== null && this.parsedIdentity?.rows === rows) return this.parsedIdentity.identity;
    const snapshot = this.current();
    const identity = v.parse(IdentitySchema, { actor: snapshot.lineage.at(-1), workspace: snapshot.identity });

    if (rows !== null) this.parsedIdentity = { rows, identity };

    return identity;
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

    // Its rows are written here only by adoption, which says which it replaced.
    const directory = new WorkspaceActorDirectory(this.sql, {
      workspaceId: workspace.id,
      ownerUserId: workspace.owner_user_id,
    }, { holdRows: true });

    this.directory = directory;

    const files: AgentRuntimeFiles = {
      agent: () => nimbusSessionFiles(this.workspace.agent(), { home: this.workspace.home }),
      state: () => nimbusSessionFiles(this.workspace.state(), { home: WORKSPACE_ROOT }),
      sql: this.sql,
      storage,
    };

    return createActorHost({
      holds: this.held,
      storage: {
        sql: this.sql,
        transactionSync: (write) => storage.transactionSync(write),
        exec: (query, ...bindings) => this.exec.exec(query, ...bindings),
      },
      directory,
      installedBuild: snapshot.installedBuild,
      workspace: snapshot.workspaceName,
      answered: (turn) => new TurnReports(this.sql).answered(turn),
      runtimeFor: (bound) => this.runtime(bound, files),
      filesFor: async () => ({ vfs: files.agent(), artifactDirectory: snapshot.artifactDirectory }),
      scaffoldFor: async (bound) => ({ path: actorScaffoldPath(bound.record), vfs: files.state() }),
      loopFor: (bound) => ({ origin: defaultLoopOrigin(bound.record.origin), parent: null }),
      orchestrationFor: (bound) => ({
        // What it raises for itself is a delivery too, in its own store: one admission path for every agent.
        deliveries: new InProcessDeliveries({
          actorId: bound.handle.actorId, sql: bound.runtime.storage.sql, transaction: (body) => storage.transactionSync(body),
          eventLog: new EventLog(this.exec, bound.handle),
          admit: (delivery) => this.workspace.admitDelivery(delivery),
          broadcast: (event) => { this.workspace.broadcast(event); },
        }),
        host: this.backendHost(),
        budget: new MissionGovernor({
          storage: bound.runtime.storage,
          actor: bound.handle,
          pricing: (spec) => (this.priced !== null && (spec === undefined || spec === this.priced.model) ? this.priced.pricing : null),
        }),
        sinks: runEventSinks(bound, (event, detail) => {
          this.lines.push(detail === undefined ? { event } : { event, detail });
          this.relayActivity();
        }),
        engine: new EvolutionEngine(bound.runtime, historyTurnPairs(bound.stores.history), {
          enabled: false,
          transaction: (body) => { storage.transactionSync(body); },
        }),
        eventLog: new EventLog(this.exec, bound.handle),
      }),
      contextEvents: (bound) => bound.stores.eventRecorder,
      sayToParent: (_child, signal) => this.workspace.sayToParent(signal),
      // Its workspace tools' receipts are the workspace's, where their effects commit (design v2 §4).
      receipts: (execution, callIds) => this.workspace.receipts(execution.turnId, execution.runId, callIds),
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

  /** The execution's facts are frozen with its first preparation: a later one, its recovery's after a reset, finds them. */
  prepare(bound: TurnBound, prepared: PreparedAgentTurn): void {
    this.priced = { model: prepared.sources.model, pricing: prepared.pricing };
    this.execution = { languages: prepared.languages, execute: (...args) => this.workspace.program(bound, ...args) };
    this.storage.transactionSync(() => {
      this.selectScaffold(prepared.scaffold);
      this.turnFacts.freeze(bound, prepared.facts);
    });
  }

  /** The next number of this agent's sequence, which orders its reports at the workspace. */
  nextInSequence(): number {
    return new AgentSequence(this.sql, this.reference().actorId).next();
  }

  /** What the workspace decided as the execution opened, as this isolate froze it then. */
  factsOf(key: FactsKey): TurnFacts {
    return this.turnFacts.of(key);
  }

  /** What the execution froze as it bound, for a workspace reading the turn again after a restart; null before then. */
  frozen(key: FactsKey): FrozenAuthority | null {
    return this.turnFacts.frozen(key);
  }

  private get turnFacts(): TurnFactsStore {
    return new TurnFactsStore(this.sql, this.reference().actorId);
  }

  async acquire(): Promise<HostedActor> {
    return await this.actorHost().acquire(this.reference(), { kind: 'actor' });
  }

  private transcript() {
    return this.actorHost().bindStores(this.reference()).stores.history.transcript(CHAT_SESSION_ID);
  }

  readable(): ReadableActor {
    const record = this.actorHost().describe(this.reference().actorId);

    if (record === null) return settleSync(Effect.fail(new KinuError('missing', 'The agent is not in its own database.')));

    return readableActor(record, {
      sql: this.sql,
      open: () => {
        const bound = this.actorHost().bindStores(this.reference());

        return { actor: bound.handle, transcript: bound.stores.history.transcript(CHAT_SESSION_ID) };
      },
      // The workspace owner still holds this actor's retained home.
      payloads: async () => nimbusSessionFiles(this.workspace.agent(), { home: this.workspace.home }),
    });
  }

  async inspect(request: AgentOwnInspection): Promise<SubordinateInspectionResult> {
    const { actor, transcript } = this.readable();

    return await readSubordinateInspection({
      sql: this.sql, raw: this.exec, actor, transcriptFor: () => transcript,
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
    const { measures, ...standing } = this.standingReport();

    return { ...standing, context: contextFill(measures, contextWindow) };
  }

  /** Its standing as it reports it with what it owes: the workspace reads it in place of asking. */
  standingReport(): AgentStandingReport {
    const { eventRecorder } = this.actorHost().bindStores(this.reference()).stores;

    return {
      messageCount: this.heldMessageCount(),
      measures: eventRecorder.readContextMeasures(),
      latestRun: eventRecorder.latestRunHeader(),
      pendingSteers: this.steers(),
      plans: this.heldPlans(),
      questions: this.heldQuestions(),
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

  /** The first `before` finished steps of run `runId`, drawn as a replay restates them, read a step at a time, open or
   *  closed: fewer only when the ledger holds fewer. */
  async *runSteps(runId: string, before: number): AsyncGenerator<JsonObject[]> {
    const { eventRecorder } = this.actorHost().bindStores(this.reference()).stores;
    const transcript = this.transcript();
    let at = -1;

    for (let step = 0; step < before; step += 1) {
      const next = eventRecorder.finishedStepAfter(runId, at);

      if (next === null) return;
      at = next.at;
      // A step's output is recorded by reference to its messages' parts: drawn as one message's content.
      yield drawnStep([{ content: await transcript.parts(next.parts) }]);
    }
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
  /** Its conversation as a fork of its workspace reads it. */
  forkSource(): ForkConversationSource {
    return localForkConversationSource(this.sql, this.readable().actor);
  }

  /** A fork of its workspace landing its conversation here; carried payloads re-root under `artifactDirectory`. */
  forkTarget(artifactDirectory: string): ForkConversationTarget {
    return localForkConversationTarget(this.sql, {
      actorId: () => this.reference().actorId,
      artifactPath: (relative) => forkArtifactPath(relative, artifactDirectory),
      now: Date.now(),
      transaction: (write) => { this.storage.transactionSync(write); },
    });
  }

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
    return this.actorHost().bindStores(this.reference()).stores.conversationSearch;
  }

  contextTree(editor: ContextEditor): ContextTree {
    return localContextTree(() => {
      const { stores } = this.actorHost().bindStores(this.reference());

      return { claims: stores.claims, events: stores.eventRecorder };
    }, editor);
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
      bindStores: host.bindStores,
      readScaffold: host.readScaffold,
      hosted: host.hosted,
    });

    // A stalled turn's claim is settled; its run stays open for the agent's chat, which closes it as it next opens, with
    // the input it answered (`ChatSession.endTurn`), so no later start runs its words again.
    // Named for the hirer's assignment row the turn answered, which its retirement dismisses.
    return {
      stalled: recovered.stalled.map((turn) => ({ turnId: announcementOf(turn.claim.turnId), workMode: turn.claim.workMode })),
    };
  }

  /** A run's answer, prepared: the returned write appends it in the commit that ends the run. Nothing where the transcript
   *  holds no turn to answer. */
  async prepareAnswer(completion: NonNullable<HeadReport['canonicalCompletion']>): Promise<() => void> {
    const transcript = this.transcript();

    if (transcript.newestId() === null) return () => {};

    const entry = await transcript.prepareAssistant({
      id: crypto.randomUUID(), turnId: completion.turnId, runId: completion.runId, parts: completion.outputPartReferences,
      finalText: completion.finalTextReference,
    });

    return () => { transcript.appendAssistant(entry); };
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

}
