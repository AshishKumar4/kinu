import { existsSync } from 'node:fs';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  BackgroundJobStore,
  runOnExecutor,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOLS,
  getToolList,
  EventLog,
  HeadJournal,
  MctsSearchStore,
  RunEventRecorder,
  TriggerRegistry,
  type AlarmScheduler,
  openWorkspaceMainActor,
  WorkspaceActorDirectory,
  createAgentConfigStore, getCurrentScaffoldVersion,
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
  type ResolvedTurnProfile,
  EVENT_VARIANTS,
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
  getRunTimeline,
  JsonObjectSchema,
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
  agentStatusFacts,
  type MemorySearchResult,
} from '@kinu.run/core';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { tolerateAsync } from '@kinu.run/core/obs';
import {
  workspaceHome, makeSql, makeSqlExec, schemaGenesisOf, createLocalProfileAuthority, hostToolchainCapabilities, inspectionFiles,
  openWorkspaceCLI, resolverModelPlane, soulOf, workspaceMemory,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';
import { agentDbPath, resolveLocalAgent } from './config';
import { createConfiguredLocalModelResolver, type LocalModelResolverOptions } from './local-model-resolver';
import { createProfileAuthorityReader } from './profiles';
import { KinuError } from '@kinu.run/core/obs';

type SqliteDb = Database;

const EventVariantSchema = v.picklist(EVENT_VARIANTS);

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
  /** Set when the executor refused or failed before producing output. */
  error?: string;
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

export async function getLocalAgentState(name: string): Promise<LocalAgentState> {
  const memoryContent = await readLocalMemory(name);

  return withLocalDb(name, (db) => ({
    status: getLocalStatus(db),
    tools: getLocalToolSummary(db),
    memoryContent,
    mcts: localMcts(db),
    timeline: localTimeline(db, 250),
    executors: listLocalExecutors(),
  }));
}

/** Same read model as the cloud panel; no window, since `workspaceSpend` sums the whole log. */
export function getLocalWorkspaceSpend(name: string): WorkspaceSpend {
  return withLocalDb(name, (db) => {
    const sql = makeSql(db);
    const actor = openWorkspaceMainActor(sql);

    return workspaceSpend({ events: new RunEventRecorder(sql, actor), sql, actor });
  });
}

export function getLocalAccountSpend(name: string): AccountSpend[] {
  return withLocalDb(name, (db) => {
    const sql = makeSql(db);

    return new RunEventRecorder(sql, openWorkspaceMainActor(sql)).spendByAccount();
  });
}

export function getLocalAgentInfo(name: string): LocalAgentInfoSnapshot {
  return withLocalDb(name, (db) => {
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
  });
}

/** Null when nothing names a model. */
export async function readLocalNextTurnTier(name: string, opts: LocalModelResolverOptions = {}): Promise<ResolvedTurnProfile['tier'] | null> {
  const envelope = await createProfileAuthorityReader()();
  const { llmConfig, resolver } = createConfiguredLocalModelResolver(opts);

  return withLocalDbAsync(name, async (db) => {
    const { config } = openWorkspaceMainActor(makeSql(db));

    if (envelope === null && config.getModel() === null && llmConfig === null) return null;

    return createLocalProfileAuthority({ config, plane: resolverModelPlane(resolver), envelope: async () => envelope })
      .nextTurnTier({ workMode: 'build' });
  });
}

/** The note itself, a real file of main's home; `memory_note_chunks` is the search index. */
export function readLocalMemory(name: string): Promise<string> {
  return withLocalDbAsync(name, async (db) => await tolerateAsync(() => readText(workspaceHome(db), MEMORY_PATH), 'enoent') ?? '');
}

/** `limit` is user input bound to raw `LIMIT ?`: SQLite reads -1 as unlimited and rejects NaN/fractions. Validity only, no ceiling. */
/** The agent's own search, as its memory tool runs it: a note a shell changed is indexed again first, so its new words are found. */
export function searchLocalMemory(name: string, query: string, limit = 10): Promise<MemorySearchResult[]> {
  const window = boundedInt(limit, 10, 1, Number.MAX_SAFE_INTEGER);

  return withLocalDbAsync(name, async (db) => workspaceMemory(db).search(query, window), 'repair');
}

export function listLocalEvents(name: string, opts: { variant?: string; since?: number; limit?: number } = {}): KinuEvent[] {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'agent_log')) return [];
    const filter: QueryFilter = { limit: opts.limit ?? 50 };

    if (opts.variant) filter.variant = v.parse(EventVariantSchema, opts.variant);

    if (opts.since) filter.since = opts.since;

    return new EventLog(makeSqlExec(db), actor).query(filter);
  });
}

export function listLocalRuns(name: string, limit = 50): RunListEntry[] {
  return readMainActorTable(name, 'run_events', [], (sql, actor) => [...listRuns(new RunEventRecorder(sql, actor), null, limit).items]);
}

/** `since` is inclusive. */
export function listLocalRunEvents(
  name: string, runId: string, opts: { since?: number; limit?: number } = {},
): RunEvent[] {
  return readMainActorTable(name, 'run_events', [], (sql, actor) => new RunEventRecorder(sql, actor).read(runId, opts));
}

/** Core's `getRunTimeline` over the local database, as the cloud answers it; only the default of 100 is this surface's. */
export function listLocalTimeline(name: string, limit = 100): JsonObject[] {
  return withLocalDb(name, (db) => localTimeline(db, limit));
}

function localTimeline(db: SqliteDb, limit: number): JsonObject[] {
  const actor = mainActor(db);

  if (actor === null || !tableExists(db, 'run_events')) return [];
  const sql = makeSql(db);
  const deps = { sql, actor, events: new RunEventRecorder(sql, actor), jobs: new BackgroundJobStore(sql, actor), currentRunId: null };

  // Through JSON, as the cloud's spans cross its wire: an absent field is no key.
  const spans = getRunTimeline(deps, { limit: boundedInt(limit, 100, 1, RUN_TIMELINE_MAX) });

  return v.parse(v.array(JsonObjectSchema), parseJsonValue(JSON.stringify(spans)));
}

/** Every search, deliberately; core's projections answer one. */
export function listLocalMcts(name: string): SearchNode[] {
  return withLocalDb(name, localMcts);
}

function localMcts(db: SqliteDb): SearchNode[] {
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
}

export function listLocalMctsSearchRuns(name: string, limit = 20): MctsSearchRunSummary[] {
  return readMainActorTable(name, 'mcts_search_runs', [], (sql, actor) => new MctsSearchStore(sql, actor).list(limit));
}

/** Local peers of the three record RPCs. A workspace predating `exploration_records` has no table: an absence, not a failure. */
export function listLocalRecordObjectives(name: string, limit = 20): RecordObjectiveSummary[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'exploration_records')
      ? [...listRecordObjectives(makeSql(db), requireMainActor(db), null, limit).items]
      : []
  ));
}

export function listLocalRecordCells(
  name: string, handle: RecordObjectiveHandle, limit = 50,
): RecordCellSummary[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'exploration_records')
      ? [...listRecordCells(makeSql(db), requireMainActor(db), handle, { limit }).items]
      : []
  ));
}

/** Paged, because a cell's population is provably unbounded
 *  (`ArchiveAdmission.lean — separated_cells_are_unboundedly_large`). The cursor
 *  is opaque and round-trips through the caller unchanged. */
export function readLocalRecordCell(
  name: string, handle: RecordCellHandle, cursor: SeekCursor | null, limit = 100,
): Page<ExplorationRecord> {
  return withLocalDb(name, (db) => (
    tableExists(db, 'exploration_records')
      ? readRecordCell(makeSql(db), requireMainActor(db), handle, { cursor, limit })
      : { status: 'end', items: [] }
  ));
}

export function getLocalMctsNode(name: string, nodeId: string): SearchNodeDetail | null {
  return withLocalDb(name, (db) => (
    tableExists(db, 'search_nodes') ? readSearchNodeDetail(makeSql(db), requireMainActor(db), nodeId) : null
  ));
}

export function listLocalHeads(name: string, limit = 20): HeadRunView[] {
  return readMainActorTable(name, 'head_journal', [], (sql, actor) => new HeadJournal(sql, actor).listRuns(limit));
}

export function listLocalGepaRuns(name: string, limit = 20): GepaRunSummary[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return [];
    const actor = mainActor(db);

    return actor ? listGepaRuns(makeSql(db), actor, limit) : [];
  });
}

export function getLocalChatHistory(name: string, limit = 100): Promise<ChatHistoryEntry[]> {
  return withLocalDbAsync(name, async (db) => {
    const sql = makeSql(db);
    const files = inspectionFiles(db, resolveLocalAgent(name).cwd);
    const transcript = readSessionTranscript(sql, openWorkspaceMainActor(sql), CHAT_SESSION_ID, () => Promise.resolve(files));

    return [...(await getChatHistoryPage(transcript, { limit })).items];
  });
}

/** Walks from the main actor; starts nothing. */
export function inspectLocalSubordinate(name: string, request: SubordinateInspectionRequest): Promise<SubordinateInspectionResult> {
  const input = v.parse(SubordinateInspectionRequestSchema, request);

  return withLocalDbAsync(name, async (db) => {
    const directory = actorDirectory(db);

    if (directory === null) return missingSubordinateHistory(input.path);
    const sql = makeSql(db);
    const files = inspectionFiles(db, resolveLocalAgent(name).cwd);

    const raw = makeSqlExec(db);
    const transcriptFor = (actor: ActorHandle) => readSessionTranscript(sql, actor, CHAT_SESSION_ID, () => Promise.resolve(files));

    // The file is the owner's own, so the walk needs no owner check. Every actor's rows are in it.
    return inspectDescendant({
      sql, raw, actor: directory.main(), directory, transcriptFor,
      ownRows: (actor, own) => readSubordinateInspection({ sql, raw, actor, transcriptFor: () => transcriptFor(actor) }, own),
    }, input);
  });
}

export function getLocalChangelog(name: string, limit = 50): EvolutionChangelogView {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'actor_config')) initAgentConfigTable((ddl) => { db.exec(ddl); });
    const sql = makeSql(db);

    return getEvolutionChangelog(sql, openWorkspaceMainActor(sql), limit);
  });
}

export function getLocalScaffoldVersions(name: string, limit = 20): ScaffoldVersionView[] {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    return actor && tableExists(db, 'scaffold_versions')
      ? listScaffoldVersions(makeSql(db), actor, limit)
      : [];
  });
}

export function getLocalFacts(name: string, limit = 100): Array<{
  key: string; value: unknown; confidence: number; source: string; lastObservedAt: number;
}> {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'agent_facts')) return [];
    const sql = makeSql(db);

    return createFactsStore(sql, openWorkspaceMainActor(sql)).recentTopK(limit).map((f) => ({
      key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
    }));
  });
}

export function getLocalQuality(name: string, days?: number): QualityDay[] {
  return withLocalDb(name, (db) => qualitySeries(makeSql(db), requireMainActor(db), days === undefined ? {} : { days }));
}

export interface LocalGepaRunDetail {
  run: GepaRunSummary;
  candidates: GepaCandidate[];
}

export function getLocalGepaRun(name: string, runId: string): LocalGepaRunDetail | null {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return null;
    const sql = makeSql(db);
    const actor = mainActor(db);

    if (!actor) return null;
    const run = listGepaRuns(sql, actor, 250).find((candidate) => candidate.runId === runId) ?? null;

    return run ? { run, candidates: loadGepaCandidates(sql, actor, runId) } : null;
  });
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
  return withLocalDb(name, (db) => ({
    builtIn: BUILTIN_TOOLS.map((toolName) => ({
      name: toolName,
      description: BUILTIN_TOOL_DESCRIPTIONS[toolName],
    })),
    crafted: localCraftedTools(db),
    executors: listLocalExecutors(),
  }));
}

/** Core's tool inventory over a workspace's database, opened read-only here; one made before any craft has none. */
function localCraftedTools(db: SqliteDb): Array<{ name: string; description: string }> {
  if (!tableExists(db, 'crafted_tools')) return [];

  return getToolList(makeSql(db)).crafted.map(({ name, description }) => ({ name, description }));
}

export function listLocalTriggers(name: string): { triggers: TriggerRow[] } {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'triggers')) return { triggers: [] };

    return { triggers: new TriggerRegistry(makeSqlExec(db), actor, NOOP_ALARM).list() };
  });
}

export async function cancelLocalTrigger(name: string, id: string): Promise<{ changed: boolean }> {
  return withLocalDbAsync(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'triggers')) return { changed: false };

    return { changed: new TriggerRegistry(makeSqlExec(db), actor, NOOP_ALARM).revoke(id, Date.now()) };
  }, 'write');
}

export async function createLocalTimerTrigger(name: string, input: { cron?: string; atMs?: number; label?: string }): Promise<TimerTrigger> {
  return withLocalDbAsync(name, (db) => {
    initEventsHubTables(makeSqlExec(db));
    const actor = openWorkspaceMainActor(makeSql(db));

    return createTimerTrigger(new TriggerRegistry(makeSqlExec(db), actor, NOOP_ALARM), { ...input, trust: 'owner' }, Date.now());
  }, 'write');
}

export async function setLocalWorkspaceModel(name: string, spec: string): Promise<{ spec: string }> {
  const { resolver } = createConfiguredLocalModelResolver();

  return withLocalDbAsync(name, (db) => setModel({
    config: openWorkspaceMainActor(makeSql(db)).config,
    normalize: (value) => resolver.normalizeSpecSync(value),
    onChanged: () => {},
  }, spec), 'write');
}

export async function setLocalWorkspaceReasoningEffort(name: string, effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
  return withLocalDbAsync(name, (db) => setReasoningEffort(openWorkspaceMainActor(makeSql(db)).config, effort), 'write');
}

export async function readLocalWorkspacePins(name: string): Promise<{ model: string | null; reasoningEffort: ReasoningEffort | null }> {
  return withLocalDbAsync(name, (db) => {
    const config = openWorkspaceMainActor(makeSql(db)).config;

    return { model: config.getModel(), reasoningEffort: config.getReasoningEffort() };
  }, 'write');
}

export function listLocalJobs(name: string, limit = 20): BackgroundJob[] {
  return readMainActorTable(name, 'background_jobs', [], (sql, actor) => new BackgroundJobStore(sql, actor).list(limit));
}

/** Whichever actor owns it. */
export function localJobRunning(name: string, id: string): boolean {
  return readMainActorTable(name, 'background_jobs', false, (sql) => sql<{ status: string }>`
    SELECT status FROM background_jobs WHERE id = ${id}`.some((row) => row.status === 'running'));
}

/** The addressed workspace's own registered executor runs the command, as the cloud's executeInExecutor does. */
export async function executeLocalExecutor(name: string, executorId: string, command: string): Promise<LocalExecResult> {
  return withLocalDbAsync(name, async (db) => {
    const { rt } = await openWorkspaceCLI(db, agentDbPath(name), { llm: null, cwd: resolveLocalAgent(name).cwd });

    const run = rt.executionRouter
      ? await runOnExecutor(rt.executionRouter, executorId, command)
      : { kind: 'refused' as const, error: `Workspace "${name}" has no execution router` };

    return run.kind === 'ran'
      ? { executor: executorId, command, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode }
      : { executor: executorId, command, stdout: '', stderr: '', exitCode: 1, error: run.error };
  }, 'write');
}

/** A read, and a write that repairs a derived index, refuse a database another schema genesis wrote; a write opens it as it stands. */
type DbMode = 'read' | 'repair' | 'write';

function openLocalDb(name: string, mode: DbMode): SqliteDb {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
  const db = mode === 'read' ? new Database(dbPath, { readonly: true }) : new Database(dbPath);

  if (mode === 'write') return db;
  const genesis = schemaGenesisOf(db);

  if (genesis !== SCHEMA_GENESIS.slice(0, 7)) db.close();
  requireGenesis(`Workspace "${name}"`, genesis);

  return db;
}

function readMainActorTable<T>(name: string, table: string, absent: T, read: (sql: SqlExecutor, actor: ActorHandle) => T): T {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, table)) return absent;
    const sql = makeSql(db);

    return read(sql, openWorkspaceMainActor(sql));
  });
}

function withLocalDb<T>(name: string, fn: (db: SqliteDb) => T): T {
  const db = openLocalDb(name, 'read');

  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Closes only after the callback settles: `TriggerRegistry` mutators await the alarm seam. */
async function withLocalDbAsync<T>(name: string, fn: (db: SqliteDb) => T | Promise<T>, mode: DbMode = 'read'): Promise<T> {
  const db = openLocalDb(name, mode);

  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function all<T>(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.prepare<T, SQLQueryBindings[]>(sql).all(...params);
}

function countOf(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): number {
  return all<{ c: number }>(db, sql, ...params).at(0)?.c ?? 0;
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
function requireMainActor(db: SqliteDb): ActorHandle {
  const actor = mainActor(db);

  if (!actor) throw new KinuError('missing', 'This workspace database has no durable identity to read as.');

  return actor;
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
  return withLocalDb(name, (db) => {
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
  });
}

export function readLocalWorkspaceWork(name: string): WorkspaceWork {
  return withLocalDb(name, (db) => {
    const directory = actorDirectory(db);

    return directory === null
      ? { plans: [], tasks: [] }
      : readWorkspaceWork(makeSql(db), directory.main(), directory.list({ retired: true }));
  });
}

/** Reads by id only, starting nothing; retired actors have no handle. Null for an id this workspace never issued. */
export function getLocalActorInfo(name: string, actorId: string): LocalAgentInfoSnapshot | null {
  return withLocalDb(name, (db) => {
    const directory = actorDirectory(db);
    const row = directory?.retained(actorId) ?? null;

    if (!row) return null;

    const assertCurrent = () => {
      if (!directory?.retained(actorId)) throw new Error(`actor ${actorId} is no longer retained in this workspace`);
    };

    const config = tableExists(db, 'actor_config') ? createAgentConfigStore(makeSql(db), actorId, assertCurrent) : null;

    return {
      name: row.name,
      purpose: '',
      scaffoldVersion: tableExists(db, 'scaffold_versions') ? getCurrentScaffoldVersion(makeSql(db), { actorId, assertCurrent }) ?? 0 : 0,
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
  });
}

/** The cloud's status fold (`agentStatusFacts`), over SOUL.md where it lies in the workspace's space. */
function getLocalStatus(db: SqliteDb): LocalStatus {
  const actor = mainActor(db);

  if (actor === null) {
    return { name: null, purpose: '', createdAt: null, scaffoldVersion: 0, searchNodeCount: 0, messageCount: 0, model: null, reasoningEffort: null };
  }

  const { name, purpose, createdAt, scaffoldVersion, searchNodeCount, messageCount } = agentStatusFacts(makeSql(db), actor, soulOf(db), actor.name);

  return {
    name, purpose, createdAt, scaffoldVersion, searchNodeCount, messageCount,
    model: actor.config.getModel(), reasoningEffort: actor.config.getReasoningEffort(),
  };
}

function getLocalToolSummary(db: SqliteDb): LocalToolSummary {
  return { builtIn: BUILTIN_TOOLS, crafted: localCraftedTools(db), executors: listLocalExecutors() };
}

const NOOP_ALARM: AlarmScheduler = {
  async scheduleAt() {},
};

