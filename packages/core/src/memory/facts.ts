// agent_facts: typed, keyed world-model store private to one actor; UPSERT by key, each fact with
// confidence (0..1) and observation time. Experience imports copy facts in under `source: experience:<workspace>`.

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import * as v from 'valibot';
import { ftsQueryTerms } from '@kinu.run/agent-utils/memory';
import { safeJsonParse, type JsonValue } from '../utils/json';


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
  // Owner-leading index keeps `recentTopK` within one actor's rows.
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
    value: safeJsonParse(r.value_json),
    confidence: r.confidence,
    source: r.source ?? '',
    lastObservedAt: r.last_observed_at,
  };
}

export function normalizeFactKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

/** `actorId` is captured once; `assertCurrent()` runs before every statement so a retired handle stops writing. */
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

/** String verbatim, anything else as JSON; shared by the prompt block and search hits. */
function renderFactValue(value: JsonValue): string {
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

/** `id` is namespaced so it never fuses with a `path:start-end` note chunk. */
export interface FactSearchHit {
  readonly id: string;
  readonly key: string;
  readonly snippet: string;
  /** The RRF consumer reads position, never the number. */
  readonly score: number;
  readonly lastObservedAt: number;
}

/** The corpus side splits on every non-alphanumeric run so `deploy_target` yields both query terms; the query side uses `ftsQueryTerms`. */
function factTermSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
}

/** Candidate when every query term appears across key and rendered value. Ranked key-covering first, then recency, then key. */
export function searchFacts(facts: FactsStore, query: string, limit: number): FactSearchHit[] {
  const terms = new Set(
    ftsQueryTerms(query).flatMap((term) => term.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean),
  );

  if (terms.size === 0) return [];

  const hits: Array<{ hit: FactSearchHit; keyMatch: boolean }> = [];

  for (const fact of facts.all()) {
    const rendered = renderFactValue(fact.value);
    const keyTerms = factTermSet(fact.key);
    const doc = new Set([...keyTerms, ...factTermSet(rendered)]);

    if (![...terms].every((term) => doc.has(term))) continue;

    const keyMatch = [...terms].every((term) => keyTerms.has(term));

    hits.push({
      hit: { id: `fact:${fact.key}`, key: fact.key, snippet: rendered, score: keyMatch ? 1 : 0.5, lastObservedAt: fact.lastObservedAt },
      keyMatch,
    });
  }

  return hits
    .sort((a, b) =>
      Number(b.keyMatch) - Number(a.keyMatch)
      || b.hit.lastObservedAt - a.hit.lastObservedAt
      || a.hit.key.localeCompare(b.hit.key))
    .slice(0, limit)
    .map((entry) => entry.hit);
}

/** YAML-ish so the model treats it as data. */
export function renderFactsBlock(facts: Fact[], opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 4000;

  if (facts.length === 0) return '';
  const lines: string[] = [];
  let shown = 0;
  let used = 0;

  for (const f of facts) {
    const line = `${f.key}: ${renderFactValue(f.value)}`;

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
