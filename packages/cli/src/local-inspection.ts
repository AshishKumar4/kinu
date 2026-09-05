import { existsSync } from 'node:fs';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  createReleaseStore,
  BackgroundJobStore,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOLS,
  EventLog,
  HeadJournal,
  MctsSearchStore,
  RunEventRecorder,
  TriggerRegistry,
  type AlarmScheduler,
  createAgentConfigStore,
  createFactsStore,
  initEventsHubTables,
  initAgentConfigTable,
  alignmentConvergence,
  calibrationReport,
  createCompletionLLM,
  ensembleReport,
  getChatHistoryPage,
  getEvolutionChangelog,
  ingestOutcomeLabels,
  initTurnOutcomeTables,
  listGepaRuns,
  listRuns,
  listScaffoldVersions,
  loadGepaCandidates,
  nextCronFire,
  releaseSqlFromExec,
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
  type ReleaseBoard,
  type RunEvent,
  type ScaffoldVersionView,
  readSearchNodeDetail,
  type SearchNode,
  type SearchNodeDetail,
  type TriggerRow,
  type MctsSearchRunSummary,
  type ReasoningEffort,
  reconcileColumns,
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
} from '@kinu.run/core';
import { classify } from '@kinu.run/core/obs';
import {
  makeSql, makeSqlExec, createHostShell, hostToolchainCapabilities,
  type LocalModelResolver,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';
import { agentDbPath } from './config';
import { createConfiguredLocalModelResolver } from './local-model-resolver';

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
  kind: 'workspace' | 'laptop';
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
  release: ReleaseBoard;
}

export function getLocalAgentState(name: string): LocalAgentState {
  return withLocalDb(name, (db) => ({
    status: getLocalStatus(db),
    tools: getLocalToolSummary(db),
    memoryContent: readLocalMemory(name),
    mcts: listLocalMcts(name),
    timeline: listLocalTimeline(name, 250),
    executors: listLocalExecutors(),
    release: getLocalReleaseBoard(name, 20),
  }));
}

/**
 * What this local workspace spent, on both axes, from the same read model the
 * cloud panel renders — never a second query written here.
 *
 * No window on either surface: `workspaceSpend` sums the whole log, so the two
 * answer the same question about the same rows by construction rather than by
 * both being handed the same bound.
 */
export function getLocalWorkspaceSpend(name: string): WorkspaceSpend {
  return withLocalDb(name, (db) => {
    const sql = makeSql(db);
    return workspaceSpend({ events: new RunEventRecorder(sql), sql });
  });
}

export function getLocalAgentInfo(name: string): LocalAgentInfoSnapshot {
  return withLocalDb(name, (db) => {
    const status = getLocalStatus(db);
    return {
      name: status.name ?? name,
      purpose: status.purpose,
      soul: status.soul,
      scaffoldVersion: status.scaffoldVersion,
      craftedToolCount: status.craftedToolCount,
      searchNodeCount: status.searchNodeCount,
      taskCount: tableExists(db, 'task_history')
        ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM task_history`)?.c ?? 0
        : 0,
      // Not reported: it is a walk of the workspace filesystem, and this path
      // may not open one (see getLocalStatus).
      memorySize: 0,
      createdAt: status.createdAt ?? 0,
      conversationCount: tableExists(db, 'messages')
        ? get<{ c: number }>(db, `SELECT COUNT(DISTINCT session_id) AS c FROM messages`)?.c ?? 0
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
    if (!tableExists(db, 'agent_config')) {
      return { roleId: 'general', assignedTier: null };
    }
    const config = createAgentConfigStore(makeSql(db));
    const selection = config.getRoleSelection();
    return {
      roleId: selection.kind === 'catalog' ? selection.roleId : 'general',
      assignedTier: config.getAssignedTier(),
    };
  });
}


/**
 * The curated memory document, reassembled from its indexed chunks.
 *
 * `memory_chunks` is MemoryStore's index OF `memory/MEMORY.md` — the same text,
 * in a table this read-only path can open. Reading the file itself would mean
 * opening the workspace filesystem, which writes; see getLocalStatus.
 */
export function readLocalMemory(name: string): string {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'memory_chunks')) return '';
    const cols = columnSet(db, 'memory_chunks');
    const column = cols.has('text') ? 'text' : cols.has('content') ? 'content' : null;
    if (!column) return '';
    const order = cols.has('start_line') ? 'start_line' : 'rowid';
    return all<{ body: string }>(
      db,
      `SELECT ${safeIdentifier(column)} AS body FROM memory_chunks
       WHERE path = 'memory/MEMORY.md' ORDER BY ${safeIdentifier(order)} ASC`,
    ).map((row) => row.body).join('\n');
  });
}

/**
 * `limit` is a user CLI flag (`--limit`, via `numberField`) and reaches a raw
 * `LIMIT ?` on both branches below, so it is closed to a finite positive integer
 * first: SQLite reads `LIMIT -1` as no limit and rejects a fraction or NaN as a
 * datatype mismatch. Validity only — no ceiling is imposed, because this surface
 * has never had one and a recall read the operator asked to widen should widen.
 */
export function searchLocalMemory(name: string, query: string, limit = 10): Array<{ path: string; text: string; score?: number; startLine?: number; endLine?: number }> {
  const q = query.trim();
  if (!q) return [];
  const window = boundedInt(limit, 10, 1, Number.MAX_SAFE_INTEGER);
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'memory_chunks')) return [];
    const cols = columnSet(db, 'memory_chunks');
    if (cols.has('text')) {
      return all<{ path: string; text: string; score?: number; start_line?: number; end_line?: number }>(
        db,
        `SELECT path, text, start_line, end_line FROM memory_chunks WHERE text LIKE ? ORDER BY updated_at DESC LIMIT ?`,
        `%${q}%`,
        window,
      ).map((row) => ({ path: row.path, text: row.text, score: row.score, startLine: row.start_line, endLine: row.end_line }));
    }
    if (cols.has('content')) {
      return all<{ path: string; content: string }>(
        db,
        `SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?`,
        `%${q}%`,
        window,
      ).map((row) => ({ path: row.path, text: row.content }));
    }
    return [];
  });
}

export function listLocalEvents(name: string, opts: { variant?: string; since?: number; limit?: number } = {}): KinuEvent[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'agent_log')) return [];
    const filter: QueryFilter = { limit: opts.limit ?? 50 };
    if (opts.variant) filter.variant = v.parse(EventVariantSchema, opts.variant);
    if (opts.since) filter.since = opts.since;
    return new EventLog(hubSql(db)).query(filter);
  });
}

/** Recent runs from the durable run-event log — the local peer of the cloud
 *  `listRuns` RPC. One page; `kinu inspect` prints a window, not a walk. */
export function listLocalRuns(name: string, limit = 50): RunListEntry[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'run_events')
      ? [...listRuns(new RunEventRecorder(makeSql(db)), null, limit).items]
      : []
  ));
}

/** One run's durable events, oldest first — the local peer of `getRunEvents`.
 *  `since` is the inclusive lower bound an SSE resume replays from. */
export function listLocalRunEvents(
  name: string, runId: string, opts: { since?: number; limit?: number } = {},
): RunEvent[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'run_events') ? new RunEventRecorder(makeSql(db)).read(runId, opts) : []
  ));
}

/**
 * The LOCAL peer of core's `getRunTimeline`, and bounded the same way. `limit`
 * is a user CLI flag (`kinu inspect timeline --limit`), and below it reaches
 * three raw `LIMIT ?` binds plus a tail slice — so `--limit -1` read three whole
 * tables and `--limit abc` bound NaN. Its default stays 100, which is what the
 * command has always shown; only the ceiling is shared with the cloud peer.
 */
export function listLocalTimeline(name: string, limit = 100): JsonObject[] {
  const window = boundedInt(limit, 100, 1, RUN_TIMELINE_MAX);
  return withLocalDb(name, (db) => {
    const rows: JsonObject[] = [];
    // The durable run-event log of the most recent run — tool calls, steps and
    // turn boundaries. The cloud timeline spine leads with the same source.
    if (tableExists(db, 'run_events')) {
      const recorder = new RunEventRecorder(makeSql(db));
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
    if (tableExists(db, 'evolution_events')) {
      rows.push(...all<{ id: string; type: string; message: string; data: string | null; created_at: number }>(
        db,
        `SELECT id, type, message, data, created_at
         FROM evolution_events
         ORDER BY created_at DESC
         LIMIT ?`,
        window,
      ).map((row) => ({
        id: row.id,
        kind: `evolution:${row.type}`,
        message: row.message,
        data: parseJson(row.data),
        ts: row.created_at,
      })));
    }
    if (tableExists(db, 'search_nodes')) {
      rows.push(...all<{ id: string; action: string; value: number; status: string; created_at: number }>(
        db,
        `SELECT id, action, value, status, created_at
         FROM search_nodes
         ORDER BY created_at DESC
         LIMIT ?`,
        window,
      ).map((row) => ({
        id: row.id,
        kind: 'mcts',
        label: row.action,
        score: row.value,
        status: row.status,
        ts: row.created_at,
      })));
    }
    return rows.sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, window);
  });
}

/** Every search_nodes row this workspace ever wrote, across every search — the
 *  debugging read `kinu inspect mcts` serves with no node id. Core's scoped
 *  projections (readSearchTree, readLatestSearchTree) answer one search; this
 *  deliberately answers all of them. */
export function listLocalMcts(name: string): SearchNode[] {
  return withLocalDb(name, (db) => tableExists(db, 'search_nodes')
    ? all<SearchNode>(
      db,
      `SELECT id, parent_id, root_id, task, action, observation, code_used, visits, value, depth,
              status, msg_id, branch_agent_key, created_at
       FROM search_nodes
       ORDER BY depth, created_at`,
    )
    : []);
}

/** Local peer of the cloud `getMctsSearchRuns` RPC — the mcts_search_runs
 *  ledger, newest-updated first. */
export function listLocalMctsSearchRuns(name: string, limit = 20): MctsSearchRunSummary[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'mcts_search_runs') ? new MctsSearchStore(makeSql(db)).list(limit) : []
  ));
}

/**
 * Local peers of the three record RPCs — the CUMULATIVE half of exploration.
 *
 * The trees above are per-run; `exploration_records` is what survived across
 * runs, and it had no local read path at all. Guarded on the table existing for
 * the same reason `listLocalMcts` is: a workspace created before it was part of
 * the shared schema has no such table, and that is an absence rather than a
 * failure. The read models themselves work over any `SqlExecutor`.
 */
export function listLocalRecordObjectives(name: string, limit = 20): RecordObjectiveSummary[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'exploration_records')
      ? [...listRecordObjectives(makeSql(db), null, limit).items]
      : []
  ));
}

export function listLocalRecordCells(
  name: string, handle: RecordObjectiveHandle, limit = 50,
): RecordCellSummary[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'exploration_records')
      ? [...listRecordCells(makeSql(db), handle, null, limit).items]
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
      ? readRecordCell(makeSql(db), handle, cursor, limit)
      : { status: 'end', items: [] }
  ));
}

/** Local peer of the cloud `getMctsNodeDetail` RPC. The projection itself is
 *  core's (read-models/search-tree.ts), so `kinu inspect mcts <id>` formats
 *  one shape whichever target answered. */
export function getLocalMctsNode(name: string, nodeId: string): SearchNodeDetail | null {
  return withLocalDb(name, (db) => (
    tableExists(db, 'search_nodes') ? readSearchNodeDetail(makeSql(db), nodeId) : null
  ));
}

export function listLocalHeads(name: string, limit = 20): HeadRunView[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'head_journal')) return [];
    return new HeadJournal(makeSql(db)).listRuns(limit);
  });
}

export function listLocalGepaRuns(name: string, limit = 20): GepaRunSummary[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return [];
    return listGepaRuns(makeSql(db), limit);
  });
}

/** Local peer of the cloud `getChatHistoryPage` RPC — the newest page, which
 *  is what `kinu debug messages --limit` is asking for. The read model
 *  itself (core status.ts) works over any SqlExecutor.
 *
 *  The read selects the provenance column by name, so a workspace created
 *  before it existed is reconciled here first — this is the one reader that
 *  opens the database without running `initWorkspaceSchema`, and "no such
 *  column" on a diagnostic read of an old workspace is a self-inflicted
 *  failure, not information. */
export async function getLocalChatHistory(name: string, limit = 100): Promise<ChatHistoryEntry[]> {
  return withLocalWritableDb(name, (db) => {
    if (tableExists(db, 'messages')) {
      reconcileColumns(makeSql(db), (ddl) => { db.exec(ddl); }, 'messages', { metadata: 'TEXT' });
    }
    return [...getChatHistoryPage(makeSql(db), { limit }).items];
  });
}

/** Local peer of the cloud `getEvolutionChangelog` RPC. */
export function getLocalChangelog(name: string, limit = 50): EvolutionChangelogView {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'agent_config')) initAgentConfigTable((ddl) => { db.exec(ddl); });
    return getEvolutionChangelog(createAgentConfigStore(makeSql(db)), makeSql(db), limit);
  });
}

/** Local peer of the cloud `listScaffoldVersions` RPC. */
export function getLocalScaffoldVersions(name: string, limit = 20): ScaffoldVersionView[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'scaffold_versions') ? listScaffoldVersions(makeSql(db), limit) : []
  ));
}

/** Local peer of the cloud `getFacts` RPC. */
export function getLocalFacts(name: string, limit = 100): Array<{
  key: string; value: unknown; confidence: number; source: string; lastObservedAt: number;
}> {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'agent_facts')) return [];
    return createFactsStore(makeSql(db)).recentTopK(limit).map((f) => ({
      key: f.key, value: f.value, confidence: f.confidence, source: f.source, lastObservedAt: f.lastObservedAt,
    }));
  });
}

/** K_align for a local agent. A workspace with no outcome ledger yet reads as
 *  an empty result — alignmentConvergence already owns that case. */
export function getLocalAlignment(name: string): AlignmentConvergence {
  return withLocalDb(name, (db) => alignmentConvergence(makeSql(db)));
}

/** What the hand labels establish about this agent's outcome classifier, and
 *  the corrected rates they buy. Reads "uncalibrated" until labels exist. */
export function getLocalCalibration(name: string): CalibrationReport {
  return withLocalDb(name, (db) => calibrationReport(makeSql(db)));
}

/** Draw the next calibration set for a local agent. */
export function sampleLocalLabeling(name: string, size: number): LabelingItem[] {
  return withLocalDb(name, (db) => sampleForLabeling(makeSql(db), { size }));
}

/** Store a labeling pass. The ledger's tables are ensured first: a workspace
 *  can predate the label table without ever having run a turn since. */
export async function recordLocalOutcomeLabels(
  name: string,
  input: { labeler: string; labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }> },
): Promise<LabelIngestResult> {
  return withLocalWritableDb(name, (db) => {
    const sql = makeSql(db);
    initTurnOutcomeTables((ddl) => { db.exec(ddl); }, sql);
    return ingestOutcomeLabels(sql, input);
  });
}

/** How the LLM panel scored against the owner's own labels, and whether it
 *  cleared the bar to stand in for them. Reads "not run" until it has. */
export function getLocalEnsemble(name: string): EnsembleReport {
  return withLocalDb(name, (db) => ensembleReport(makeSql(db)));
}

/** One judge from one spec: normalize, then resolve the model behind it. The
 *  calibration panel and the corpus eval both need exactly this, and this is the
 *  resolution step that costs credentials — which is why the panel hands it to
 *  `runEnsemble` as a callback rather than calling it up front. */
function localJudge(resolver: LocalModelResolver, named: string): EnsembleJudge {
  const spec = resolver.normalizeSpecSync(named);
  return { spec, llm: createCompletionLLM({ model: resolver.resolveModel(spec), spec, stage: 'judge' }) };
}

/**
 * Put a local agent's hand-labeled turns to the panel — one blind pass per
 * judge. Judges are the models the owner named, else one per available vendor
 * family other than the chat model's: core's `selectEnsembleJudges`, over the
 * same candidate list the DO backend walks.
 *
 * The database is held open for the whole pass rather than per judge, because
 * each judge's verdicts are written as they land: a run interrupted halfway
 * keeps the model calls it already paid for, and the next run tops up.
 */
export async function runLocalOutcomeEnsemble(
  name: string,
  specs: string[] | null,
): Promise<EnsembleRunResult> {
  ensureLocalAgent(name);
  const db = new Database(agentDbPath(name));
  try {
    const sql = makeSql(db);
    initTurnOutcomeTables((ddl) => { db.exec(ddl); }, sql);
    // Two stages, because they have different costs: choosing the judges is a
    // read over the provider catalog, while resolving one into an LLM reaches the
    // signed-in session and the stored keys. `runEnsemble` asks for the specs
    // only once it knows there are hand labels, and for a judge only once the
    // panel is big enough to run — so a workspace with no labels, or a
    // one-model panel, is told that rather than told it is unauthenticated.
    const { resolver } = createConfiguredLocalModelResolver({ agentName: name });
    return await runEnsemble(sql, {
      specs: async () => (await selectEnsembleJudges({
        specs,
        chatSpec: () => resolver.normalizeSpecSync(createAgentConfigStore(sql).getModel()),
        candidates: () => resolver.judgeCandidates(),
      })).specs,
      judge: (named) => localJudge(resolver, named),
    });
  } finally {
    db.close();
  }
}

/**
 * Score the classifier and the judge panel over a mined behavioural corpus.
 *
 * The panel is chosen exactly as `runLocalOutcomeEnsemble` chooses it, and the
 * classifier runs on the agent's own chat model — the model production would
 * have classified those turns with. Nothing is written to the agent's ledger:
 * the corpus is not this agent's history, and a row claiming otherwise would
 * corrupt the very calibration this is meant to complement.
 */
export async function runLocalCorpusEval(name: string, input: {
  turns: ReadonlyArray<CorpusTurn>;
  labels: ReadonlyArray<WeakLabel>;
  specs: string[] | null;
}): Promise<CorpusEvalReport> {
  ensureLocalAgent(name);
  const { resolver } = createConfiguredLocalModelResolver({ agentName: name });
  const chatSpec = resolver.normalizeSpecSync(
    withLocalDb(name, (db) => createAgentConfigStore(makeSql(db)).getModel()),
  );
  const selection = await selectEnsembleJudges({
    specs: input.specs,
    chatSpec: () => chatSpec,
    candidates: () => resolver.judgeCandidates(),
  });
  const judges = selection.specs.map((named) => localJudge(resolver, named));
  return runCorpusEval({
    turns: input.turns,
    labels: input.labels,
    classifier: {
      name: `${chatSpec} (turn-outcome classifier)`,
      llm: createCompletionLLM({ model: resolver.resolveModel(chatSpec), spec: chatSpec, stage: 'chat' }),
    },
    judges,
  });
}

export interface LocalGepaRunDetail {
  run: GepaRunSummary;
  candidates: GepaCandidate[];
}

export function getLocalGepaRun(name: string, runId: string): LocalGepaRunDetail | null {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return null;
    const sql = makeSql(db);
    const run = listGepaRuns(sql, 250).find((candidate) => candidate.runId === runId) ?? null;
    return run ? { run, candidates: loadGepaCandidates(sql, runId) } : null;
  });
}

export function listLocalExecutors(): LocalExecutorInfo[] {
  return [
    {
      name: 'workspace',
      kind: 'workspace',
      status: 'connected',
      capabilities: ['shell', 'fs', 'memory', 'craft'],
    },
    {
      name: 'laptop',
      kind: 'laptop',
      status: 'connected',
      // The same probe the live provider declares from, not a copy of its row:
      // this listing is what `kinu inspect` shows for the machine it is
      // running on, so a hardcoded `git`/`npm` here would contradict the row the
      // agent is actually given.
      capabilities: [...hostToolchainCapabilities()],
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
    if (!tableExists(db, 'triggers')) return { triggers: [] };
    return { triggers: new TriggerRegistry(hubSql(db), NOOP_ALARM).list() };
  });
}

export async function cancelLocalTrigger(name: string, id: string): Promise<{ changed: boolean }> {
  return withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'triggers')) return { changed: false };
    return { changed: new TriggerRegistry(hubSql(db), NOOP_ALARM).revoke(id, Date.now()) };
  });
}

export async function createLocalTimerTrigger(name: string, input: { cron?: string; atMs?: number; label?: string }): Promise<TriggerRow | null> {
  return withLocalWritableDb(name, async (db) => {
    initEventsHubTables(hubSql(db));
    const now = Date.now();
    const registry = new TriggerRegistry(hubSql(db), NOOP_ALARM);
    const nextFireAt = input.cron
      ? nextCronFire(input.cron, now)
      : input.atMs;
    if (input.cron && nextFireAt === null) throw new Error(`Unsupported cron expression: ${input.cron}`);
    if (!nextFireAt) throw new Error('A future trigger time is required.');
    const spec: JsonObject = {};
    if (input.cron) spec.cron = input.cron;
    else spec.atMs = nextFireAt;
    if (input.label) spec.label = input.label;
    const id = await registry.register({
      kind: input.cron ? 'timer_cron' : 'timer_oneshot',
      spec,
      creator_trust: 'owner',
      next_fire_at: nextFireAt,
    }, now);
    return registry.get(id);
  });
}

export function listLocalJobs(name: string, limit = 20): BackgroundJob[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return [];
    return new BackgroundJobStore(makeSql(db)).list(limit);
  });
}

export async function cancelLocalJob(name: string, id: string): Promise<{ ok: boolean }> {
  return withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return { ok: false };
    const store = new BackgroundJobStore(makeSql(db));
    const before = store.get(id);
    if (!before || before.status !== 'running') return { ok: false };
    store.cancel(id, before.epoch, Date.now());
    return { ok: true };
  });
}

export async function executeLocalExecutor(name: string, executorId: string, command: string): Promise<LocalExecResult> {
  ensureLocalAgent(name);
  const normalized = executorId.toLowerCase();
  if (!['workspace', 'laptop', 'local', 'your-pc'].includes(normalized)) {
    throw new Error(`Executor "${executorId}" is not available for local agents.`);
  }
  // The one host-shell implementation: it owns the process contract (group
  // kill on abort, and settling when the COMMAND exits rather than when a
  // backgrounded grandchild finally closes the inherited pipe).
  const result = await createHostShell(process.cwd()).exec(command);
  return { executor: executorId, command, ...result };
}

export function getLocalReleaseBoard(name: string, limit = 20): ReleaseBoard {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'release_sources') || !tableExists(db, 'release_changes')) {
      return { bindings: [], changes: [], checks: [], approvals: [], deployments: [] };
    }
    const store = createReleaseStore(releaseSqlFromExec(hubSql(db)));
    return store.board(name, limit);
  });
}

export async function markLocalBackgroundJobsCancelled(name: string): Promise<string[]> {
  return withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return [];
    const rows = all<{ id: string }>(
      db,
      `SELECT id FROM background_jobs WHERE status = 'running' ORDER BY created_at DESC`,
    );
    db.run(
      `UPDATE background_jobs
       SET status = 'cancelled', error = 'cancelled by operator', settled_at = ?
       WHERE status = 'running'`,
      [Date.now()],
    );
    return rows.map((row) => row.id);
  });
}

function withLocalDb<T>(name: string, fn: (db: SqliteDb) => T): T {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Workspace "${name}" not found. Create it with: kinu create ${name}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Writable handle, closed only once the callback's result has settled. The
 *  callback may be async: `TriggerRegistry`'s mutators await the host's alarm
 *  seam, and a `finally { db.close() }` that fired at the first suspension
 *  point would hand the rest of the callback a closed database. */
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

function get<T>(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): T | null {
  return db.prepare<T, SQLQueryBindings[]>(sql).get(...params);
}

function tableExists(db: SqliteDb, name: string): boolean {
  const row = get<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1`,
    name,
  );
  return Boolean(row);
}

function columnSet(db: SqliteDb, table: string): Set<string> {
  return new Set(all<{ name: string }>(db, `PRAGMA table_info(${safeIdentifier(table)})`).map((row) => row.name));
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function getLocalStatus(db: SqliteDb): LocalStatus {
  // `agent_identity` is the pre-rename table. Read it here rather than adopting
  // it: this path is READ-ONLY, and the adoption belongs to the write-capable
  // open path (identity/schema.ts adoptLegacyAgentIdentity).
  const identityTable = tableExists(db, 'workspace_identity') ? 'workspace_identity'
    : tableExists(db, 'agent_identity') ? 'agent_identity'
      : null;
  const identity = identityTable
    ? get<{ name: string; created_at: number }>(
      db, `SELECT name, created_at FROM ${safeIdentifier(identityTable)} LIMIT 1`)
    : null;
  // The MISSION, off the identity row — not SOUL.md itself.
  //
  // This inspection opens the database READ-ONLY, and reading the document
  // means opening the workspace filesystem, which writes (it seeds its base
  // directories and advances the process-generation counter on every open). A
  // listing that mutated every workspace it walked past would be wrong twice
  // over, so `writeSoul` keeps this one line current instead (identity/soul.ts).
  // `mission` was added to this table AFTER it shipped, so an older workspace
  // does not have the column. `reconcileColumns` (identity/schema.ts:163) adds
  // it — but only on the OPEN path, and this inspection is deliberately
  // read-only per the note above, so it can never have run here. Ask, do not
  // assume: three of the owner's real local workspaces reported
  // `(error reading)` in `kinu list` because this line selected a column
  // that only a write would have created, and the caller discarded the cause.
  const mission = identityTable && columnSet(db, identityTable).has('mission')
    ? get<{ mission: string | null }>(db, `SELECT mission FROM ${safeIdentifier(identityTable)} LIMIT 1`)?.mission?.trim() || null
    : null;
  return {
    name: identity?.name ?? null,
    purpose: mission ?? '',
    soul: '',
    createdAt: identity?.created_at ?? null,
    // The LIVE version — the one that actually drives a turn. MAX(version)
    // reported an unresolved pending proposal as though it were already running.
    scaffoldVersion: tableExists(db, 'scaffold_versions')
      ? get<{ v: number }>(db,
        `SELECT version AS v FROM scaffold_versions WHERE status = 'current' ORDER BY version DESC LIMIT 1`)?.v ?? 0
      : 0,
    searchNodeCount: tableExists(db, 'search_nodes')
      ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM search_nodes`)?.c ?? 0
      : 0,
    craftedToolCount: tableExists(db, 'crafted_tools')
      ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM crafted_tools`)?.c ?? 0
      : 0,
    messageCount: tableExists(db, 'messages')
      ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM messages`)?.c ?? 0
      : 0,
    model: tableExists(db, 'agent_config')
      ? get<{ value: string | null }>(db, `SELECT value FROM agent_config WHERE key = 'model' LIMIT 1`)?.value ?? null
      : null,
    reasoningEffort: tableExists(db, 'agent_config')
      ? createAgentConfigStore(makeSql(db)).getReasoningEffort()
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


/** Inspection reads and writes a workspace's database with no session behind it,
 *  so there is no host to wake and nothing to arm. */
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
