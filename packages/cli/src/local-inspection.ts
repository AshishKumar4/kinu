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
  unpricedLedgerSink,
  type ModelCallSink,
  TriggerRegistry,
  type AlarmScheduler,
  openWorkspaceMainActor,
  WorkspaceActorDirectory,
  createAgentConfigStore,
  type ActorHandle,
  type SqlExecutor,
  type WorkspaceActor,
  createFactsStore,
  initEventsHubTables,
  initAgentConfigTable,
  alignmentConvergence,
  calibrationReport,
  createCompletionLLM,
  ensembleReport,
  getChatHistoryPage, readSessionTranscript, CHAT_SESSION_ID,
  missingSubordinateHistory, readSubordinateInspection, SubordinateInspectionRequestSchema,
  type SubordinateInspectionRequest, type SubordinateInspectionResult,
  getEvolutionChangelog,
  ingestOutcomeLabels,
  initTurnOutcomeTables,
  listGepaRuns,
  listRuns,
  listScaffoldVersions,
  loadGepaCandidates,
  createTimerTrigger,
  tableExists as coreTableExists,
  workspaceSpend,
  runCorpusEval,
  runEnsemble,
  sampleForLabeling,
  selectEnsembleJudges,
  type AlignmentConvergence,
  type CalibrationReport,
  type BackgroundJob,
  type ChatHistoryEntry,
  type CorpusEvalReport,
  type CorpusTurn,
  type EnsembleJudge,
  type EvolutionChangelogView,
  type GepaCandidate,
  type RunListEntry,
  type GepaRunSummary,
  type HeadRunView,
  type WeakLabel,
  type EnsembleReport,
  type EnsembleRunResult,
  type LabelIngestResult,
  type LabelingItem,
  type JsonObject,
  type JsonValue,
  type TierId,
  type OutcomeLabel,
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
  type SqlExec,
  listRecordObjectives,
  listRecordCells,
  readRecordCell,
  type ExplorationRecord,
  boundedInt,
  RUN_TIMELINE_MAX,
  type Page,
  type RecordCellHandle,
  type RecordCellSummary,
  type RecordObjectiveHandle,
  type RecordObjectiveSummary,
  type SeekCursor,
  type WorkspaceSpend,
  type AccountSpend,
} from '@kinu.run/core';
import { classify } from '@kinu.run/core/obs';
import {
  makeSql, makeSqlExec, createHostShell, hostToolchainCapabilities, inspectionFiles,
  type LocalModelResolver,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';
import { agentDbPath, resolveAgentRef } from './config';
import { createConfiguredLocalModelResolver } from './local-model-resolver';
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
  soul: string;
  scaffoldVersion: number;
  craftedToolCount: number;
  searchNodeCount: number;
  taskCount: number;
  memorySize: number;
  createdAt: number;
  conversationCount: number;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

interface LocalStatus {
  name: string | null;
  purpose: string;
  soul: string;
  createdAt: number | null;
  scaffoldVersion: number;
  searchNodeCount: number;
  craftedToolCount: number;
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

export function getLocalAgentState(name: string): LocalAgentState {
  return withLocalDb(name, (db) => ({
    status: getLocalStatus(db),
    tools: getLocalToolSummary(db),
    memoryContent: readLocalMemory(name),
    mcts: listLocalMcts(name),
    timeline: listLocalTimeline(name, 250),
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
      soul: status.soul,
      scaffoldVersion: status.scaffoldVersion,
      craftedToolCount: status.craftedToolCount,
      searchNodeCount: status.searchNodeCount,
      taskCount: actor && tableExists(db, 'task_history')
        ? countOf(db, `SELECT COUNT(*) AS c FROM task_history WHERE actor_id = ?`, actor.actorId)
        : 0,
      // Needs a filesystem walk this path may not open (see getLocalStatus).
      memorySize: 0,
      createdAt: status.createdAt ?? 0,
      conversationCount: actor && tableExists(db, 'conversation_entries')
        ? countOf(
          db,
          `SELECT COUNT(DISTINCT session_id) AS c FROM conversation_entries
           WHERE actor_id = ? AND session_id != 'mcts'`,
          actor.actorId,
        )
        : 0,
      model: status.model,
      reasoningEffort: status.reasoningEffort,
    };
  });
}

export interface LocalProfileCoordinates {
  readonly roleId: string;
  readonly assignedTier: TierId | null;
}

export function getLocalProfileCoordinates(name: string): LocalProfileCoordinates {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'actor_config')) {
      return { roleId: 'task', assignedTier: null };
    }

    const config = openWorkspaceMainActor(makeSql(db)).config;

    return {
      roleId: config.getRoleSelection(),
      assignedTier: config.getAssignedTier(),
    };
  });
}

/** Reassembled from `memory_chunks`, MemoryStore's index of `memory/MEMORY.md`; opening the file would write (see getLocalStatus). */
export function readLocalMemory(name: string): string {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'memory_chunks')) return '';

    return all<{ text: string }>(
      db,
      `SELECT text FROM memory_chunks WHERE path = 'memory/MEMORY.md' ORDER BY start_line ASC`,
    ).map((row) => row.text).join('\n');
  });
}

/** `limit` is user input bound to raw `LIMIT ?`: SQLite reads -1 as unlimited and rejects NaN/fractions. Validity only, no ceiling. */
export function searchLocalMemory(name: string, query: string, limit = 10): Array<{ path: string; text: string; score?: number; startLine?: number; endLine?: number }> {
  const q = query.trim();

  if (!q) return [];
  const window = boundedInt(limit, 10, 1, Number.MAX_SAFE_INTEGER);

  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'memory_chunks')) return [];

    return all<{ path: string; text: string; start_line: number; end_line: number }>(
      db,
      `SELECT path, text, start_line, end_line FROM memory_chunks WHERE text LIKE ? ORDER BY updated_at DESC LIMIT ?`,
      `%${q}%`,
      window,
    ).map((row) => ({ path: row.path, text: row.text, startLine: row.start_line, endLine: row.end_line }));
  });
}

export function listLocalEvents(name: string, opts: { variant?: string; since?: number; limit?: number } = {}): KinuEvent[] {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'agent_log')) return [];
    const filter: QueryFilter = { limit: opts.limit ?? 50 };

    if (opts.variant) filter.variant = v.parse(EventVariantSchema, opts.variant);

    if (opts.since) filter.since = opts.since;

    return new EventLog(hubSql(db), actor).query(filter);
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

/** Local peer of core's `getRunTimeline`, sharing its ceiling; `limit` is user input bound to raw `LIMIT ?`. */
export function listLocalTimeline(name: string, limit = 100): JsonObject[] {
  const window = boundedInt(limit, 100, 1, RUN_TIMELINE_MAX);

  return withLocalDb(name, (db) => {
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
        kind: 'mcts',
        label: row.action,
        value: row.value,
        status: row.status,
        ts: row.created_at,
      })));
    }

    return rows.sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, window);
  });
}

/** Every search, deliberately; core's projections answer one. */
export function listLocalMcts(name: string): SearchNode[] {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'search_nodes')) return [];

    return all<SearchNode>(
      db,
      `SELECT id, parent_id, root_id, task, action, observation, code_used, visits, value, depth,
              status, msg_id, branch_agent_key, created_at
       FROM search_nodes
       WHERE actor_id = ?
       ORDER BY depth, created_at`,
      actor.actorId,
    );
  });
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
    const files = inspectionFiles(db, resolveAgentRef(name)?.cwd ?? null);
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
    let target = directory.main();

    for (const segment of input.path) {
      const child = directory.resolveChild(target, segment);

      if (child === null) return missingSubordinateHistory(input.path);
      target = child;
    }

    const sql = makeSql(db);
    const files = inspectionFiles(db, resolveAgentRef(name)?.cwd ?? null);

    return readSubordinateInspection({
      sql,
      raw: makeSqlExec(db),
      actor: target,
      transcriptFor: (actor) => readSessionTranscript(sql, actor, CHAT_SESSION_ID, () => Promise.resolve(files)),
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

export function getLocalAlignment(name: string): AlignmentConvergence {
  return withLocalDb(name, (db) => alignmentConvergence(makeSql(db), requireMainActor(db)));
}

export function getLocalCalibration(name: string): CalibrationReport {
  return withLocalDb(name, (db) => calibrationReport(makeSql(db), requireMainActor(db)));
}

export function sampleLocalLabeling(name: string, size: number): LabelingItem[] {
  return withLocalDb(name, (db) => sampleForLabeling(makeSql(db), requireMainActor(db), { size }));
}

/** Tables are ensured first: a workspace can predate the label table. */
export async function recordLocalOutcomeLabels(
  name: string,
  input: { labeler: string; labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }> },
): Promise<LabelIngestResult> {
  return withLocalWritableDb(name, (db) => {
    const sql = makeSql(db);
    initTurnOutcomeTables((ddl) => { db.exec(ddl); });

    return ingestOutcomeLabels(sql, openWorkspaceMainActor(sql), input);
  });
}

export function getLocalEnsemble(name: string): EnsembleReport {
  return withLocalDb(name, (db) => ensembleReport(makeSql(db), requireMainActor(db)));
}

/** Resolving costs credentials, so `runEnsemble` takes this as a callback rather than resolving up front. */
function localJudge(resolver: LocalModelResolver, named: string, report: ModelCallSink): EnsembleJudge {
  const spec = resolver.normalizeSpecSync(named);

  return {
    spec,
    llm: createCompletionLLM({ model: resolver.resolveModel(spec), spec, stage: 'judge', spend: { source: 'judge', report } }),
  };
}

/** Holds the database open for the whole pass: verdicts are written as they land, so an interrupted run keeps paid calls. */
export async function runLocalOutcomeEnsemble(
  name: string,
  specs: string[] | null,
): Promise<EnsembleRunResult> {
  ensureLocalAgent(name);
  const db = new Database(agentDbPath(name));

  try {
    const sql = makeSql(db);
    initTurnOutcomeTables((ddl) => { db.exec(ddl); });
    // Choosing judges reads the catalog; resolving one needs credentials. Deferred so a label-less workspace is told that, not "unauthenticated".
    const { resolver } = createConfiguredLocalModelResolver({ agentName: name });
    const actor = openWorkspaceMainActor(sql);
    const report = unpricedLedgerSink(new RunEventRecorder(sql, actor));

    return await runEnsemble(sql, actor, {
      specs: async () => (await selectEnsembleJudges({
        specs,
        chatSpec: () => resolver.normalizeSpecSync(actor.config.getModel()),
        candidates: () => resolver.judgeCandidates(),
      })).specs,
      judge: (named) => localJudge(resolver, named, report),
    });
  } finally {
    db.close();
  }
}

/** The corpus is not this agent's history: no outcome row is written. */
export async function runLocalCorpusEval(name: string, input: {
  turns: ReadonlyArray<CorpusTurn>;
  labels: ReadonlyArray<WeakLabel>;
  specs: string[] | null;
}): Promise<CorpusEvalReport> {
  ensureLocalAgent(name);
  const { resolver } = createConfiguredLocalModelResolver({ agentName: name });
  const db = new Database(agentDbPath(name));

  try {
    const sql = makeSql(db);
    const actor = openWorkspaceMainActor(sql);
    const report = unpricedLedgerSink(new RunEventRecorder(sql, actor));
    const chatSpec = resolver.normalizeSpecSync(actor.config.getModel());

    const selection = await selectEnsembleJudges({
      specs: input.specs,
      chatSpec: () => chatSpec,
      candidates: () => resolver.judgeCandidates(),
    });

    const judges = selection.specs.map((named) => localJudge(resolver, named, report));

    return await runCorpusEval({
      turns: input.turns,
      labels: input.labels,
      classifier: {
        name: `${chatSpec} (turn-outcome classifier)`,
        llm: createCompletionLLM({
          model: resolver.resolveModel(chatSpec), spec: chatSpec, stage: 'chat', spend: { source: 'fast', report },
        }),
      },
      judges,
    });
  } finally {
    db.close();
  }
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
    crafted: tableExists(db, 'crafted_tools')
      ? all<{ name: string; description: string }>(db, `SELECT name, description FROM crafted_tools ORDER BY name`)
      : [],
    executors: listLocalExecutors(),
  }));
}

export function listLocalTriggers(name: string): { triggers: TriggerRow[] } {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'triggers')) return { triggers: [] };

    return { triggers: new TriggerRegistry(hubSql(db), actor, NOOP_ALARM).list() };
  });
}

export async function cancelLocalTrigger(name: string, id: string): Promise<{ changed: boolean }> {
  return withLocalWritableDb(name, (db) => {
    const actor = mainActor(db);

    if (!actor || !tableExists(db, 'triggers')) return { changed: false };

    return { changed: new TriggerRegistry(hubSql(db), actor, NOOP_ALARM).revoke(id, Date.now()) };
  });
}

export async function createLocalTimerTrigger(name: string, input: { cron?: string; atMs?: number; label?: string }): Promise<TimerTrigger> {
  return withLocalWritableDb(name, (db) => {
    initEventsHubTables(hubSql(db));
    const actor = openWorkspaceMainActor(makeSql(db));

    return createTimerTrigger(new TriggerRegistry(hubSql(db), actor, NOOP_ALARM), { ...input, trust: 'owner' }, Date.now());
  });
}

export async function setLocalWorkspaceModel(name: string, spec: string): Promise<{ spec: string }> {
  const { resolver } = createConfiguredLocalModelResolver({ agentName: name });

  return withLocalWritableDb(name, (db) => setModel({
    config: openWorkspaceMainActor(makeSql(db)).config,
    normalize: (value) => resolver.normalizeSpecSync(value),
    onChanged: () => {},
  }, spec));
}

export async function setLocalWorkspaceReasoningEffort(name: string, effort: ReasoningEffort): Promise<{ effort: ReasoningEffort }> {
  return withLocalWritableDb(name, (db) => setReasoningEffort(openWorkspaceMainActor(makeSql(db)).config, effort));
}

export async function readLocalWorkspacePins(name: string): Promise<{ model: string | null; reasoningEffort: ReasoningEffort | null }> {
  return withLocalWritableDb(name, (db) => {
    const config = openWorkspaceMainActor(makeSql(db)).config;

    return { model: config.getModel(), reasoningEffort: config.getReasoningEffort() };
  });
}

export function listLocalJobs(name: string, limit = 20): BackgroundJob[] {
  return readMainActorTable(name, 'background_jobs', [], (sql, actor) => new BackgroundJobStore(sql, actor).list(limit));
}

export async function cancelLocalJob(name: string, id: string): Promise<{ ok: boolean }> {
  return withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return { ok: false };
    const sql = makeSql(db);
    const store = new BackgroundJobStore(sql, openWorkspaceMainActor(sql));
    const before = store.get(id);

    if (!before || before.status !== 'running') return { ok: false };
    store.cancel(id, before.epoch, Date.now());

    return { ok: true };
  });
}

export async function executeLocalExecutor(name: string, executorId: string, command: string): Promise<LocalExecResult> {
  ensureLocalAgent(name);
  const normalized = executorId.toLowerCase();

  if (!['workspace', 'device', 'local', 'your-pc'].includes(normalized)) {
    throw new Error(`Executor "${executorId}" is not available for local agents.`);
  }

  // createHostShell owns group kill on abort and settles when the command exits, not when a grandchild closes the pipe.
  const result = await createHostShell(process.cwd()).exec(command);

  return { executor: executorId, command, ...result };
}

export async function markLocalBackgroundJobsCancelled(name: string): Promise<string[]> {
  return withLocalWritableDb(name, (db) => {
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
  });
}

function openLocalDb(name: string): SqliteDb {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);

  return new Database(dbPath, { readonly: true });
}

function readMainActorTable<T>(name: string, table: string, absent: T, read: (sql: SqlExecutor, actor: ActorHandle) => T): T {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, table)) return absent;
    const sql = makeSql(db);

    return read(sql, openWorkspaceMainActor(sql));
  });
}

function withLocalDb<T>(name: string, fn: (db: SqliteDb) => T): T {
  const db = openLocalDb(name);

  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function withLocalDbAsync<T>(name: string, fn: (db: SqliteDb) => Promise<T>): Promise<T> {
  const db = openLocalDb(name);

  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** Closes only after the callback settles: `TriggerRegistry` mutators await the alarm seam. */
async function withLocalWritableDb<T>(name: string, fn: (db: SqliteDb) => T | Promise<T>): Promise<T> {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
  const db = new Database(dbPath);

  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function ensureLocalAgent(name: string): void {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
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
function requireMainActor(db: SqliteDb): ActorHandle {
  const actor = mainActor(db);

  if (!actor) throw new KinuError('missing', 'This workspace database has no durable identity to read as.');

  return actor;
}

export interface LocalActorRow {
  readonly actorId: string;
  readonly name: string;
  readonly storageKey: string;
  readonly kind: WorkspaceActor['kind'];
  readonly lifetime: WorkspaceActor['lifetime'];
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
      kind: row.kind,
      lifetime: row.lifetime,
      createdAt: row.createdAt,
      retired: row.retiringAt !== null || row.deletedAt !== null,
    }));
  });
}

/** Reads by id only, starting nothing; retired actors have no handle. Null for an id this workspace never issued. */
export function getLocalActorInfo(name: string, actorId: string): LocalAgentInfoSnapshot | null {
  return withLocalDb(name, (db) => {
    const directory = actorDirectory(db);
    const row = directory?.retained(actorId) ?? null;

    if (!row) return null;

    const config = tableExists(db, 'actor_config')
      ? createAgentConfigStore(makeSql(db), actorId, () => {
        if (!directory?.retained(actorId)) {
          throw new Error(`actor ${actorId} is no longer retained in this workspace`);
        }
      })
      : null;

    return {
      name: row.name,
      purpose: '',
      soul: '',
      scaffoldVersion: tableExists(db, 'scaffold_versions')
        ? currentScaffoldVersion(db, actorId)
        : 0,
      // `crafted_tools` is one catalog per workspace (identity/schema.ts); `search_nodes` is actor-scoped.
      craftedToolCount: tableExists(db, 'crafted_tools')
        ? countOf(db, `SELECT COUNT(*) AS c FROM crafted_tools`)
        : 0,
      searchNodeCount: tableExists(db, 'search_nodes')
        ? countOf(db, `SELECT COUNT(*) AS c FROM search_nodes WHERE actor_id = ?`, actorId)
        : 0,
      taskCount: tableExists(db, 'task_history')
        ? countOf(db, `SELECT COUNT(*) AS c FROM task_history WHERE actor_id = ?`, actorId)
        : 0,
      // Needs a filesystem walk; this path opens the database read-only.
      memorySize: 0,
      createdAt: row.createdAt,
      conversationCount: tableExists(db, 'conversation_entries')
        ? countOf(db,
          `SELECT COUNT(DISTINCT session_id) AS c FROM conversation_entries
           WHERE actor_id = ? AND session_id != 'mcts'`, actorId)
        : 0,
      model: config?.getModel() ?? null,
      reasoningEffort: config?.getReasoningEffort() ?? null,
    };
  });
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
    soul: '',
    createdAt: identity?.created_at ?? null,
    // The live version, not MAX(version), which would include a pending proposal.
    scaffoldVersion: actor && tableExists(db, 'scaffold_versions')
      ? currentScaffoldVersion(db, actor.actorId)
      : 0,
    searchNodeCount: actor && tableExists(db, 'search_nodes')
      ? countOf(db, `SELECT COUNT(*) AS c FROM search_nodes WHERE actor_id = ?`, actor.actorId)
      : 0,
    craftedToolCount: tableExists(db, 'crafted_tools')
      ? countOf(db, `SELECT COUNT(*) AS c FROM crafted_tools`)
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

function hubSql(db: SqliteDb): SqlExec {
  return makeSqlExec(db);
}

function parseJson(value: string | null): JsonValue {
  if (value == null) return null;

  try {
    return parseJsonValue(value);
  } catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;

    return value;
  }
}

function timestampOf(value: JsonObject): number {
  const parsed = v.safeParse(v.number(), value.ts);

  return parsed.success ? parsed.output : 0;
}
