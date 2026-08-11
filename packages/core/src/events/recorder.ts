/**
 * RunEventRecorder — durable per-agent event log.
 *
 * Holds an in-memory event index per runId for fast monotonic assignment,
 * persists every event to the run_events table, and exposes:
 *   • emit(runId, ev)            — record one event
 *   • read(runId, opts?)         — paginated query
 *   • readSince(runId, sinceIdx) — replay tail (for SSE Last-Event-ID)
 *
 * Subscribers can hook in via observe(fn) for live streaming (SSE) — the
 * recorder fans out synchronously after persisting to SQLite.
 */

import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import type { RunEvent, RunEventInput, RunEventType } from './types.js';

export interface RunEventQuery {
  /** Inclusive lower bound on eventIndex. */
  since?: number;
  /** Inclusive upper bound on eventIndex. */
  until?: number;
  /** Filter to a subset of event types. */
  types?: readonly RunEventType[];
  /** Maximum rows to return. Default 200. */
  limit?: number;
}

export type RunEventListener = (event: RunEvent) => void;

export function initRunEventTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (run_id, event_index)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_run_events_run_ts ON run_events(run_id, ts)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type)`);
}

export class RunEventRecorder {
  // Cached next-index per runId. Loaded lazily from the table on first emit.
  private nextIndex = new Map<string, number>();
  private listeners = new Set<RunEventListener>();

  constructor(private readonly sql: SqlExecutor) {}

  /** Record an event for runId. Returns the assigned monotonic event. */
  emit(runId: string, input: RunEventInput): RunEvent {
    const idx = this.allocateIndex(runId);
    const ev = {
      ...input,
      eventIndex: idx,
      runId,
      timestamp: new Date().toISOString(),
    } as RunEvent;
    this.persist(ev);
    for (const l of this.listeners) {
      try { l(ev); } catch (err) { console.warn('[run-events] listener threw:', err); }
    }
    return ev;
  }

  private allocateIndex(runId: string): number {
    const cached = this.nextIndex.get(runId);
    if (cached != null) {
      this.nextIndex.set(runId, cached + 1);
      return cached;
    }
    // Load from DB.
    const rows = this.sql<{ max_idx: number | null }>`
      SELECT MAX(event_index) AS max_idx FROM run_events WHERE run_id = ${runId}`;
    const max = rows[0]?.max_idx ?? -1;
    const next = max + 1;
    this.nextIndex.set(runId, next + 1);
    return next;
  }

  private persist(ev: RunEvent): void {
    this.sql`INSERT OR REPLACE INTO run_events (run_id, event_index, type, payload, ts)
      VALUES (${ev.runId}, ${ev.eventIndex}, ${ev.type}, ${JSON.stringify(ev)}, ${ev.timestamp})`;
  }

  read(runId: string, opts: RunEventQuery = {}): RunEvent[] {
    const limit = opts.limit ?? 200;
    const since = opts.since ?? 0;
    const types = opts.types && opts.types.length > 0 ? new Set<string>(opts.types) : null;

    // Tagged-template SQL can't safely build dynamic IN-clauses across all
    // SqlExecutor implementations (parameter binding is positional). Fetch
    // a window and filter client-side — events are small, limit is bounded.
    const fetchLimit = types ? Math.min(limit * 4, 2000) : limit;
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE run_id = ${runId} AND event_index >= ${since}
      ORDER BY event_index ASC
      LIMIT ${fetchLimit}`;
    const events = rows.map((r) => JSON.parse(r.payload) as RunEvent);
    if (!types) return events;
    return events.filter((e) => types.has(e.type)).slice(0, limit);
  }

  /** Replay all events strictly after `afterIndex` — for SSE Last-Event-ID resume. */
  readSince(runId: string, afterIndex: number, limit = 500): RunEvent[] {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE run_id = ${runId} AND event_index > ${afterIndex}
      ORDER BY event_index ASC
      LIMIT ${limit}`;
    return rows.map((r) => JSON.parse(r.payload) as RunEvent);
  }

  /**
   * The most recent events of ONE type, across every run, oldest first.
   *
   * This is the retained sample behind the step telemetry: `run_events` is
   * already durable and already indexed by type, so a percentile over recent
   * steps needs no ring buffer and no roll-up table. A single-value equality
   * binds cleanly across every SqlExecutor (unlike `read`'s IN-clause), so the
   * filter runs in SQL and `limit` is a real bound rather than a post-filter
   * slice that can come back short.
   *
   * Ties on `ts` break by rowid — insertion order. `event_index` restarts at 0
   * for every run and is therefore meaningless across runs; using it here put
   * a new run's first step before an old run's last one whenever both landed
   * in the same millisecond.
   */
  readRecentByType(type: RunEventType, limit = 200): RunEvent[] {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE type = ${type}
      ORDER BY ts DESC, rowid DESC
      LIMIT ${limit}`;
    return rows.map((r) => JSON.parse(r.payload) as RunEvent).reverse();
  }

  /** Subscribe to future events; returns an unsubscribe function. */
  observe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Total event count for a run. */
  count(runId: string): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events WHERE run_id = ${runId}`;
    return rows[0]?.n ?? 0;
  }

  /** List recent runs (distinct run_ids, ordered by latest event ts). */
  listRuns(limit = 50): Array<{ runId: string; lastTs: string; eventCount: number }> {
    return this.sql<{ runId: string; lastTs: string; eventCount: number }>`
      SELECT run_id AS runId, MAX(ts) AS lastTs, COUNT(*) AS eventCount
      FROM run_events
      GROUP BY run_id
      ORDER BY lastTs DESC
      LIMIT ${limit}`;
  }
}
