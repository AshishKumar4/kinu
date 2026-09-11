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
  openWorkspaceMainActor,
  WorkspaceActorDirectory,
  createAgentConfigStore,
  type ActorHandle,
  type WorkspaceActor,
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
  releaseSqlFromExec,
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
  type ReleaseBoard,
  type RunEvent,
  type ScaffoldVersionView,
  readSearchNodeDetail,
  type SearchNode,
  type SearchNodeDetail,
  type TriggerRow,
  type TimerTrigger,
  type MctsSearchRunSummary,
  type ReasoningEffort,
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
    const actor = openWorkspaceMainActor(sql);

    return workspaceSpend({ events: new RunEventRecorder(sql, actor), sql, actor });
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
        ? get<{ c: number }>(
          db, `SELECT COUNT(*) AS c FROM task_history WHERE actor_id = ?`, actor.actorId,
        )?.c ?? 0
        : 0,
      // Not reported: it is a walk of the workspace filesystem, and this path
      // may not open one (see getLocalStatus).
      memorySize: 0,
      createdAt: status.createdAt ?? 0,
      conversationCount: actor && tableExists(db, 'messages')
        ? get<{ c: number }>(
          db, `SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE actor_id = ?`, actor.actorId,
        )?.c ?? 0
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
      return { roleId: 'general', assignedTier: null };
    }

    const config = openWorkspaceMainActor(makeSql(db)).config;

    return {
      roleId: config.getRoleSelection(),
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
    return all<{ text: string }>(
      db,
      `SELECT text FROM memory_chunks WHERE path = 'memory/MEMORY.md' ORDER BY start_line ASC`,
    ).map((row) => row.text).join('\n');
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

/** Recent runs from the durable run-event log — the local peer of the cloud
 *  `listRuns` RPC. One page; `kinu inspect` prints a window, not a walk. */
export function listLocalRuns(name: string, limit = 50): RunListEntry[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'run_events')) return [];
    const sql = makeSql(db);

    return [...listRuns(new RunEventRecorder(sql, openWorkspaceMainActor(sql)), null, limit).items];
  });
}

/** One run's durable events, oldest first — the local peer of `getRunEvents`.
 *  `since` is the inclusive lower bound an SSE resume replays from. */
export function listLocalRunEvents(
  name: string, runId: string, opts: { since?: number; limit?: number } = {},
): RunEvent[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'run_events')) return [];
    const sql = makeSql(db);

    return new RunEventRecorder(sql, openWorkspaceMainActor(sql)).read(runId, opts);
  });
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
    // WHOSE timeline. Every rail below is actor-scoped now, so the workspace's
    // MAIN actor is the one this whole-workspace read reports; another actor's
    // is reached by id through `getLocalActorInfo`.
    const actor = mainActor(db);
    const rows: JsonObject[] = [];

    // The durable run-event log of the most recent run — tool calls, steps and
    // turn boundaries. The cloud timeline spine leads with the same source.
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

/** Local peer of the cloud `getMctsSearchRuns` RPC — the mcts_search_runs
 *  ledger, newest-updated first. */
export function listLocalMctsSearchRuns(name: string, limit = 20): MctsSearchRunSummary[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'mcts_search_runs')) return [];
    const sql = makeSql(db);

    return new MctsSearchStore(sql, openWorkspaceMainActor(sql)).list(limit);
  });
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
      ? [...listRecordObjectives(makeSql(db), requireMainActor(db), null, limit).items]
      : []
  ));
}

export function listLocalRecordCells(
  name: string, handle: RecordObjectiveHandle, limit = 50,
): RecordCellSummary[] {
  return withLocalDb(name, (db) => (
    tableExists(db, 'exploration_records')
      ? [...listRecordCells(makeSql(db), requireMainActor(db), handle, null, limit).items]
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
      ? readRecordCell(makeSql(db), requireMainActor(db), handle, cursor, limit)
      : { status: 'end', items: [] }
  ));
}

/** Local peer of the cloud `getMctsNodeDetail` RPC. The projection itself is
 *  core's (read-models/search-tree.ts), so `kinu inspect mcts <id>` formats
 *  one shape whichever target answered. */
export function getLocalMctsNode(name: string, nodeId: string): SearchNodeDetail | null {
  return withLocalDb(name, (db) => (
    tableExists(db, 'search_nodes') ? readSearchNodeDetail(makeSql(db), requireMainActor(db), nodeId) : null
  ));
}

export function listLocalHeads(name: string, limit = 20): HeadRunView[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'head_journal')) return [];
    const sql = makeSql(db);

    return new HeadJournal(sql, openWorkspaceMainActor(sql)).listRuns(limit);
  });
}

export function listLocalGepaRuns(name: string, limit = 20): GepaRunSummary[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return [];
    const actor = mainActor(db);

    return actor ? listGepaRuns(makeSql(db), actor, limit) : [];
  });
}

/** Local peer of the cloud `getChatHistoryPage` RPC — the newest page, which
 *  is what `kinu debug messages --limit` is asking for. The read model
 *  itself (core status.ts) works over any SqlExecutor. */
export async function getLocalChatHistory(name: string, limit = 100): Promise<ChatHistoryEntry[]> {
  return withLocalDb(name, (db) => {
    const sql = makeSql(db);

    return [...getChatHistoryPage(sql, openWorkspaceMainActor(sql), { limit }).items];
  });
}

/** Local peer of the cloud `getEvolutionChangelog` RPC. */
export function getLocalChangelog(name: string, limit = 50): EvolutionChangelogView {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'actor_config')) initAgentConfigTable((ddl) => { db.exec(ddl); });
    const sql = makeSql(db);

    return getEvolutionChangelog(sql, openWorkspaceMainActor(sql), limit);
  });
}

/** Local peer of the cloud `listScaffoldVersions` RPC. */
export function getLocalScaffoldVersions(name: string, limit = 20): ScaffoldVersionView[] {
  return withLocalDb(name, (db) => {
    const actor = mainActor(db);

    return actor && tableExists(db, 'scaffold_versions')
      ? listScaffoldVersions(makeSql(db), actor, limit)
      : [];
  });
}

/** Local peer of the cloud `getFacts` RPC. */
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

/** K_align for a local agent. A workspace with no outcome ledger yet reads as
 *  an empty result — alignmentConvergence already owns that case. */
export function getLocalAlignment(name: string): AlignmentConvergence {
  return withLocalDb(name, (db) => alignmentConvergence(makeSql(db), requireMainActor(db)));
}

/** What the hand labels establish about this agent's outcome classifier, and
 *  the corrected rates they buy. Reads "uncalibrated" until labels exist. */
export function getLocalCalibration(name: string): CalibrationReport {
  return withLocalDb(name, (db) => calibrationReport(makeSql(db), requireMainActor(db)));
}

/** Draw the next calibration set for a local agent. */
export function sampleLocalLabeling(name: string, size: number): LabelingItem[] {
  return withLocalDb(name, (db) => sampleForLabeling(makeSql(db), requireMainActor(db), { size }));
}

/** Store a labeling pass. The ledger's tables are ensured first: a workspace
 *  can predate the label table without ever having run a turn since. */
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

/** How the LLM panel scored against the owner's own labels, and whether it
 *  cleared the bar to stand in for them. Reads "not run" until it has. */
export function getLocalEnsemble(name: string): EnsembleReport {
  return withLocalDb(name, (db) => ensembleReport(makeSql(db), requireMainActor(db)));
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
    initTurnOutcomeTables((ddl) => { db.exec(ddl); });
    // Two stages, because they have different costs: choosing the judges is a
    // read over the provider catalog, while resolving one into an LLM reaches the
    // signed-in session and the stored keys. `runEnsemble` asks for the specs
    // only once it knows there are hand labels, and for a judge only once the
    // panel is big enough to run — so a workspace with no labels, or a
    // one-model panel, is told that rather than told it is unauthenticated.
    const { resolver } = createConfiguredLocalModelResolver({ agentName: name });

    return await runEnsemble(sql, openWorkspaceMainActor(sql), {
      specs: async () => (await selectEnsembleJudges({
        specs,
        chatSpec: () => resolver.normalizeSpecSync(openWorkspaceMainActor(sql).config.getModel()),
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
    withLocalDb(name, (db) => openWorkspaceMainActor(makeSql(db)).config.getModel()),
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
    const actor = mainActor(db);

    if (!actor) return null;
    const run = listGepaRuns(sql, actor, 250).find((candidate) => candidate.runId === runId) ?? null;

    return run ? { run, candidates: loadGepaCandidates(sql, actor, runId) } : null;
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

export function listLocalJobs(name: string, limit = 20): BackgroundJob[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return [];
    const sql = makeSql(db);

    return new BackgroundJobStore(sql, openWorkspaceMainActor(sql)).list(limit);
  });
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
    // Through the store rather than one blanket UPDATE: the registry is
    // actor-private, `cancel` is fenced on the row's own epoch, and the ids
    // reported back have to be the rows this actually settled. A table-wide
    // write would also cancel a swarm node actor's jobs, which the operator
    // interrupting THIS workspace's session did not ask for and cannot see.
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

    // Newest first, the order the raw read reported and the surfaces render.
    return cancelled.reverse();
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
  return coreTableExists(makeSql(db), name);
}

/**
 * The actor whose rows a whole-workspace inspection reports, or null when the
 * database carries no durable identity yet.
 *
 * Every store this module reads — facts, the head journal, the job registry,
 * the task ledger, the scaffold pointer — is actor-private, so "show me this
 * workspace's jobs" has to name whose. The workspace's MAIN actor is that
 * answer: it is the actor a `kinu` session drives, and the real handle
 * `openWorkspaceMainActor` issues through the production directory rather than
 * a stand-in.
 *
 * Every OTHER actor of this workspace — a hire, an ask-by-role temporary, a
 * head, a swarm node — lives in this same database and is reachable by id
 * through {@link listLocalActors} and {@link getLocalActorInfo}, retired ones
 * included. That is the whole of what one database buys an inspector: nothing
 * has to be opened, mounted or started to read what an actor did.
 *
 * A count taken without the predicate sums over strangers, and
 * `status = 'current'` would name whichever actor promoted last. Null when
 * there is no identity: such a database owns no actor-scoped rows either, so
 * zero is the honest answer rather than a total over rows nobody claims.
 */
function mainActor(db: SqliteDb): ActorHandle | null {
  return tableExists(db, 'workspace_identity') ? openWorkspaceMainActor(makeSql(db)) : null;
}

/**
 * The main actor, or a refusal.
 *
 * Every actor-scoped read below needs an actor, and `tableExists` on the table
 * being read does NOT establish that the workspace has an identity to name. A
 * read that fell back to "no actor" would return another actor's rows or an
 * empty set indistinguishable from absence — and with every actor's rows in ONE
 * database, that is exactly the failure this refusal prevents. So an
 * inspection of a database with no identity row says so.
 */
function requireMainActor(db: SqliteDb): ActorHandle {
  const actor = mainActor(db);

  if (!actor) throw new KinuError('missing', 'This workspace database has no durable identity to read as.');

  return actor;
}

/** One actor of a local workspace, as its directory row records it. */
export interface LocalActorRow {
  readonly actorId: string;
  readonly name: string;
  readonly storageKey: string;
  readonly kind: WorkspaceActor['kind'];
  readonly lifetime: WorkspaceActor['lifetime'];
  readonly createdAt: number;
  readonly retired: boolean;
}

/**
 * The directory of the ONE database this workspace is, or null before it has an
 * identity to be a directory of.
 *
 * Read-only by construction: a directory answers from `workspace_actors` and
 * issues no handle here, so listing a workspace's actors starts none of them.
 */
function actorDirectory(db: SqliteDb): WorkspaceActorDirectory | null {
  if (!tableExists(db, 'workspace_actors') || !tableExists(db, 'workspace_identity')) return null;

  const identity = get<{ id: string; owner_user_id: string | null }>(
    db, `SELECT id, owner_user_id FROM workspace_identity LIMIT 1`);

  if (!identity) return null;

  return new WorkspaceActorDirectory(makeSql(db), {
    workspaceId: identity.id, ownerUserId: identity.owner_user_id ?? '',
  });
}

/**
 * Every actor this workspace holds — including retired ones, which is the
 * point.
 *
 * One database means a dismissed hire's transcript, a finished head's steps and
 * a swarm node's claims are all still here, keyed by the actor id they were
 * written under. Nothing is opened to read them.
 */
export function listLocalActors(name: string, opts: { readonly retired?: boolean } = {}): LocalActorRow[] {
  return withLocalDb(name, (db) => {
    const directory = actorDirectory(db);

    if (!directory) return [];
    // The FULL set by default. `list()`'s own default excludes retired rows, so
    // `retired` is passed explicitly on every call rather than left to that
    // default. Leaving it makes this function's headline claim false: measured
    // against a workspace holding a main, a hire, a head and one retired hire,
    // it answers three. A lister that hides retained actors reports the
    // workspace as smaller than its own archive, which is the one thing this
    // read exists to prevent.
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

/**
 * What ONE actor of this workspace did, read by its id and nothing else.
 *
 * No handle, no fence, no session: an inspection must not START the actor it is
 * reading, and a retired actor has no handle to be issued anyway. So the
 * directory row supplies the identity, `actor_id` supplies every count, and the
 * config store is bound to the id with a validator that asks only whether the
 * row is still retained. Null for an id this workspace never issued.
 */
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
        ? get<{ v: number }>(db,
          `SELECT version AS v FROM scaffold_versions
           WHERE actor_id = ? AND status = 'current' ORDER BY version DESC LIMIT 1`,
          actorId)?.v ?? 0
        : 0,
      // Both were hardcoded `0` with no reason given, under a doc claiming
      // "`actor_id` supplies every count" — measured against a workspace with a
      // node and a tool in it, they reported nothing was there.
      //
      // The two are counted DIFFERENTLY on purpose. `crafted_tools` is one
      // catalog per workspace (identity/schema.ts), so this is the catalog's
      // size and not this actor's slice of it; `search_nodes` is actor-scoped,
      // so a node belongs to the actor that opened it and reading it unscoped
      // would report a sibling's search as this actor's.
      craftedToolCount: tableExists(db, 'crafted_tools')
        ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM crafted_tools`)?.c ?? 0
        : 0,
      searchNodeCount: tableExists(db, 'search_nodes')
        ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM search_nodes WHERE actor_id = ?`, actorId)?.c ?? 0
        : 0,
      taskCount: tableExists(db, 'task_history')
        ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM task_history WHERE actor_id = ?`, actorId)?.c ?? 0
        : 0,
      // Not reported here for the same reason the workspace snapshot withholds
      // it: measuring it walks the workspace filesystem, and this path opens
      // the database read-only.
      memorySize: 0,
      createdAt: row.createdAt,
      conversationCount: tableExists(db, 'messages')
        ? get<{ c: number }>(db,
          `SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE actor_id = ?`, actorId)?.c ?? 0
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
    ? get<{ name: string; created_at: number }>(
      db, `SELECT name, created_at FROM workspace_identity LIMIT 1`)
    : null;

  // The MISSION, off the identity row — not SOUL.md itself.
  //
  // This inspection opens the database READ-ONLY, and reading the document
  // means opening the workspace filesystem, which writes (it seeds its base
  // directories and advances the process-generation counter on every open). A
  // listing that mutated every workspace it walked past would be wrong twice
  // over, so `writeSoul` keeps this one line current instead (identity/soul.ts).
  const mission = hasIdentity
    ? get<{ mission: string | null }>(db, `SELECT mission FROM workspace_identity LIMIT 1`)?.mission?.trim() || null
    : null;

  return {
    name: identity?.name ?? null,
    purpose: mission ?? '',
    soul: '',
    createdAt: identity?.created_at ?? null,
    // The LIVE version — the one that actually drives a turn. MAX(version)
    // reported an unresolved pending proposal as though it were already running.
    scaffoldVersion: actor && tableExists(db, 'scaffold_versions')
      ? get<{ v: number }>(db,
        `SELECT version AS v FROM scaffold_versions
         WHERE actor_id = ? AND status = 'current' ORDER BY version DESC LIMIT 1`,
        actor.actorId)?.v ?? 0
      : 0,
    searchNodeCount: actor && tableExists(db, 'search_nodes')
      ? get<{ c: number }>(db,
        `SELECT COUNT(*) AS c FROM search_nodes WHERE actor_id = ?`, actor.actorId)?.c ?? 0
      : 0,
    craftedToolCount: tableExists(db, 'crafted_tools')
      ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM crafted_tools`)?.c ?? 0
      : 0,
    messageCount: actor && tableExists(db, 'messages')
      ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM messages WHERE actor_id = ?`, actor.actorId)?.c ?? 0
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
