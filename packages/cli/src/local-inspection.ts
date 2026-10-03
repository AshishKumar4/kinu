import { Effect } from 'effect';
import { existsSync } from 'node:fs';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  BackgroundJobStore,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOLS,
  EventLog,
  HeadJournal,
  MctsSearchStore,
  RunEventRecorder,
  TriggerRegistry,
  type AlarmScheduler,
  openWorkspaceMainActor,
  WorkspaceActorDirectory,
  createAgentConfigStore,
  type ActorHandle,
  type SqlExecutor,
  type WorkspaceActor,
  readWorkspaceWork,
  type WorkspaceWork,
  createFactsStore,
  initEventsHubTables,
  initAgentConfigTable,
  getChatHistoryPage, readSessionTranscript, CHAT_SESSION_ID,
  missingSubordinateHistory, inspectDescendant, readSubordinateInspection, SubordinateInspectionRequestSchema,
  type SubordinateInspectionRequest, type SubordinateInspectionResult,
  getEvolutionChangelog,
  qualitySeries,
  type QualityDay,
  listGepaRuns,
  listRuns,
  listScaffoldVersions,
  loadGepaCandidates,
  createTimerTrigger,
  tableExists as coreTableExists,
  workspaceSpend,
  type BackgroundJob,
  type ChatHistoryEntry,
  type EvolutionChangelogView,
  type GepaCandidate,
  type RunListEntry,
  type GepaRunSummary,
  type HeadRunView,
  type JsonObject,
  type JsonValue,
  type ResolvedTurnProfile,
  type EventVariant,
  type KinuEvent,
  type QueryFilter,
  type RunEvent,
  type ScaffoldVersionView,
  readSearchNodeDetail,
  type SearchNode,
  type SearchNodeDetail,
  type TriggerRow,
  type TimerTrigger,
  type MctsSearchRunSummary,
  type ReasoningEffort,
  setModel,
  setReasoningEffort,
  decodeJsonValue,
  parseJsonValue,
  listRecordObjectives,
  listRecordCells,
  readRecordCell,
  type ExplorationRecord,
  boundedInt,
  RUN_TIMELINE_MAX,
  SCHEMA_GENESIS,
  requireSchemaGenesis as requireGenesis,
  type Page,
  type RecordCellHandle,
  type RecordCellSummary,
  type RecordObjectiveHandle,
  type RecordObjectiveSummary,
  type SeekCursor,
  type WorkspaceSpend,
  type AccountSpend,
  MEMORY_PATH,
  WORKSPACE_ROOT,
  searchMemoryChunks,
  type MemorySearchResult,
} from '@kinu.run/core';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { tolerate, tolerateAsync, settle, settleSync } from '@kinu.run/core/obs';
import {
  makeSql, makeSqlExec, schemaGenesisOf, createHostShell, createLocalProfileAuthority, hostToolchainCapabilities, inspectionFiles,
  resolverModelPlane,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';
import { agentDbPath, resolveAgentRef } from './config';
import { createConfiguredLocalModelResolver } from './local-model-resolver';
import { createProfileAuthorityReader } from './profiles';
import { KinuError } from '@kinu.run/core/obs';

type SqliteDb = Database;

const EventVariantSchema = v.picklist([
  'chat',
  'webhook',
  'process_done',
  'timer',
  'peer_agent',
  'subordinate_task',
  'subordinate_report',
  'file_changed',
  'email',
  'internal',
  'reply_request',
  'mcp_chat',
  'mcp_third_party',
] satisfies EventVariant[]);

export interface LocalExecutorInfo {
  name: string;
  kind: 'workspace';
  status: 'connected';
  capabilities: string[];
}

export interface LocalExecResult {
  executor: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LocalAgentInfoSnapshot {
  name: string;
  purpose: string;
  scaffoldVersion: number;
  searchNodeCount: number;
  createdAt: number;
  conversationCount: number;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

interface LocalStatus {
  name: string | null;
  purpose: string;
  createdAt: number | null;
  scaffoldVersion: number;
  searchNodeCount: number;
  messageCount: number;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

interface LocalToolSummary {
  builtIn: readonly string[];
  crafted: Array<{ name: string; description: string }>;
  executors: LocalExecutorInfo[];
}

export interface LocalAgentState {
  status: LocalStatus;
  tools: LocalToolSummary;
  memoryContent: string;
  mcts: SearchNode[];
  timeline: JsonObject[];
  executors: LocalExecutorInfo[];
}

export function getLocalAgentState(name: string): Promise<LocalAgentState> {
  return settle(Effect.gen(function* () {
    const memoryContent = yield* Effect.promise(() => readLocalMemory(name));

    return yield* withLocalDb(name, (db) => ({
    status: getLocalStatus(db),
    tools: getLocalToolSummary(db),
    memoryContent,
    mcts: listLocalMcts(name),
    timeline: listLocalTimeline(name, 250),
    executors: listLocalExecutors(),
    }));
  }));
}

/** Same read model as the cloud panel; no window, since `workspaceSpend` sums the whole log. */
export function getLocalWorkspaceSpend(name: string): WorkspaceSpend {
  return settleSync(withLocalDb(name, (db) => {
    const sql = makeSql(db);
    const actor = openWorkspaceMainActor(sql);

    return workspaceSpend({ events: new RunEventRecorder(sql, actor), sql, actor });
  }));
}

export function getLocalAccountSpend(name: string): AccountSpend[] {
  return settleSync(withLocalDb(name, (db) => {
    const sql = makeSql(db);

    return new RunEventRecorder(sql, openWorkspaceMainActor(sql)).spendByAccount();
  }));
}

export function getLocalAgentInfo(name: string): LocalAgentInfoSnapshot {
  return settleSync(withLocalDb(name, (db) => {
    const status = getLocalStatus(db);
    const actor = mainActor(db);

    return {
      name: status.name ?? name,
      purpose: status.purpose,
      scaffoldVersion: status.scaffoldVersion,
      searchNodeCount: status.searchNodeCount,
      createdAt: status.createdAt ?? 0,
      conversationCount: actor && tableExists(db, 'conversation_entries')
        ? countOf(
          db,
          `SELECT COUNT(DISTINCT session_id) AS c FROM conversation_entries
           WHERE actor_id = ?`,
          actor.actorId,
        )
        : 0,
      model: status.model,
      reasoningEffort: status.reasoningEffort,
    };
  }));
}

/** Null when nothing names a model. */
export function readLocalNextTurnTier(name: string): Promise<ResolvedTurnProfile['tier'] | null> {
  return settle(Effect.gen(function* () {
    const envelope = yield* Effect.promise(async () => createProfileAuthorityReader()());
    const { llmConfig, resolver } = createConfiguredLocalModelResolver();

    return yield* withLocalDbAsync(name, async (db) => {
      const { config } = openWorkspaceMainActor(makeSql(db));

      if (envelope === null && config.getModel() === null && llmConfig === null) return null;

      return createLocalProfileAuthority({ config, plane: resolverModelPlane(resolver), envelope: async () => envelope })
        .nextTurnTier({ workMode: 'build' });
    });
  }));
}

/** The file itself, through the read-only plane; `memory_chunks` is the search index and can lag an edit. */
export function readLocalMemory(name: string): Promise<string> {
  return settle(withLocalDbAsync(name, async (db) =>
    await tolerateAsync(() => readText(inspectionFiles(db, null), `${WORKSPACE_ROOT}/${MEMORY_PATH}`), 'enoent') ?? ''));
}

/** `limit` is user input bound to raw `LIMIT ?`: SQLite reads -1 as unlimited and rejects NaN/fractions. Validity only, no ceiling. */
/** The agent's own ranked search over the same index. */
export function searchLocalMemory(name: string, query: string, limit = 10): MemorySearchResult[] {
  const window = boundedInt(limit, 10, 1, Number.MAX_SAFE_INTEGER);

  return settleSync(withLocalDb(name, (db) => tableExists(db, 'memory_chunks_fts') ? searchMemoryChunks(makeSql(db), query, window) : []));
}

export function listLocalEvents(name: string, opts: { variant?: string; since?: number; limit?: number } = {}): KinuEvent[] {
  return settleSync(withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'agent_log')) return [];
    const filter: QueryFilter = { limit: opts.limit ?? 50 };

    if (opts.variant) filter.variant = v.parse(EventVariantSchema, opts.variant);

    if (opts.since) filter.since = opts.since;

    return new EventLog(makeSqlExec(db), actor).query(filter);
  }));
}

export function listLocalRuns(name: string, limit = 50): RunListEntry[] {
  return settleSync(readMainActorTable(name, 'run_events', [], (sql, actor) => [...listRuns(new RunEventRecorder(sql, actor), null, limit).items]));
}

/** `since` is inclusive. */
export function listLocalRunEvents(
  name: string, runId: string, opts: { since?: number; limit?: number } = {},
): RunEvent[] {
  return settleSync(readMainActorTable(name, 'run_events', [], (sql, actor) => new RunEventRecorder(sql, actor).read(runId, opts)));
}

/** Local peer of core's `getRunTimeline`, sharing its ceiling; `limit` is user input bound to raw `LIMIT ?`. */
export function listLocalTimeline(name: string, limit = 100): JsonObject[] {
  const window = boundedInt(limit, 100, 1, RUN_TIMELINE_MAX);

  return settleSync(withLocalDb(name, (db) => {
    // Every rail is actor-scoped; this reports the main actor.
    const actor = mainActor(db);
    const rows: JsonObject[] = [];

    if (tableExists(db, 'run_events')) {
      const sql = makeSql(db);
      const recorder = new RunEventRecorder(sql, openWorkspaceMainActor(sql));
      const latest = listRuns(recorder, null, 1).items[0];

      if (latest) {
        rows.push(...recorder.read(latest.runId, { limit: window }).map((e) => ({
          id: `${e.runId}:${e.eventIndex}`,
          kind: `run:${e.type}`,
          runId: e.runId,
          payload: decodeJsonValue({ value: e }),
          ts: Date.parse(e.timestamp) || 0,
        })));
      }
    }

    if (tableExists(db, 'agent_log')) {
      rows.push(...all<{
        id: string; kind: string; turn_id: string | null; step_idx: number | null; payload: string; received_at: number;
      }>(
        db,
        `SELECT id, kind, turn_id, step_idx, payload, received_at
         FROM agent_log
         ORDER BY received_at DESC
         LIMIT ?`,
        window,
      ).map((row) => ({
        id: row.id,
        kind: row.kind,
        turnId: row.turn_id,
        stepIdx: row.step_idx,
        payload: parseJson(row.payload),
        ts: row.received_at,
      })));
    }

    if (actor && tableExists(db, 'evolution_events')) {
      rows.push(...all<{ id: string; type: string; message: string; data: string | null; created_at: number }>(
        db,
        `SELECT id, type, message, data, created_at
         FROM evolution_events
         WHERE actor_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        actor.actorId, window,
      ).map((row) => ({
        id: row.id,
        kind: `evolution:${row.type}`,
        message: row.message,
        data: parseJson(row.data),
        ts: row.created_at,
      })));
    }

    if (actor && tableExists(db, 'search_nodes')) {
      rows.push(...all<{ id: string; action: string; value: number; status: string; created_at: number }>(
        db,
        `SELECT id, action, value, status, created_at
         FROM search_nodes
         WHERE actor_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        actor.actorId, window,
      ).map((row) => ({
        id: row.id,
        kind: 'swarm',
        label: row.action,
        value: row.value,
        status: row.status,
        ts: row.created_at,
      })));
    }

    return rows.sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, window);
  }));
}

/** Every search, deliberately; core's projections answer one. */
export function listLocalMcts(name: string): SearchNode[] {
  return settleSync(withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'search_nodes')) return [];

    return all<SearchNode>(
      db,
      `SELECT id, parent_id, root_id, task, action, observation, visits, value, depth,
              status, created_at
       FROM search_nodes
       WHERE actor_id = ?
       ORDER BY depth, created_at`,
      actor.actorId,
    );
  }));
}

export function listLocalMctsSearchRuns(name: string, limit = 20): MctsSearchRunSummary[] {
  return settleSync(readMainActorTable(name, 'mcts_search_runs', [], (sql, actor) => new MctsSearchStore(sql, actor).list(limit)));
}

/** Local peers of the three record RPCs. A workspace predating `exploration_records` has no table: an absence, not a failure. */
export function listLocalRecordObjectives(name: string, limit = 20): RecordObjectiveSummary[] {
  return settleSync(readAsMainActor(name, 'exploration_records', [], (sql, actor) => [...listRecordObjectives(sql, actor, null, limit).items]));
}

export function listLocalRecordCells(
  name: string, handle: RecordObjectiveHandle, limit = 50,
): RecordCellSummary[] {
  return settleSync(readAsMainActor(name, 'exploration_records', [], (sql, actor) => [...listRecordCells(sql, actor, handle, { limit }).items]));
}

/** Paged, because a cell's population is provably unbounded
 *  (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`). The cursor
 *  is opaque and round-trips through the caller unchanged. */
export function readLocalRecordCell(
  name: string, handle: RecordCellHandle, cursor: SeekCursor | null, limit = 100,
): Page<ExplorationRecord> {
  return settleSync(readAsMainActor<Page<ExplorationRecord>>(name, 'exploration_records', { status: 'end', items: [] }, (sql, actor) => (
    readRecordCell(sql, actor, handle, { cursor, limit })
  )));
}

export function getLocalMctsNode(name: string, nodeId: string): SearchNodeDetail | null {
  return settleSync(readAsMainActor(name, 'search_nodes', null, (sql, actor) => readSearchNodeDetail(sql, actor, nodeId)));
}

export function listLocalHeads(name: string, limit = 20): HeadRunView[] {
  return settleSync(readMainActorTable(name, 'head_journal', [], (sql, actor) => new HeadJournal(sql, actor).listRuns(limit)));
}

export function listLocalGepaRuns(name: string, limit = 20): GepaRunSummary[] {
  return settleSync(withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return [];
    const actor = mainActor(db);

    return actor ? listGepaRuns(makeSql(db), actor, limit) : [];
  }));
}

export function getLocalChatHistory(name: string, limit = 100): Promise<ChatHistoryEntry[]> {
  return settle(withLocalDbAsync(name, async (db) => {
    const sql = makeSql(db);
    const files = inspectionFiles(db, resolveAgentRef(name)?.cwd ?? null);
    const transcript = readSessionTranscript(sql, openWorkspaceMainActor(sql), CHAT_SESSION_ID, () => Promise.resolve(files));

    return [...(await getChatHistoryPage(transcript, { limit })).items];
  }));
}

/** Walks from the main actor; starts nothing. */
export function inspectLocalSubordinate(name: string, request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
  const input = v.parse(SubordinateInspectionRequestSchema, request);

  return settle(withLocalDbAsync(name, async (db) => {
    const directory = actorDirectory(db);

    if (directory === null) return missingSubordinateHistory(input.path);
    const sql = makeSql(db);
    const files = inspectionFiles(db, resolveAgentRef(name)?.cwd ?? null);

    const raw = makeSqlExec(db);
    const transcriptFor = (actor: ActorHandle) => readSessionTranscript(sql, actor, CHAT_SESSION_ID, () => Promise.resolve(files));

    // The file is the owner's own, so the walk needs no owner check. Every actor's rows are in it.
    return inspectDescendant({
      sql, raw, actor: directory.main(), directory, transcriptFor,
      ownRows: (actor, own) => readSubordinateInspection({ sql, raw, actor, transcriptFor: () => transcriptFor(actor) }, own),
    }, input);
  }));
}

export function getLocalChangelog(name: string, limit = 50): EvolutionChangelogView {
  return settleSync(withLocalDb(name, (db) => {
    if (!tableExists(db, 'actor_config')) initAgentConfigTable((ddl) => { db.exec(ddl); });
    const sql = makeSql(db);

    return getEvolutionChangelog(sql, openWorkspaceMainActor(sql), limit);
  }));
}

export function getLocalScaffoldVersions(name: string, limit = 20): ScaffoldVersionView[] {
  return settleSync(withLocalDb(name, (db) => {
    const actor = mainActor(db);

    return actor && tableExists(db, 'scaffold_versions')
      ? listScaffoldVersions(makeSql(db), actor, limit)
      : [];
  }));
}

export function getLocalFacts(name: string, limit = 100): Array<{
  key: string; value: unknown; confidence: number; source: string; lastObservedAt: number;
}> {
  return settleSync(withLocalDb(name, (db) => {
    if (!tableExists(db, 'agent_facts')) return [];
    const sql = makeSql(db);

    return createFactsStore(sql, openWorkspaceMainActor(sql)).recentTopK(limit).map((f) => ({
      key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
    }));
  }));
}

export function getLocalQuality(name: string, days?: number): QualityDay[] {
  return settleSync(readAsMainActor(name, null, [], (sql, actor) => qualitySeries(sql, actor, days === undefined ? {} : { days })));
}

export interface LocalGepaRunDetail {
  run: GepaRunSummary;
  candidates: GepaCandidate[];
}

export function getLocalGepaRun(name: string, runId: string): LocalGepaRunDetail | null {
  return settleSync(withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return null;
    const sql = makeSql(db);
    const actor = mainActor(db);

    if (!actor) return null;
    const run = listGepaRuns(sql, actor, 250).find((candidate) => candidate.runId === runId) ?? null;

    return run ? { run, candidates: loadGepaCandidates(sql, actor, runId) } : null;
  }));
}

/** Uses the live provider's toolchain probe so this listing matches the row the agent is given. */
export function listLocalExecutors(): LocalExecutorInfo[] {
  return [
    {
      name: 'workspace',
      kind: 'workspace',
      status: 'connected',
      capabilities: [...new Set(['shell', 'fs', 'memory', 'craft', ...hostToolchainCapabilities()])],
    },
  ];
}

export function getLocalToolSurface(name: string): {
  builtIn: Array<{ name: string; description: string }>;
  crafted: Array<{ name: string; description: string }>;
  executors: LocalExecutorInfo[];
} {
  return settleSync(withLocalDb(name, (db) => ({
    builtIn: BUILTIN_TOOLS.map((toolName) => ({
      name: toolName,
      description: BUILTIN_TOOL_DESCRIPTIONS[toolName],
    })),
    crafted: tableExists(db, 'crafted_tools')
      ? all<{ name: string; description: string }>(db, `SELECT name, description FROM crafted_tools ORDER BY name`)
      : [],
    executors: listLocalExecutors(),
  })));
}

export function listLocalTriggers(name: string): { triggers: TriggerRow[] } {
  return settleSync(withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'triggers')) return { triggers: [] };

    return { triggers: new TriggerRegistry(makeSqlExec(db), actor, NOOP_ALARM).list() };
  }));
}

export function cancelLocalTrigger(name: string, id: string): Promise<{ changed: boolean }> {
  return settle(withLocalWritableDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'triggers')) return { changed: false };

    return { changed: new TriggerRegistry(makeSqlExec(db), actor, NOOP_ALARM).revoke(id, Date.now()) };
  }));
}

export function createLocalTimerTrigger(name: string, input: { cron?: string; atMs?: number; label?: string }): Promise<TimerTrigger> {
  return settle(withLocalWritableDb(name, (db) => {
    initEventsHubTables(makeSqlExec(db));
    const actor = openWorkspaceMainActor(makeSql(db));

    return createTimerTrigger(new TriggerRegistry(makeSqlExec(db), actor, NOOP_ALARM), { ...input, trust: 'owner' }, Date.now());
  }));
}

export function setLocalWorkspaceModel(name: string, spec: string): Promise<{ spec: string }> {
  return settle(Effect.gen(function* () {
    const { resolver } = createConfiguredLocalModelResolver();

    return yield* withLocalWritableDb(name, (db) => setModel({
      config: openWorkspaceMainActor(makeSql(db)).config,
      normalize: (value) => resolver.normalizeSpecSync(value),
      onChanged: () => {},
    }, spec));
  }));
}

export function setLocalWorkspaceReasoningEffort(name: string, effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
  return settle(withLocalWritableDb(name, (db) => setReasoningEffort(openWorkspaceMainActor(makeSql(db)).config, effort)));
}

export function readLocalWorkspacePins(name: string): Promise<{ model: string | null; reasoningEffort: ReasoningEffort | null }> {
  return settle(withLocalWritableDb(name, (db) => {
    const config = openWorkspaceMainActor(makeSql(db)).config;

    return { model: config.getModel(), reasoningEffort: config.getReasoningEffort() };
  }));
}

export function listLocalJobs(name: string, limit = 20): BackgroundJob[] {
  return settleSync(readMainActorTable(name, 'background_jobs', [], (sql, actor) => new BackgroundJobStore(sql, actor).list(limit)));
}

export function cancelLocalJob(name: string, id: string): Promise<{ ok: boolean }> {
  return settle(withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return { ok: false };
    const sql = makeSql(db);
    const store = new BackgroundJobStore(sql, openWorkspaceMainActor(sql));
    const before = store.get(id);

    if (!before || before.status !== 'running') return { ok: false };
    store.cancel(id, before.epoch, Date.now());

    return { ok: true };
  }));
}

export function executeLocalExecutor(name: string, executorId: string, command: string): Promise<LocalExecResult> {
  return settle(Effect.gen(function* () {
    yield* ensureLocalAgent(name);
    const normalized = executorId.toLowerCase();

    if (!['workspace', 'device', 'local', 'your-pc'].includes(normalized)) {
      return yield* Effect.die(new Error(`Executor "${executorId}" is not available for local agents.`));
    }

    // createHostShell owns group kill on abort and settles when the command exits, not when a grandchild closes the pipe.
    const result = yield* Effect.promise(async () => createHostShell(process.cwd()).exec(command));

    return { executor: executorId, command, ...result };
  }));
}

export function markLocalBackgroundJobsCancelled(name: string): Promise<string[]> {
  return settle(withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return [];
    // Through the store: the registry is actor-private and `cancel` is epoch-fenced; a blanket UPDATE would cancel other actors' jobs.
    const sql = makeSql(db);
    const store = new BackgroundJobStore(sql, openWorkspaceMainActor(sql));
    const cancelled: string[] = [];
    const now = Date.now();

    for (const id of store.runningIds()) {
      const job = store.get(id);

      if (!job || job.status !== 'running') continue;
      store.cancel(id, job.epoch, now);
      cancelled.push(id);
    }

    return cancelled.reverse();
  }));
}

function openLocalDb(name: string): Effect.Effect<SqliteDb> {
  return Effect.gen(function* () {
    const dbPath = agentDbPath(name);

    if (!existsSync(dbPath)) return yield* Effect.die(new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`));

    const db = new Database(dbPath, { readonly: true });
    const genesis = schemaGenesisOf(db);

    if (genesis !== SCHEMA_GENESIS.slice(0, 7)) db.close();
    requireGenesis(`Workspace "${name}"`, genesis);

    return db;
  });
}

function readMainActorTable<T>(name: string, table: string, absent: T, read: (sql: SqlExecutor, actor: ActorHandle) => T): Effect.Effect<T> {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, table)) return absent;
    const sql = makeSql(db);

    return read(sql, openWorkspaceMainActor(sql));
  });
}

/** Closes once `use` settles, whichever way. */
function useLocalDb<T, E>(name: string, use: (db: SqliteDb) => Effect.Effect<T, E>): Effect.Effect<T, E> {
  return Effect.flatMap(openLocalDb(name), (db) => Effect.ensuring(use(db), Effect.sync(() => {
    db.close();
  })));
}

function withLocalDb<T>(name: string, fn: (db: SqliteDb) => T): Effect.Effect<T> {
  return useLocalDb(name, (db) => Effect.sync(() => fn(db)));
}

function withLocalDbAsync<T>(name: string, fn: (db: SqliteDb) => Promise<T>): Effect.Effect<T> {
  return useLocalDb(name, (db) => Effect.promise(() => fn(db)));
}

/** Reads as the workspace's main actor; a workspace predating `table` has none of its rows: an absence, not a failure. */
function readAsMainActor<T>(name: string, table: string | null, absent: T, read: (sql: SqlExecutor, actor: ActorHandle) => T): Effect.Effect<T, KinuError> {
  return useLocalDb(name, (db) => (table === null || tableExists(db, table)
    ? Effect.map(requireMainActor(db), (actor) => read(makeSql(db), actor))
    : Effect.succeed(absent)));
}

/** Closes only after the callback settles: `TriggerRegistry` mutators await the alarm seam. */
function withLocalWritableDb<T>(name: string, fn: (db: SqliteDb) => T | Promise<T>): Effect.Effect<T, KinuError> {
  return Effect.gen(function* () {
    const dbPath = agentDbPath(name);

    if (!existsSync(dbPath)) return yield* Effect.die(new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`));
    const db = new Database(dbPath);

    return yield* Effect.ensuring(Effect.gen(function* () {
      return yield* Effect.promise(async () => fn(db));
    }), Effect.sync(() => {
      db.close();
    }));
  });
}

function ensureLocalAgent(name: string): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const dbPath = agentDbPath(name);

    if (!existsSync(dbPath)) return yield* Effect.die(new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`));
  });
}

function all<T>(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.prepare<T, SQLQueryBindings[]>(sql).all(...params);
}

function countOf(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): number {
  return all<{ c: number }>(db, sql, ...params).at(0)?.c ?? 0;
}

function currentScaffoldVersion(db: SqliteDb, actorId: string): number {
  const current = all<{ version: number }>(
    db,
    `SELECT version FROM scaffold_versions
     WHERE actor_id = ? AND status = 'current' ORDER BY version DESC LIMIT 1`,
    actorId,
  ).at(0);

  return current?.version ?? 0;
}

function tableExists(db: SqliteDb, name: string): boolean {
  return coreTableExists(makeSql(db), name);
}

/**
 * The main actor, or null without a durable identity. Every store read here is actor-private; other actors are
 * reachable via {@link listLocalActors} and {@link getLocalActorInfo}.
 */
function mainActor(db: SqliteDb): ActorHandle | null {
  return tableExists(db, 'workspace_identity') ? openWorkspaceMainActor(makeSql(db)) : null;
}

/** Refuses a database with no identity row instead of returning another actor's rows or an empty set. */
function requireMainActor(db: SqliteDb): Effect.Effect<ActorHandle, KinuError> {
  const actor = mainActor(db);

  return actor ? Effect.succeed(actor) : Effect.fail(new KinuError('missing', 'This workspace database has no durable identity to read as.'));
}

export interface LocalActorRow {
  readonly actorId: string;
  readonly name: string;
  readonly storageKey: string;
  readonly origin: WorkspaceActor['origin'];
  readonly tab: boolean;
  readonly input: boolean;
  readonly lifetime: WorkspaceActor['lifetime'];
  readonly evolves: boolean;
  readonly createdAt: number;
  readonly retired: boolean;
}

/** Null before the workspace has an identity. Issues no handle, so listing starts no actor. */
function actorDirectory(db: SqliteDb): WorkspaceActorDirectory | null {
  if (!tableExists(db, 'workspace_actors') || !tableExists(db, 'workspace_identity')) return null;

  const identity = all<{ id: string; owner_user_id: string | null }>(
    db, `SELECT id, owner_user_id FROM workspace_identity LIMIT 1`).at(0);

  if (identity === undefined) return null;

  return new WorkspaceActorDirectory(makeSql(db), {
    workspaceId: identity.id, ownerUserId: identity.owner_user_id ?? '',
  });
}

/** Includes retired actors; nothing is opened to read them. */
export function listLocalActors(name: string, opts: { readonly retired?: boolean } = {}): LocalActorRow[] {
  return settleSync(withLocalDb(name, (db) => {
    const directory = actorDirectory(db);

    if (!directory) return [];
    // `list()` excludes retired rows by default, so `retired` is always passed explicitly.
    const rows = directory.list({ retired: opts.retired ?? true });

    return rows.map((row): LocalActorRow => ({
      actorId: row.actorId,
      name: row.name,
      storageKey: row.storageKey,
      origin: row.origin,
      tab: row.tab,
      input: row.input,
      lifetime: row.lifetime,
      evolves: row.evolves,
      createdAt: row.createdAt,
      retired: row.retiringAt !== null || row.deletedAt !== null,
    }));
  }));
}

export function readLocalWorkspaceWork(name: string): WorkspaceWork {
  return settleSync(withLocalDb(name, (db) => {
    const directory = actorDirectory(db);

    return directory === null
      ? { plans: [], tasks: [] }
      : readWorkspaceWork(makeSql(db), directory.main(), directory.list({ retired: true }));
  }));
}

/** Reads by id only, starting nothing; retired actors have no handle. Null for an id this workspace never issued. */
export function getLocalActorInfo(name: string, actorId: string): LocalAgentInfoSnapshot | null {
  return settleSync(withLocalDb(name, (db) => {
    const directory = actorDirectory(db);
    const row = directory?.retained(actorId) ?? null;

    if (!row) return null;

    const config = tableExists(db, 'actor_config')
      ? createAgentConfigStore(makeSql(db), actorId, () => settleSync(directory?.retained(actorId)
        ? Effect.void
        : Effect.die(new Error(`actor ${actorId} is no longer retained in this workspace`))))
      : null;

    return {
      name: row.name,
      purpose: '',
      scaffoldVersion: tableExists(db, 'scaffold_versions')
        ? currentScaffoldVersion(db, actorId)
        : 0,
      searchNodeCount: tableExists(db, 'search_nodes')
        ? countOf(db, `SELECT COUNT(*) AS c FROM search_nodes WHERE actor_id = ?`, actorId)
        : 0,
      createdAt: row.createdAt,
      conversationCount: tableExists(db, 'conversation_entries')
        ? countOf(db,
          `SELECT COUNT(DISTINCT session_id) AS c FROM conversation_entries
           WHERE actor_id = ?`, actorId)
        : 0,
      model: config?.getModel() ?? null,
      reasoningEffort: config?.getReasoningEffort() ?? null,
    };
  }));
}

function getLocalStatus(db: SqliteDb): LocalStatus {
  const hasIdentity = tableExists(db, 'workspace_identity');
  const actor = mainActor(db);

  const identity = hasIdentity
    ? all<{ name: string; created_at: number }>(
      db, `SELECT name, created_at FROM workspace_identity LIMIT 1`).at(0)
    : null;

  // From the identity row, not SOUL.md: opening the workspace filesystem writes. `writeSoul` keeps it current (identity/soul.ts).
  const mission = hasIdentity
    ? all<{ mission: string | null }>(db, `SELECT mission FROM workspace_identity LIMIT 1`).at(0)?.mission?.trim() ?? null
    : null;

  return {
    name: identity?.name ?? null,
    purpose: mission ?? '',
    createdAt: identity?.created_at ?? null,
    // The live version, not MAX(version), which would include a pending proposal.
    scaffoldVersion: actor && tableExists(db, 'scaffold_versions')
      ? currentScaffoldVersion(db, actor.actorId)
      : 0,
    searchNodeCount: actor && tableExists(db, 'search_nodes')
      ? countOf(db, `SELECT COUNT(*) AS c FROM search_nodes WHERE actor_id = ?`, actor.actorId)
      : 0,
    messageCount: actor && tableExists(db, 'conversation_entries')
      ? countOf(db, `SELECT COUNT(*) AS c FROM conversation_entries WHERE actor_id = ?`, actor.actorId)
      : 0,
    model: tableExists(db, 'actor_config')
      ? openWorkspaceMainActor(makeSql(db)).config.getModel()
      : null,
    reasoningEffort: tableExists(db, 'actor_config')
      ? openWorkspaceMainActor(makeSql(db)).config.getReasoningEffort()
      : null,
  };
}

function getLocalToolSummary(db: SqliteDb): LocalToolSummary {
  const crafted = tableExists(db, 'crafted_tools')
    ? all<{ name: string; description: string }>(db, `SELECT name, description FROM crafted_tools ORDER BY name`)
    : [];

  return {
    builtIn: BUILTIN_TOOLS,
    crafted,
    executors: listLocalExecutors(),
  };
}

const NOOP_ALARM: AlarmScheduler = {
  async scheduleAt() {},
};

function parseJson(value: string | null): JsonValue {
  if (value == null) return null;
  const parsed = tolerate(() => parseJsonValue(value), 'malformed-input');

  return parsed === undefined ? value : parsed;
}

function timestampOf(value: JsonObject): number {
  const parsed = v.safeParse(v.number(), value.ts);

  return parsed.success ? parsed.output : 0;
}
