// agent_facts: typed, keyed world-model store private to one actor; UPSERT by key, each fact with confidence (0..1),
// observation time, importance and veracity (mnemopi's fields, `lexical-recall.ts`), and where it came from. Every value
// a key held is kept in agent_fact_history. The account's memory is this same store in the user object, under
// {@link ACCOUNT_FACTS_ACTOR}. Experience imports copy facts in under `source: experience:<workspace>`.

import { markStoreChanged } from '@kinu.run/agent-utils';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import * as v from 'valibot';
import { coversQuery, expandedTokenGroups, lexicalGroupRelevance, minimumRelevance } from './lexical-recall';
import { JsonValueSchema, safeJsonParse, type JsonValue } from '../utils/json';
import { scrubMemoryValue } from './scrub';


/** The actor id the account's facts are kept under, in the user object. */
export const ACCOUNT_FACTS_ACTOR = 'account';

/** How a fact was learned (mnemopi `Veracity`): said outright, inferred, read from a tool, copied in, or not known. */
export const VERACITIES = ['stated', 'inferred', 'tool', 'imported', 'unknown'] as const;

export type Veracity = (typeof VERACITIES)[number];

/** mnemopi's `VERACITY_WEIGHTS` (`core/veracity-consolidation.ts`): how far a match of each kind is trusted. */
const VERACITY_WEIGHTS: Readonly<Record<Veracity, number>> = { stated: 1, inferred: 0.7, tool: 0.5, imported: 0.6, unknown: 0.8 };

/** Who wrote a fact's value: an agent's own call, the background pass, the owner, or a copy from elsewhere. */
export const FactOriginSchema = v.object({
  by: v.picklist(['agent', 'background', 'owner', 'import']),
  workspace: v.optional(v.string()),
  agent: v.optional(v.string()),
});

export type FactOrigin = v.InferOutput<typeof FactOriginSchema>;

const VeracitySchema = v.picklist(VERACITIES);

export const FactSchema = v.object({
  key: v.string(),
  value: JsonValueSchema,
  confidence: v.number(),
  source: v.string(),
  lastObservedAt: v.number(),
  /** 0 to 1, default 0.5: how much it matters when recalled. */
  importance: v.number(),
  veracity: VeracitySchema,
  origin: v.nullable(FactOriginSchema),
});

export type Fact = v.InferOutput<typeof FactSchema>;

/** One value a key held, newest first. A forgotten fact is a revision too, with no value; JSON `null` is a value. */
export const FactRevisionSchema = v.object({
  forgotten: v.boolean(),
  value: v.nullable(JsonValueSchema),
  importance: v.number(),
  veracity: VeracitySchema,
  origin: v.nullable(FactOriginSchema),
  at: v.number(),
});

type FactRevision = Readonly<v.InferOutput<typeof FactRevisionSchema>>;

type FactUpsertResult = 'created' | 'changed' | 'unchanged';

/** Revisions kept per key; older ones go as a new one lands. */
const HISTORY_KEPT = 20;

export function initFactsTable(execRaw: (ddl: string) => void): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS agent_facts (
      actor_id         TEXT NOT NULL,
      key              TEXT NOT NULL,
      value_json       TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 1.0,
      source           TEXT,
      last_observed_at INTEGER NOT NULL,
      importance       REAL NOT NULL DEFAULT 0.5,
      veracity         TEXT NOT NULL DEFAULT 'stated',
      origin_json      TEXT,
      PRIMARY KEY (actor_id, key)
    )
  `);
  // Owner-leading index keeps `recentTopK` within one actor's rows.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_facts_observed
             ON agent_facts(actor_id, last_observed_at DESC)`);
  execRaw(`
    CREATE TABLE IF NOT EXISTS agent_fact_history (
      actor_id    TEXT NOT NULL,
      key         TEXT NOT NULL,
      rev         INTEGER NOT NULL,
      value_json  TEXT,
      importance  REAL NOT NULL,
      veracity    TEXT NOT NULL,
      origin_json TEXT,
      at          INTEGER NOT NULL,
      PRIMARY KEY (actor_id, key, rev)
    )
  `);
}

interface FactWrite {
  confidence?: number;
  source?: string;
  importance?: number;
  veracity?: Veracity;
  origin?: FactOrigin;
}

export interface FactsStore {
  upsert(key: string, value: JsonValue, opts?: FactWrite): FactUpsertResult;
  recall(key: string): Fact | null;
  /** `origin` is who forgot it, kept in the key's history. */
  forget(key: string, origin?: FactOrigin): void;
  recentTopK(k: number): Fact[];
  all(): Fact[];
  /** Newest first, at most {@link HISTORY_KEPT}. */
  history(key: string): FactRevision[];
}

interface FactRow {
  key: string;
  value_json: string;
  confidence: number;
  source: string | null;
  last_observed_at: number;
  importance: number;
  veracity: string;
  origin_json: string | null;
}

function veracityOf(raw: string): Veracity {
  const parsed = v.safeParse(VeracitySchema, raw);

  return parsed.success ? parsed.output : 'unknown';
}

function originOf(raw: string | null): FactOrigin | null {
  if (raw === null) return null;
  const parsed = v.safeParse(FactOriginSchema, safeJsonParse(raw));

  return parsed.success ? parsed.output : null;
}

function rowToFact(r: FactRow): Fact {
  return {
    key: r.key,
    value: safeJsonParse(r.value_json),
    confidence: r.confidence,
    source: r.source ?? '',
    lastObservedAt: r.last_observed_at,
    importance: r.importance,
    veracity: veracityOf(r.veracity),
    origin: originOf(r.origin_json),
  };
}

const unit = (raw: number | undefined, fallback: number): number => (raw !== undefined && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback);

export function normalizeFactKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

/** `actorId` is captured once; `assertCurrent()` runs before every statement so a retired handle stops writing. The
 *  account's store passes {@link ACCOUNT_FACTS_ACTOR} with nothing to assert: the user object is its only writer. */
export function createFactsStore(sql: SqlExecutor, actor: Pick<ActorHandle, 'actorId' | 'assertCurrent'>): FactsStore {
  const actorId = actor.actorId;
  const authorize = actor.assertCurrent;

  const remember = (key: string, revision: { value: string | null; importance: number; veracity: Veracity; origin: string | null; at: number }): void => {
    const rev = (sql<{ rev: number | null }>`SELECT MAX(rev) AS rev FROM agent_fact_history WHERE actor_id = ${actorId} AND key = ${key}`[0]?.rev ?? 0) + 1;

    void sql`INSERT INTO agent_fact_history (actor_id, key, rev, value_json, importance, veracity, origin_json, at)
      VALUES (${actorId}, ${key}, ${rev}, ${revision.value}, ${revision.importance}, ${revision.veracity}, ${revision.origin}, ${revision.at})`;
    void sql`DELETE FROM agent_fact_history WHERE actor_id = ${actorId} AND key = ${key} AND rev <= ${rev - HISTORY_KEPT}`;
  };

  return {
    upsert(key, value, opts = {}) {
      authorize();
      const canonical = normalizeFactKey(key);
      const conf = unit(opts.confidence, 1);
      const src = opts.source ?? null;
      // Every writer of a fact reaches this: its value is kept scrubbed (`memory/scrub.ts`).
      const valueJson = JSON.stringify(scrubMemoryValue(value));
      const origin = opts.origin === undefined ? null : JSON.stringify(opts.origin);

      const existing = sql<{ value_json: string; last_observed_at: number; importance: number; veracity: string }>`
        SELECT value_json, last_observed_at, importance, veracity FROM agent_facts
          WHERE actor_id = ${actorId} AND key = ${canonical} LIMIT 1`[0];

      const importance = unit(opts.importance, existing?.importance ?? 0.5);
      const veracity = opts.veracity ?? (existing === undefined ? 'stated' : veracityOf(existing.veracity));

      if (existing?.value_json === valueJson) {
        void sql`UPDATE agent_facts SET
              confidence = ${conf},
              source = COALESCE(${src}, source),
              importance = ${importance},
              veracity = ${veracity}
            WHERE actor_id = ${actorId} AND key = ${canonical}`;
        markStoreChanged(sql);

        return 'unchanged';
      }

      const now = Math.max(Date.now(), (existing?.last_observed_at ?? -1) + 1);
      void sql`
        INSERT INTO agent_facts (actor_id, key, value_json, confidence, source, last_observed_at, importance, veracity, origin_json)
        VALUES (${actorId}, ${canonical}, ${valueJson}, ${conf}, ${src}, ${now}, ${importance}, ${veracity}, ${origin})
        ON CONFLICT(actor_id, key) DO UPDATE SET
          value_json       = excluded.value_json,
          confidence       = excluded.confidence,
          source           = COALESCE(excluded.source, agent_facts.source),
          last_observed_at = excluded.last_observed_at,
          importance       = excluded.importance,
          veracity         = excluded.veracity,
          origin_json      = excluded.origin_json`;
      remember(canonical, { value: valueJson, importance, veracity, origin, at: now });
      markStoreChanged(sql);

      return existing ? 'changed' : 'created';
    },
    recall(key) {
      authorize();
      const canonical = normalizeFactKey(key);
      const rows = sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at, importance, veracity, origin_json FROM agent_facts WHERE actor_id = ${actorId} AND key = ${canonical} LIMIT 1`;

      return rows[0] ? rowToFact(rows[0]) : null;
    },
    forget(key, origin) {
      authorize();
      const canonical = normalizeFactKey(key);

      const existing = sql<{ importance: number; veracity: string }>`
        SELECT importance, veracity FROM agent_facts WHERE actor_id = ${actorId} AND key = ${canonical} LIMIT 1`[0];

      void sql`DELETE FROM agent_facts WHERE actor_id = ${actorId} AND key = ${canonical}`;

      if (existing !== undefined) {
        remember(canonical, {
          value: null, importance: existing.importance, veracity: veracityOf(existing.veracity),
          origin: origin === undefined ? null : JSON.stringify(origin), at: Date.now(),
        });
      }

      markStoreChanged(sql);
    },
    recentTopK(k) {
      authorize();

      return sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at, importance, veracity, origin_json FROM agent_facts WHERE actor_id = ${actorId}
        ORDER BY last_observed_at DESC LIMIT ${k}`.map(rowToFact);
    },
    all() {
      authorize();

      return sql<FactRow>`SELECT key, value_json, confidence, source, last_observed_at, importance, veracity, origin_json FROM agent_facts WHERE actor_id = ${actorId} ORDER BY key`.map(rowToFact);
    },
    history(key) {
      authorize();
      const canonical = normalizeFactKey(key);

      const rows = sql<{ value_json: string | null; importance: number; veracity: string; origin_json: string | null; at: number }>`
        SELECT value_json, importance, veracity, origin_json, at FROM agent_fact_history
          WHERE actor_id = ${actorId} AND key = ${canonical} ORDER BY rev DESC LIMIT ${HISTORY_KEPT}`;

      return rows.map((row) => ({
        forgotten: row.value_json === null,
        value: row.value_json === null ? null : safeJsonParse(row.value_json),
        importance: row.importance, veracity: veracityOf(row.veracity), origin: originOf(row.origin_json), at: row.at,
      }));
    },
  };
}

/** String verbatim, anything else as JSON: the one way a fact's value is shown, to a prompt, a search hit or a page. */
export function renderFactValue(value: JsonValue): string {
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

/** Where a fact is kept: this workspace's agent, or the account, which every workspace and agent of it reads. */
export type MemoryScope = 'workspace' | 'account';

/** A fact with the scope it was read from; unlabelled reads as the workspace's. */
export type ScopedFact = Fact & { readonly scope?: MemoryScope };

/** `id` is namespaced by scope, so it never fuses with a `path:start-end` note chunk or the other scope's key. */
export interface FactSearchHit {
  readonly id: string;
  readonly key: string;
  readonly snippet: string;
  /** The RRF consumer reads position, never the number. */
  readonly score: number;
  readonly lastObservedAt: number;
  readonly scope: MemoryScope;
}

/** mnemopi's default importance weight (`config.ts` `importanceWeight`) and its recency half-life in hours. */
const IMPORTANCE_WEIGHT = 0.2;

const RECENCY_HALF_LIFE_HOURS = 72;

/**
 * mnemopi's keyword score for a working-memory row (`core/beam/recall.ts`): lexical relevance over the key and the
 * rendered value, then importance, then recency (at most 30% off), then veracity.
 */
function factScore(fact: Fact, relevance: number, now: number): number {
  const keywordShare = (1 - IMPORTANCE_WEIGHT) * 0.6;
  const base = relevance * keywordShare + fact.importance * IMPORTANCE_WEIGHT + relevance * relevance * 0.08;
  const decay = Math.exp(-Math.max(0, now - fact.lastObservedAt) / 3_600_000 / RECENCY_HALF_LIFE_HOURS);

  return base * (0.7 + 0.3 * decay) * VERACITY_WEIGHTS[fact.veracity];
}

/** Ranked by mnemopi's score above its noise floor; ties by key. A key covering the query outranks a value only. */
export function searchFacts(facts: readonly ScopedFact[], query: string, limit: number, now = Date.now()): FactSearchHit[] {
  const groups = expandedTokenGroups(query);

  if (groups.length === 0) return [];
  const floor = minimumRelevance(groups.length);

  const hits = facts.flatMap((fact) => {
    const rendered = renderFactValue(fact.value);
    const relevance = lexicalGroupRelevance(groups, `${fact.key} ${rendered}`);

    if (relevance < floor) return [];
    const scope = fact.scope ?? 'workspace';
    const keyMatch = coversQuery(groups, fact.key);

    return [{
      hit: { id: `${scope === 'account' ? 'account-fact' : 'fact'}:${fact.key}`, key: fact.key, snippet: rendered, score: factScore(fact, relevance, now), lastObservedAt: fact.lastObservedAt, scope },
      keyMatch,
    }];
  });

  return hits
    .sort((a, b) => Number(b.keyMatch) - Number(a.keyMatch) || b.hit.score - a.hit.score || a.hit.key.localeCompare(b.hit.key))
    .slice(0, limit)
    .map((entry) => entry.hit);
}

/**
 * Both scopes as one list: an account fact whose key this workspace also holds is dropped, as the workspace's wins
 * inside it. Ranked by importance weighed by veracity, then recency, then key, so the order changes only when a fact does.
 */
export function unifiedFacts(workspace: readonly Fact[], account: readonly Fact[]): ScopedFact[] {
  const held = new Set(workspace.map((fact) => fact.key));
  const weight = (fact: Fact): number => fact.importance * VERACITY_WEIGHTS[fact.veracity];

  return [
    ...workspace.map((fact) => ({ ...fact, scope: 'workspace' as const })),
    ...account.filter((fact) => !held.has(fact.key)).map((fact) => ({ ...fact, scope: 'account' as const })),
  ].sort((a, b) => weight(b) - weight(a) || b.lastObservedAt - a.lastObservedAt || a.key.localeCompare(b.key));
}

/** What the memory block reads of a fact. */
export interface RenderedFact {
  readonly key: string;
  readonly value: JsonValue;
  readonly scope?: MemoryScope;
}

/** A fact as the memory block shows it, YAML-ish so the model treats it as data: an account fact marked `# account`,
 *  and `note` beside it. */
export function factLine(fact: RenderedFact, note?: string): string {
  const notes = [...(fact.scope === 'account' ? ['account'] : []), ...(note === undefined ? [] : [note])];

  return `${fact.key}: ${renderFactValue(fact.value)}${notes.length === 0 ? '' : `  # ${notes.join(', ')}`}`;
}

/** Lines of the memory block under a heading; none, the block's first. */
export interface MemorySection {
  readonly heading?: string;
  readonly lines: readonly string[];
}

/**
 * `sections` within `maxChars`: a line that does not fit is passed over for the next, so one long line crowds out none
 * after it, never cut mid-line; a heading is shown with its first line that fits; what was passed over is counted.
 */
export function renderMemoryBlock(sections: readonly MemorySection[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  let passed = 0;

  const fits = (text: string): boolean => used + text.length + 1 <= maxChars;

  for (const { heading, lines: candidates } of sections) {
    let headed = heading === undefined;

    for (const line of candidates) {
      const shown = headed ? line : `${heading ?? ''}\n${line}`;

      if (!fits(shown)) {
        passed += 1;
        continue;
      }

      lines.push(shown);
      used += shown.length + 1;
      headed = true;
    }
  }

  if (passed > 0) lines.push(`# ...and ${String(passed)} more not shown: memory recall and search read the rest`);

  return lines.join('\n');
}
