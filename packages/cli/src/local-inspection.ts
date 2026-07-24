import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  createProductChangeStore,
  BackgroundJobStore,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOLS,
  EventLog,
  HeadJournal,
  TriggerRegistry,
  createAgentConfigStore,
  initAgentConfigTable,
  initEventsHubTables,
  listGepaRuns,
  loadGepaCandidates,
  nextCronFire,
  productChangeSqlFromExec,
  type EventVariant,
  type ProductChangeBoard,
  type SearchNode,
  type ReasoningEffort,
  readSoul,
  summarizeSoul,
} from '@proteus/core';
import { makeSql } from '@proteus/cli-backend';
import { agentDbPath } from './config.js';
import { createConfiguredLocalModelResolver } from './local-model-resolver.js';

type SqliteDb = Database;

type HubSql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
};

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

export function listLocalTimeline(name: string, limit = 100): unknown[] {
  return withLocalDb(name, (db) => {
    const rows: unknown[] = [];
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
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ executor: executorId, command, stdout, stderr: err.message, exitCode: 1 }));
    child.on('close', (code) => resolve({ executor: executorId, command, stdout, stderr, exitCode: code ?? 0 }));
  });
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
    scaffoldVersion: tableExists(db, 'scaffold_versions')
      ? get<{ v: number }>(db, `SELECT COALESCE(MAX(version), 0) AS v FROM scaffold_versions`)?.v ?? 0
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

function hubSql(db: SqliteDb): HubSql {
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
