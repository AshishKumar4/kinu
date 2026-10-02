import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** An agent's own SQLite, under the core stores; its roster rows are copies the workspace sends on each call. */
import type { ModelMessage, UIMessage } from 'ai';
import {
  CHAT_SESSION_ID, EventLog, EvolutionEngine, WorkspaceActorDirectory, runEventSinks,
  actorReferenceOf, actorScaffoldPath, createActorHost, createScaffoldSurface, defaultLoopOrigin,
  initWorkspaceSchema, nimbusSessionFiles, recoverActorTurns, MissionGovernor, actorReadHandle, readSessionTranscript, readSubordinateInspection,
  getChatHistoryPage, inheritedContextFromTranscript, turnRequestIndex, turnRequestPage,
  type TurnRequestIndex, type TurnRequestPage, ConversationSearchStore, RunEventRecorder, spendLedger, type SpendLedger, type StepSpendSource,
  readAgentFigures, NO_FIGURES, type AgentFigures,
  localContextTree, type ContextEditor, type ContextTree, type ConversationRecall,
  type ActorHandle, type AgentOwnInspection, type ChatHistoryPage, type PositionPageRequest, type SerializedMessage,
  type SessionTranscriptReader, type SubordinateInspectionResult, type ModelPricing, type SqlExecutor,
  type ActorHost, type ActorReference, type AgentRuntime, type BackendHost, type BoundActor, type HeadReport, type HostedActor,
  type Executor, type JsonObject, type NimbusSandboxHandle, type SqlValue, WORKSPACE_ROOT,
} from '@kinu.run/core';
import { attempt, diagnostics, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { AgentTurnActivity, AgentTurnOpening, AgentRecovery, AgentSnapshot, PreparedAgentTurn, StoredRow, TurnRequestAt } from '@kinu.run/core';
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
  }

  adopt(snapshot: AgentSnapshot): void {
    this.storage.transactionSync(() => {
      upsertRow(this.storage, 'workspace_identity', snapshot.identity);

      for (const row of snapshot.lineage) {
        upsertRow(this.storage, 'workspace_actors', row);
        this.storage.sql.exec('DELETE FROM actor_config WHERE actor_id = ?', row.actor_id ?? null);
      }

      for (const row of snapshot.config) upsertRow(this.storage, 'actor_config', row);
    });
    this.snapshot = snapshot;
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
        engine: new EvolutionEngine(bound.runtime, bound.stores.history, {
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
      workspaceIsMachine: false,
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
      broadcast: () => undefined,
      enqueueTurn: (input) => this.workspace.enqueueTurn(input),
      turnInFlight: () => false,
      closed: () => false,
      setTimer: (fn, ms) => {
        setTimeout(() => settle(attempt({ doing: "running an agent's debounced drain", otherwise: 'io' }, fn).pipe(
          Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('agent.timer_failed', failure); })),
        )), ms);
      },
      reconcileDurableWake: null,
    };
  }

  prepare(turnId: string, prepared: PreparedAgentTurn): void {
    this.priced = { model: prepared.model, pricing: prepared.pricing };
    this.execution = { languages: prepared.languages, execute: (...args) => this.workspace.program(turnId, ...args) };
    this.storage.transactionSync(() => {
      void this.sql`UPDATE scaffold_versions SET status = 'historical'
        WHERE actor_id = ${this.reference().actorId} AND version != ${prepared.scaffold.version ?? null} AND status = 'current'`;
      upsertRow(this.storage, 'scaffold_versions', prepared.scaffold);
    });
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

  async open(opening: AgentTurnOpening): Promise<void> {
    const bound = this.actorHost().bindStores(this.reference());
    const history = bound.stores.history;
    const rows = history.transcript(CHAT_SESSION_ID);

    if (rows.has(opening.id)) return;

    const message = await history.admitInput({
      id: opening.id, turnId: opening.id, message: opening.message, assertOwner: () => bound.handle.assertCurrent(),
    });

    const prepared = await rows.prepareUser({ id: opening.id, turnId: opening.id, message, metadata: opening.metadata });

    this.storage.transactionSync(() => rows.appendUser(prepared));
  }

  async recover(): Promise<AgentRecovery> {
    const host = this.actorHost();

    const recovered = await recoverActorTurns({
      installedBuild: host.installedBuild,
      workspace: this.current().workspaceName,
      resumable: (limit) => host.resumable(limit),
      acquire: async (reference) => {
        const actor = await host.acquire(reference);

        return { runtime: actor.runtime, stores: actor.stores, session: { get turnOpen() { return actor.session.turnOpen; } } };
      },
    });

    return {
      stalled: recovered.stalled.map((turn) => ({ turnId: turn.claim.turnId, runs: turn.claim.epoch, workMode: turn.claim.workMode })),
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

  admitted(id: string): boolean {
    return this.readable().transcript.has(id);
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

  clear(): void {
    const reference = this.reference();

    this.actorHost().bindStores(reference).stores.history.clearConversation(CHAT_SESSION_ID, () => {
      if (this.actorHost().hosted(reference)?.session.inFlight === true) {
        return settleSync(Effect.fail(new KinuError('denied', 'Stop the active turn before clearing its conversation')));
      }
    });
  }

}
