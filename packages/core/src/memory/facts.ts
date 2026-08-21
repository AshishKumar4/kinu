// agent_facts — typed, idempotent, keyed world-model store.
//
// MEMORY.md is unstructured prose; FTS5 retrieval is fuzzy. For long-lived
// state ("user prefers TS over Py", "deploy target = foo.workers.dev",
// "last successful build = abc") the agent wants UPSERT by key, not append.
// Facts are JSON values keyed by string; each carries a confidence (0..1)
// and an observation timestamp. Top-K recent facts are auto-rendered into
// the system prompt every turn.

import type { SqlExecutor } from '../types/primitives';
import * as v from 'valibot';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { classify } from '../obs/index';

export interface Fact {
  key: string;
  value: JsonValue;
  confidence: number;
  source: string;
  lastObservedAt: number;
}

export type FactUpsertResult = 'created' | 'changed' | 'unchanged';

export function initFactsTable(execRaw: (ddl: string) => void): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS agent_facts (
      key              TEXT PRIMARY KEY,
      value_json       TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 1.0,
      source           TEXT,
      last_observed_at INTEGER NOT NULL
    )
  `);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_facts_observed
             ON agent_facts(last_observed_at DESC)`);
}

export interface FactsStore {
  upsert(key: string, value: JsonValue, opts?: { confidence?: number; source?: string }): FactUpsertResult;
  recall(key: string): Fact | null;
  forget(key: string): void;
  recentTopK(k: number): Fact[];
  all(): Fact[];
}

interface FactRow {
  key: string;
  value_json: string;
  confidence: number;
  source: string | null;
  last_observed_at: number;
}

function rowToFact(r: FactRow): Fact {
  return {
    key: r.key,
    value: safeParse(r.value_json),
    confidence: r.confidence,
    source: r.source ?? '',
    lastObservedAt: r.last_observed_at,
  };
}

function safeParse(json: string): JsonValue {
  try { return parseJsonValue(json); }
  catch (error) {
    if (classify({ cause: error }) !== 'malformed-input') throw error;
    return json;
  }
}

export function createFactsStore(sql: SqlExecutor): FactsStore {
  return {
    upsert(key, value, opts = {}) {
      const conf = opts.confidence ?? 1;
      const src = opts.source ?? null;
      const valueJson = JSON.stringify(value);
      const existing = sql<{ value_json: string; last_observed_at: number }>`
        SELECT value_json, last_observed_at FROM agent_facts WHERE key = ${key} LIMIT 1`[0];
      if (existing?.value_json === valueJson) {
        void sql`UPDATE agent_facts SET
              confidence = ${conf},
              source = COALESCE(${src}, source)
            WHERE key = ${key}`;
        return 'unchanged';
      }
      const now = Math.max(Date.now(), (existing?.last_observed_at ?? -1) + 1);
      void sql`
        INSERT INTO agent_facts (key, value_json, confidence, source, last_observed_at)
        VALUES (${key}, ${valueJson}, ${conf}, ${src}, ${now})
        ON CONFLICT(key) DO UPDATE SET
          value_json       = excluded.value_json,
          confidence       = excluded.confidence,
          source           = COALESCE(excluded.source, agent_facts.source),
          last_observed_at = excluded.last_observed_at`;
      return existing ? 'changed' : 'created';
    },
    recall(key) {
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at
                                  FROM agent_facts WHERE key = ${key} LIMIT 1`;
      return rows[0] ? rowToFact(rows[0]) : null;
    },
    forget(key) {
      void sql`DELETE FROM agent_facts WHERE key = ${key}`;
    },
    recentTopK(k) {
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at
                                  FROM agent_facts ORDER BY last_observed_at DESC LIMIT ${k}`;
      return rows.map(rowToFact);
    },
    all() {
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at
                                  FROM agent_facts ORDER BY key`;
      return rows.map(rowToFact);
    },
  };
}

/** Render the top-K most recently observed facts as a system-prompt block.
 *  Returned format is concise YAML-ish so the LLM treats it as data, not prose. */
export function renderFactsBlock(facts: Fact[], opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 4000;
  if (facts.length === 0) return '';
  const lines: string[] = [];
  let shown = 0;
  let used = 0;
  for (const f of facts) {
    const text = v.safeParse(v.string(), f.value);
    const val = text.success ? text.output : JSON.stringify(f.value);
    const line = `${f.key}: ${val}`;
    if (used + line.length + 1 > max) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < facts.length) {
    lines.push(`# …and ${facts.length - shown} more facts not shown — memory recall reads any key`);
  }
  return lines.join('\n');
}
