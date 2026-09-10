// agent_facts — typed, idempotent, keyed world-model store, PRIVATE to one actor.
//
// MEMORY.md is unstructured prose; FTS5 retrieval is fuzzy. For long-lived
// state ("user prefers TS over Py", "deploy target = foo.workers.dev",
// "last successful build = abc") the agent wants UPSERT by key, not append.
// Facts are JSON values keyed by string; each carries a confidence (0..1)
// and an observation timestamp. Top-K recent facts are auto-rendered into
// the system prompt every turn.
//
// PRIVATE, because the key space is the agent's own. `remember`/`recall`/
// `forget` are this actor's tool, `renderFactsForTurn` injects its top-K into
// THIS actor's prompt, and sleep-time compression rewrites its own model — so a
// sibling that learns "deploy target" must not overwrite what this one observed
// under the same words. Adoption is still a real path and still lands here: an
// experience import UPSERTS the imported fact into the importing actor's own
// set under `source: experience:<workspace>`, which is a copy into a target,
// not a shared row two actors read differently.

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
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
      actor_id         TEXT NOT NULL,
      key              TEXT NOT NULL,
      value_json       TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 1.0,
      source           TEXT,
      last_observed_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, key)
    )
  `);
  // Leading with the owner keeps `recentTopK` index-served inside one actor's
  // rows: a recency-only index would scan every sibling's facts to find this
  // actor's twenty newest.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_facts_observed
             ON agent_facts(actor_id, last_observed_at DESC)`);
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

/** One key space for the world model. Trims, lowercases, and folds runs of
 *  whitespace to one underscore, so variant spellings share one row. */
export function normalizeFactKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Bind the fact store to ONE actor.
 *
 * `actorId` is captured once from a handle the caller already holds and is
 * never read again, so a re-issued or re-pointed handle cannot silently move a
 * live store onto another actor's rows. `assertCurrent()` runs before every
 * statement for the other half of that: it is the binding's own validation, so
 * a handle whose directory row was retired stops writing here at the same
 * instant it stops serving `config`.
 */
export function createFactsStore(sql: SqlExecutor, actor: ActorHandle): FactsStore {
  const actorId = actor.actorId;
  const authorize = actor.assertCurrent;
  return {
    upsert(key, value, opts = {}) {
      authorize();
      const canonical = normalizeFactKey(key);
      const raw = opts.confidence ?? 1;
      const conf = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
      const src = opts.source ?? null;
      const valueJson = JSON.stringify(value);
      const existing = sql<{ value_json: string; last_observed_at: number }>`
        SELECT value_json, last_observed_at FROM agent_facts
          WHERE actor_id = ${actorId} AND key = ${canonical} LIMIT 1`[0];
      if (existing?.value_json === valueJson) {
        void sql`UPDATE agent_facts SET
              confidence = ${conf},
              source = COALESCE(${src}, source)
            WHERE actor_id = ${actorId} AND key = ${canonical}`;
        return 'unchanged';
      }
      const now = Math.max(Date.now(), (existing?.last_observed_at ?? -1) + 1);
      void sql`
        INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at)
        VALUES (${actorId}, ${canonical}, ${valueJson}, ${conf}, ${src}, ${now})
        ON CONFLICT(actor_id, key) DO UPDATE SET
          value_json       = excluded.value_json,
          confidence       = excluded.confidence,
          source           = COALESCE(excluded.source, agent_facts.source),
          last_observed_at = excluded.last_observed_at`;
      return existing ? 'changed' : 'created';
    },
    recall(key) {
      authorize();
      const canonical = normalizeFactKey(key);
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at
                                  FROM agent_facts
                                  WHERE actor_id = ${actorId} AND key = ${canonical} LIMIT 1`;
      return rows[0] ? rowToFact(rows[0]) : null;
    },
    forget(key) {
      authorize();
      const canonical = normalizeFactKey(key);
      void sql`DELETE FROM agent_facts WHERE actor_id = ${actorId} AND key = ${canonical}`;
    },
    recentTopK(k) {
      authorize();
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at
                                  FROM agent_facts WHERE actor_id = ${actorId}
                                  ORDER BY last_observed_at DESC LIMIT ${k}`;
      return rows.map(rowToFact);
    },
    all() {
      authorize();
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at
                                  FROM agent_facts WHERE actor_id = ${actorId} ORDER BY key`;
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
