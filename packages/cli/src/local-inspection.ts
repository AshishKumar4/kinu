import { existsSync } from 'node:fs';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  createProductChangeStore,
  BackgroundJobStore,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOLS,
  EventLog,
  HeadJournal,
  RunEventRecorder,
  TriggerRegistry,
  createAgentConfigStore,
  initAgentConfigTable,
  initEventsHubTables,
  alignmentConvergence,
  calibrationReport,
  createCompletionLLM,
  ensembleReport,
  ingestOutcomeLabels,
  initTurnOutcomeTables,
  listGepaRuns,
  loadGepaCandidates,
  nextCronFire,
  productChangeSqlFromExec,
  runCorpusEval,
  runEnsemble,
  sampleForLabeling,
  selectEnsembleJudges,
  type AlignmentConvergence,
  type CalibrationReport,
  type CorpusEvalReport,
  type CorpusTurn,
  type WeakLabel,
  type EnsembleReport,
  type EnsembleRunResult,
  type LabelIngestResult,
  type LabelingItem,
  type OutcomeLabel,
  type EventVariant,
  type ProductChangeBoard,
  type RunEvent,
  type SearchNode,
  type ReasoningEffort,
  readSoul,
  summarizeSoul,
  type SqlExec,
} from '@proteus/core';
import { makeSql, createHostShell } from '@proteus/cli-backend';
import { agentDbPath } from './config.js';
import { createConfiguredLocalModelResolver } from './local-model-resolver.js';

type SqliteDb = Database;

export interface LocalMctsNodeDetail {
  id: string;
  parentId: string | null;
  depth: number;
  visits: number;
  value: number;
  status: string;
  action: string;
  task: string;
  observation: string;
  codeUsed: string | null;
  branchAgentKey: string | null;
  msgId: string | null;
  createdAt: number;
  path: Array<Pick<LocalMctsNodeDetail, 'id' | 'parentId' | 'depth' | 'visits' | 'value' | 'status' | 'action' | 'createdAt'>>;
  children: Array<Pick<LocalMctsNodeDetail, 'id' | 'parentId' | 'depth' | 'visits' | 'value' | 'status' | 'action' | 'createdAt'>>;
}

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
  id: string;
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

export function getLocalAgentState(name: string): unknown {
  return withLocalDb(name, (db) => ({
    status: getLocalStatus(db),
    tools: getLocalToolSummary(db),
    memoryContent: readLocalMemory(name),
    mcts: listLocalMcts(name),
    timeline: listLocalTimeline(name, 250),
    executors: listLocalExecutors(),
    product: getLocalProductBoard(name, 20),
  }));
}

export function getLocalAgentInfo(name: string): LocalAgentInfoSnapshot {
  return withLocalDb(name, (db) => {
    const status = getLocalStatus(db) as {
      id: string | null;
      name: string | null;
      purpose: string;
      soul: string;
      createdAt: number | null;
      scaffoldVersion: number;
      searchNodeCount: number;
      craftedToolCount: number;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
    };
    return {
      id: status.id ?? name,
      name: status.name ?? name,
      purpose: status.purpose,
      soul: status.soul,
      scaffoldVersion: status.scaffoldVersion,
      craftedToolCount: status.craftedToolCount,
      searchNodeCount: status.searchNodeCount,
      taskCount: tableExists(db, 'task_history')
        ? get<{ c: number }>(db, `SELECT COUNT(*) AS c FROM task_history`)?.c ?? 0
        : 0,
      memorySize: tableExists(db, 'vfs_files')
        ? localMemorySize(db)
        : 0,
      createdAt: status.createdAt ?? 0,
      conversationCount: tableExists(db, 'messages')
        ? get<{ c: number }>(db, `SELECT COUNT(DISTINCT session_id) AS c FROM messages`)?.c ?? 0
        : 0,
      model: status.model,
      reasoningEffort: status.reasoningEffort,
    };
  });
}

export function readLocalMemory(name: string): string {
  return withLocalDb(name, (db) => readVfsFile(db, 'memory/MEMORY.md') ?? '');
}

export function searchLocalMemory(name: string, query: string, limit = 10): Array<{ path: string; text: string; score?: number; startLine?: number; endLine?: number }> {
  const q = query.trim();
  if (!q) return [];
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'memory_chunks')) return [];
    const cols = columnSet(db, 'memory_chunks');
    if (cols.has('text')) {
      return all<{ path: string; text: string; score?: number; start_line?: number; end_line?: number }>(
        db,
        `SELECT path, text, start_line, end_line FROM memory_chunks WHERE text LIKE ? ORDER BY updated_at DESC LIMIT ?`,
        `%${q}%`,
        limit,
      ).map((row) => ({ path: row.path, text: row.text, score: row.score, startLine: row.start_line, endLine: row.end_line }));
    }
    if (cols.has('content')) {
      return all<{ path: string; content: string }>(
        db,
        `SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?`,
        `%${q}%`,
        limit,
      ).map((row) => ({ path: row.path, text: row.content }));
    }
    return [];
  });
}

export function listLocalEvents(name: string, opts: { variant?: string; since?: number; limit?: number } = {}): unknown[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'agent_log')) return [];
    return new EventLog(hubSql(db)).query({
      ...(opts.variant ? { variant: opts.variant as EventVariant } : {}),
      ...(opts.since ? { since: opts.since } : {}),
      limit: opts.limit ?? 50,
    });
  });
}

/** Recent runs from the durable run-event log — the local peer of the cloud
 *  `listRuns` RPC. */
export function listLocalRuns(name: string, limit = 50): Array<{ runId: string; lastTs: string; eventCount: number }> {
  return withLocalDb(name, (db) => (
    tableExists(db, 'run_events') ? new RunEventRecorder(makeSql(db)).listRuns(limit) : []
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

export function listLocalTimeline(name: string, limit = 100): unknown[] {
  return withLocalDb(name, (db) => {
    const rows: unknown[] = [];
    // The durable run-event log of the most recent run — tool calls, steps and
    // turn boundaries. The cloud timeline spine leads with the same source.
    if (tableExists(db, 'run_events')) {
      const recorder = new RunEventRecorder(makeSql(db));
      const latest = recorder.listRuns(1)[0];
      if (latest) {
        rows.push(...recorder.read(latest.runId, { limit }).map((e) => ({
          id: `${e.runId}:${e.eventIndex}`,
          kind: `run:${e.type}`,
          runId: e.runId,
          payload: e,
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
        limit,
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
        limit,
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
        limit,
      ).map((row) => ({
        id: row.id,
        kind: 'mcts',
        label: row.action,
        score: row.value,
        status: row.status,
        ts: row.created_at,
      })));
    }
    return rows.sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, limit);
  });
}

export function listLocalMcts(name: string): SearchNode[] {
  return withLocalDb(name, (db) => tableExists(db, 'search_nodes')
    ? all<SearchNode>(
      db,
      `SELECT id, parent_id, task, action, observation, code_used, visits, value, depth,
              status, msg_id, branch_agent_key, created_at
       FROM search_nodes
       ORDER BY depth, created_at`,
    )
    : []);
}

export function getLocalMctsNode(name: string, nodeId: string): LocalMctsNodeDetail | null {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'search_nodes')) return null;
    const node = readMctsNode(db, nodeId);
    if (!node) return null;
    const path: LocalMctsNodeDetail['path'] = [];
    const seen = new Set<string>();
    let cursor: SearchNode | null = node;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      path.unshift(summarizeMcts(cursor));
      cursor = cursor.parent_id ? readMctsNode(db, cursor.parent_id) : null;
    }
    const children = all<SearchNode>(
      db,
      `SELECT id, parent_id, task, action, observation, code_used, visits, value, depth,
              status, msg_id, branch_agent_key, created_at
       FROM search_nodes
       WHERE parent_id = ?
       ORDER BY value DESC, visits DESC, created_at`,
      nodeId,
    ).map(summarizeMcts);
    return {
      id: node.id,
      parentId: node.parent_id,
      depth: node.depth,
      visits: node.visits,
      value: node.value,
      status: node.status,
      action: node.action,
      task: node.task,
      observation: node.observation,
      codeUsed: node.code_used,
      branchAgentKey: node.branch_agent_key,
      msgId: node.msg_id,
      createdAt: node.created_at,
      path,
      children,
    };
  });
}

export function listLocalHeads(name: string, limit = 20): unknown[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'head_journal')) return [];
    return new HeadJournal(makeSql(db)).listRuns(limit);
  });
}

export function listLocalGepaRuns(name: string, limit = 20): unknown[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'gepa_runs')) return [];
    return listGepaRuns(makeSql(db), limit);
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
export function recordLocalOutcomeLabels(
  name: string,
  input: { labeler: string; labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }> },
): LabelIngestResult {
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
  const { resolver } = createConfiguredLocalModelResolver({ agentName: name });
  const chatSpec = withLocalDb(name, (db) => createAgentConfigStore(makeSql(db)).getModel());
  const selection = await selectEnsembleJudges({
    specs,
    chatSpec: resolver.normalizeSpecSync(chatSpec),
    candidates: () => resolver.judgeCandidates(),
  });
  const judges = selection.specs.map((named) => {
    const spec = resolver.normalizeSpecSync(named);
    return { spec, llm: createCompletionLLM({ model: resolver.resolveModel(spec), spec, stage: 'judge' }) };
  });
  const db = new Database(agentDbPath(name));
  try {
    const sql = makeSql(db);
    initTurnOutcomeTables((ddl) => { db.exec(ddl); }, sql);
    return await runEnsemble(sql, judges);
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
    chatSpec,
    candidates: () => resolver.judgeCandidates(),
  });
  const judges = selection.specs.map((named) => {
    const spec = resolver.normalizeSpecSync(named);
    return { spec, llm: createCompletionLLM({ model: resolver.resolveModel(spec), spec, stage: 'judge' }) };
  });
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

export function getLocalGepaRun(name: string, runId: string): unknown {
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
      capabilities: ['shell', 'git', 'npm', 'fs_shared', 'net_outbound', 'process_spawn'],
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

export function getLocalStoredModel(name: string): { spec: string | null } {
  return withLocalDb(name, (db) => ({
    spec: tableExists(db, 'agent_config')
      ? get<{ value: string | null }>(db, `SELECT value FROM agent_config WHERE key = 'model' LIMIT 1`)?.value ?? null
      : null,
  }));
}

export function setLocalStoredModel(name: string, spec: string): { ok: true; spec: string } {
  if (!spec.trim()) throw new Error('model spec required');
  // One normalizer: the same provider-registry resolution the live session uses.
  const normalized = createConfiguredLocalModelResolver().resolver.normalizeSpecSync(spec);
  return withLocalWritableDb(name, (db) => {
    initAgentConfigTable((ddl) => db.exec(ddl));
    createAgentConfigStore(makeSql(db)).setModel(normalized);
    return { ok: true, spec: normalized };
  });
}

export function getLocalReasoningEffort(name: string): { effort: ReasoningEffort | null } {
  return withLocalDb(name, (db) => ({ effort: createAgentConfigStore(makeSql(db)).getReasoningEffort() }));
}

export function setLocalReasoningEffort(name: string, effort: ReasoningEffort): { ok: true; effort: ReasoningEffort } {
  return withLocalWritableDb(name, (db) => {
    initAgentConfigTable((ddl) => db.exec(ddl));
    createAgentConfigStore(makeSql(db)).setReasoningEffort(effort);
    return { ok: true, effort };
  });
}

export function listLocalTriggers(name: string): { triggers: unknown[] } {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'triggers')) return { triggers: [] };
    return { triggers: new TriggerRegistry(hubSql(db), NOOP_ALARM).list() };
  });
}

export function cancelLocalTrigger(name: string, id: string): { changed: boolean } {
  return withLocalWritableDb(name, (db) => {
    if (!tableExists(db, 'triggers')) return { changed: false };
    return { changed: new TriggerRegistry(hubSql(db), NOOP_ALARM).revoke(id, Date.now()) };
  });
}

export function createLocalTimerTrigger(name: string, input: { cron?: string; atMs?: number; label?: string }): unknown {
  return withLocalWritableDb(name, (db) => {
    initEventsHubTables(hubSql(db));
    const now = Date.now();
    const registry = new TriggerRegistry(hubSql(db), NOOP_ALARM);
    const nextFireAt = input.cron
      ? nextCronFire(input.cron, now)
      : input.atMs;
    if (input.cron && nextFireAt === null) throw new Error(`Unsupported cron expression: ${input.cron}`);
    if (!nextFireAt) throw new Error('A future trigger time is required.');
    const id = registry.register({
      kind: input.cron ? 'timer_cron' : 'timer_oneshot',
      spec: {
        ...(input.cron ? { cron: input.cron } : { atMs: input.atMs }),
        ...(input.label ? { label: input.label } : {}),
      },
      creator_trust: 'owner',
      next_fire_at: nextFireAt,
    }, now);
    return registry.get(id);
  });
}

export function listLocalJobs(name: string, limit = 20): unknown[] {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'background_jobs')) return [];
    return new BackgroundJobStore(makeSql(db)).list(limit);
  });
}

export function cancelLocalJob(name: string, id: string): { ok: boolean } {
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

export function getLocalProductBoard(name: string, limit = 20): ProductChangeBoard {
  return withLocalDb(name, (db) => {
    if (!tableExists(db, 'product_source_bindings') || !tableExists(db, 'product_change_requests')) {
      return { bindings: [], changes: [], checks: [], approvals: [], deployments: [] };
    }
    const store = createProductChangeStore(productChangeSqlFromExec(hubSql(db)));
    return store.board(name, limit);
  });
}

export function markLocalBackgroundJobsCancelled(name: string): string[] {
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
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function withLocalWritableDb<T>(name: string, fn: (db: SqliteDb) => T): T {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureLocalAgent(name: string): void {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);
}

function all<T>(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function get<T>(db: SqliteDb, sql: string, ...params: SQLQueryBindings[]): T | null {
  return db.query(sql).get(...params) as T | null;
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

function readVfsFile(db: SqliteDb, path: string): string | null {
  if (!tableExists(db, 'vfs_files')) return null;
  const rows = all<{ data: unknown }>(
    db,
    `SELECT data FROM vfs_files WHERE path = ? AND is_dir = 0 ORDER BY chunk_index`,
    path,
  );
  if (rows.length === 0) return null;
  return rows.map((row) => decodeBlob(row.data)).join('');
}

function decodeBlob(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return String(value);
}

function readMctsNode(db: SqliteDb, id: string): SearchNode | null {
  return get<SearchNode>(
    db,
    `SELECT id, parent_id, task, action, observation, code_used, visits, value, depth,
            status, msg_id, branch_agent_key, created_at
     FROM search_nodes
     WHERE id = ?
     LIMIT 1`,
    id,
  );
}

function summarizeMcts(node: SearchNode): LocalMctsNodeDetail['path'][number] {
  return {
    id: node.id,
    parentId: node.parent_id,
    depth: node.depth,
    visits: node.visits,
    value: node.value,
    status: node.status,
    action: node.action,
    createdAt: node.created_at,
  };
}

function getLocalStatus(db: SqliteDb): unknown {
  const identity = tableExists(db, 'workspace_identity')
    ? get<{ id: string; name: string; created_at: number }>(db, `SELECT id, name, created_at FROM workspace_identity LIMIT 1`)
    : null;
  const soul = tableExists(db, 'vfs_files') ? readSoul(makeSql(db)) : null;
  return {
    id: identity?.id ?? null,
    name: identity?.name ?? null,
    purpose: summarizeSoul(soul),
    soul: soul ?? '',
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

function getLocalToolSummary(db: SqliteDb): unknown {
  const crafted = tableExists(db, 'crafted_tools')
    ? all<{ name: string; description: string }>(db, `SELECT name, description FROM crafted_tools ORDER BY name`)
    : [];
  return {
    builtIn: BUILTIN_TOOLS,
    crafted,
    executors: listLocalExecutors(),
  };
}

function localMemorySize(db: SqliteDb): number {
  const cols = columnSet(db, 'vfs_files');
  if (cols.has('size')) {
    return get<{ total: number }>(
      db,
      `SELECT COALESCE(SUM(size), 0) AS total FROM vfs_files WHERE path LIKE 'memory/%'`,
    )?.total ?? 0;
  }
  if (cols.has('data')) {
    return get<{ total: number }>(
      db,
      `SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM vfs_files WHERE path LIKE 'memory/%'`,
    )?.total ?? 0;
  }
  return 0;
}

const NOOP_ALARM = {
  scheduleAt() {},
  currentAlarm() { return null; },
};

function hubSql(db: SqliteDb): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.query(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        const rows = stmt.all(...(bindings as SQLQueryBindings[])) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      }
      stmt.run(...(bindings as SQLQueryBindings[]));
      return {
        toArray: () => [],
      };
    },
  };
}

function parseJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function timestampOf(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('ts' in value)) return 0;
  const ts = (value as { ts?: unknown }).ts;
  return typeof ts === 'number' ? ts : 0;
}
