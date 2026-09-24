/**
 * Opt-in durable spend ledger keyed by label: every model call and spawn under a label debits it and all its ancestors.
 * USD is priced at debit time from catalog rates (blended fallback is counted); exhaustion is a structured refusal at the seam.
 */

import * as v from 'valibot';
import type { LLM, RawSqlExec, SqlExecutor } from './types/primitives';
import type { ActorHandle } from './identity/actor-handle';
import { estimateTokens, estimateUsdCost } from './llm';
import type { ModelPricing } from './providers/types';
import type { JsonObject, JsonValue } from './utils/json';
import { usageReported, usageTotal, type Usage } from './usage';
import { KinuError } from './obs/error';

/** A label with neither cap meters but never refuses. */
export interface MissionBudgetLimits {
  usd?: number;
  tokens?: number;
}

export interface MissionSpendProvenance {
  blendedTokens: number;
  source: 'catalog' | 'blended' | 'mixed';
}

/** Unexported on purpose: `gate:wired` reports exported names no production module references. */
interface CallPrice {
  /** A floor, never an over-charge, when `floorTokens` is present. */
  readonly usd: number;
  /**
   * `cacheWrite1h` tokens billed at models.dev's single (5m) `cache_write` rate; Anthropic prices 1h higher.
   * Absent on an exact price, never `0`; no second rate, as that would be policy drift.
   */
  readonly floorTokens?: number;
}

/** Rates are USD per 1M tokens; undefined means unpriced, never free. Shared with per-step cost telemetry. */
export function priceCall(usage: Usage, pricing: ModelPricing): CallPrice | undefined {
  if (usageTotal(usage) === undefined) return undefined;
  const prompt = usage.input ?? 0;
  // Parts of a cache-inclusive prompt total, clamped so `fresh` never goes negative.
  const cacheRead = Math.min(Math.max(0, usage.cacheRead ?? 0), prompt);
  const cacheWrite = Math.min(Math.max(0, usage.cacheWrite ?? 0), prompt - cacheRead);
  const fresh = prompt - cacheRead - cacheWrite;

  // `cacheWrite1h` is a subset of `cacheWrite`, already charged below.
  const usd = (
    fresh * pricing.input
    + cacheRead * (pricing.cacheRead ?? pricing.input)
    + cacheWrite * (pricing.cacheWrite ?? pricing.input)
    + (usage.output ?? 0) * pricing.output
  ) / 1_000_000;

  // Counted, not corrected: `cache-breakpoints.ts` emits Anthropic `ttl: '1h'`.
  const floorTokens = Math.min(Math.max(0, usage.cacheWrite1h ?? 0), cacheWrite);

  return floorTokens > 0 ? { usd, floorTokens } : { usd };
}

export type MissionSeam = 'model_call' | 'spawn';

export interface MissionBudgetRefusal {
  readonly error: 'budget_exhausted';
  readonly seam: MissionSeam;
  /** The scope itself or an ancestor. */
  readonly label: string;
  readonly scope: string;
  readonly limit: MissionBudgetLimits;
  readonly spent: { tokens: number; usd: number };
  readonly note: string;
}

export interface MissionBudgetSnapshot {
  readonly label: string;
  readonly parent: string | null;
  readonly limits: MissionBudgetLimits;
  readonly spent: { tokens: number; usd: number };
  /** Absent dimensions are uncapped. */
  readonly remaining: { tokens?: number; usd?: number };
  readonly pricing: MissionSpendProvenance;
  readonly calls: number;
  readonly spawns: number;
  readonly exhausted: boolean;
}

interface MissionRow {
  label: string;
  parent: string | null;
  limitUsd: number | null;
  limitTokens: number | null;
  tokens: number;
  usd: number;
  blendedTokens: number;
  calls: number;
  spawns: number;
  exhaustedAt: number | null;
}

/** Guards a debit against a cycle the declare-time check missed. */
const MAX_CHAIN_DEPTH = 32;

interface MissionDebit {
  tokens: number;
  usd: number;
  blendedTokens: number;
  calls: number;
  spawns: number;
}

const DDL = `CREATE TABLE IF NOT EXISTS mission_budget (
  actor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  parent_label TEXT,
  limit_usd REAL,
  limit_tokens INTEGER,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  blended_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  spawns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  exhausted_at INTEGER,
  PRIMARY KEY (actor_id, label)
)`;

export class MissionBudgetLedger {
  private readonly actorId: string;

  /** Per actor: two actors may declare the same label and must not exhaust each other's cap. */
  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    execRaw: RawSqlExec,
  ) {
    this.actorId = actor.actorId;
    execRaw(DDL);
  }

  /** Idempotent: a repeat cron fire continues the cumulative row rather than resetting it. */
  declare(label: string, limits: MissionBudgetLimits, parent: string | null, now: number): MissionRow {
    this.actor.assertCurrent();
    const existing = this.get(label);

    if (existing) return existing;
    const effectiveParent = parent !== null && parent !== label && this.get(parent) !== null ? parent : null;
    void this.sql`INSERT INTO mission_budget
        (actor_id, label, parent_label, limit_usd, limit_tokens, spent_tokens, spent_usd, blended_tokens, calls, spawns, created_at, exhausted_at)
      VALUES (${this.actorId}, ${label}, ${effectiveParent}, ${limits.usd ?? null}, ${limits.tokens ?? null}, 0, 0, 0, 0, 0, ${now}, NULL)`;

    const declared = this.get(label);

    if (declared === null) {
      throw new KinuError('io', `mission budget "${label}" was inserted but could not be read back`);
    }

    return declared;
  }

  get(label: string): MissionRow | null {
    this.actor.assertCurrent();

    const rows = this.sql<MissionBudgetColumns>`
      SELECT label, parent_label, limit_usd, limit_tokens, spent_tokens, spent_usd, blended_tokens,
             calls, spawns, exhausted_at
       FROM mission_budget WHERE actor_id = ${this.actorId} AND label = ${label}`;

    const row = rows[0];

    return row ? toRow(row) : null;
  }

  /** Innermost first. */
  chain(label: string): MissionRow[] {
    const out: MissionRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = label;

    while (cursor !== null && !seen.has(cursor) && out.length < MAX_CHAIN_DEPTH) {
      seen.add(cursor);
      const row: MissionRow | null = this.get(cursor);

      if (!row) break;
      out.push(row);
      cursor = row.parent;
    }

    return out;
  }

  debit(label: string, delta: MissionDebit): void {
    for (const row of this.chain(label)) {
      void this.sql`UPDATE mission_budget
        SET spent_tokens = spent_tokens + ${delta.tokens},
            spent_usd = spent_usd + ${delta.usd},
            blended_tokens = blended_tokens + ${delta.blendedTokens},
            calls = calls + ${delta.calls},
            spawns = spawns + ${delta.spawns}
        WHERE actor_id = ${this.actorId} AND label = ${row.label}`;
    }
  }

  /** First exhaustion only, so the run event fires once. */
  markExhausted(label: string, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mission_budget SET exhausted_at = ${now}
             WHERE actor_id = ${this.actorId} AND label = ${label} AND exhausted_at IS NULL`;
  }
}

interface MissionBudgetColumns {
  label: string; parent_label: string | null; limit_usd: number | null; limit_tokens: number | null;
  spent_tokens: number; spent_usd: number; blended_tokens: number;
  calls: number; spawns: number; exhausted_at: number | null;
}

function toRow(row: MissionBudgetColumns): MissionRow {
  return {
    label: row.label,
    parent: row.parent_label,
    limitUsd: row.limit_usd,
    limitTokens: row.limit_tokens,
    tokens: row.spent_tokens,
    usd: row.spent_usd,
    blendedTokens: row.blended_tokens,
    calls: row.calls,
    spawns: row.spawns,
    exhaustedAt: row.exhausted_at,
  };
}

/**
 * Every label, dearest first; cumulative lifetime figures, as caps are. A pure read (no DDL) for read-only surfaces.
 * A missing table is an unbudgeted workspace, not an error.
 */
export function listMissionSpend(sql: SqlExecutor, actor: ActorHandle): MissionBudgetSnapshot[] {
  actor.assertCurrent();

  const present = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_budget'`;

  if (present.length === 0) return [];

  return sql<MissionBudgetColumns>`
    SELECT label, parent_label, limit_usd, limit_tokens, spent_tokens, spent_usd, blended_tokens,
           calls, spawns, exhausted_at
     FROM mission_budget
     WHERE actor_id = ${actor.actorId}
     ORDER BY spent_usd DESC, spent_tokens DESC, label ASC`.map((row) => toSnapshot(toRow(row)));
}

function isOverBudget(row: MissionRow): boolean {
  if (row.limitTokens !== null && row.tokens >= row.limitTokens) return true;

  return row.limitUsd !== null && row.usd >= row.limitUsd;
}

function provenanceOf(row: MissionRow): MissionSpendProvenance {
  if (row.blendedTokens === 0) return { blendedTokens: row.blendedTokens, source: 'catalog' };

  const source = row.blendedTokens >= row.tokens ? 'blended' : 'mixed';

  return { blendedTokens: row.blendedTokens, source };
}

function toSnapshot(row: MissionRow): MissionBudgetSnapshot {
  const limits: MissionBudgetLimits = {};

  if (row.limitUsd !== null) limits.usd = row.limitUsd;

  if (row.limitTokens !== null) limits.tokens = row.limitTokens;
  const remaining: MissionBudgetSnapshot['remaining'] = {};

  if (row.limitTokens !== null) remaining.tokens = Math.max(0, row.limitTokens - row.tokens);

  if (row.limitUsd !== null) remaining.usd = Math.max(0, row.limitUsd - row.usd);

  return {
    label: row.label,
    parent: row.parent,
    limits,
    spent: { tokens: row.tokens, usd: row.usd },
    remaining,
    pricing: provenanceOf(row),
    calls: row.calls,
    spawns: row.spawns,
    exhausted: isOverBudget(row),
  };
}

export class MissionBudgetExhausted extends KinuError {
  override readonly name = 'MissionBudgetExhausted';
  constructor(readonly refusal: MissionBudgetRefusal) {
    super('denied', refusal.note);
  }
}

export interface MissionGovernorDeps {
  storage: { sql: SqlExecutor; execRaw: RawSqlExec };
  actor: ActorHandle;
  /** Once per label, on its first refusal. */
  onExhausted?(refusal: MissionBudgetRefusal): void;
  /** Read per debit, as the model can change between turns; null means the blended fallback. */
  pricing?(): ModelPricing | null;
  /** A property, not a method: held unbound. */
  now?: () => number;
}

/** One per actor; the active scope is instance state because an actor runs one turn at a time, and forks pass labels explicitly. */
export class MissionGovernor {
  private readonly ledger: MissionBudgetLedger;
  private active: readonly string[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: MissionGovernorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.ledger = new MissionBudgetLedger(deps.storage.sql, deps.actor, deps.storage.execRaw);
  }

  get scope(): readonly string[] {
    return this.active;
  }

  /** Undeclared labels are dropped. */
  activate(labels: readonly string[]): void {
    this.active = labels.length === 0
      ? []
      : [...new Set(labels)].filter((label) => this.ledger.get(label) !== null);
  }

  /** Nests under the innermost active label unless a parent is named. */
  declare(label: string, limits: MissionBudgetLimits, opts?: { parent?: string }): MissionBudgetSnapshot {
    const parent = opts?.parent ?? this.active[0] ?? null;

    return toSnapshot(this.ledger.declare(label, limits, parent, this.now()));
  }

  /** The first exhausted label in any chain; no labels never reads storage. */
  guard(seam: MissionSeam, labels: readonly string[] = this.active): MissionBudgetRefusal | null {
    if (labels.length === 0) return null;

    for (const scope of labels) {
      for (const row of this.ledger.chain(scope)) {
        if (!isOverBudget(row)) continue;
        const refusal = this.refusalFor(seam, scope, row);

        if (row.exhaustedAt === null) {
          this.ledger.markExhausted(row.label, this.now());
          this.deps.onExhausted?.(refusal);
        }

        return refusal;
      }
    }

    return null;
  }

  /** Pass `usage` only for calls on the actor's current model; anything unpriceable is counted as blended. */
  debit(tokens: number, opts?: {
    labels?: readonly string[]; calls?: number; spawns?: number; usage?: Usage;
  }): void {
    const labels = opts?.labels ?? this.active;

    if (labels.length === 0) return;
    const total = Math.max(0, Math.round(tokens));
    const pricing = opts?.usage ? this.deps.pricing?.() ?? null : null;
    const priced = pricing && opts?.usage ? priceCall(opts.usage, pricing) : undefined;

    const delta: MissionDebit = {
      tokens: total,
      usd: priced?.usd ?? estimateUsdCost(total),
      blendedTokens: priced === undefined ? total : 0,
      calls: opts?.calls ?? 0,
      spawns: opts?.spawns ?? 0,
    };

    if (delta.tokens === 0 && delta.calls === 0 && delta.spawns === 0) return;

    for (const label of new Set(labels)) this.ledger.debit(label, delta);
  }

  /** The single pricing source for telemetry too. */
  pricing(): ModelPricing | null {
    return this.deps.pricing?.() ?? null;
  }

  snapshot(label?: string): MissionBudgetSnapshot[] {
    const labels = label !== undefined ? [label] : this.active;

    return labels.map((l) => this.ledger.get(l)).filter((r): r is MissionRow => r !== null).map(toSnapshot);
  }

  /**
   * `stream` is guarded but not metered: turn loops already debit it from provider usage.
   * `complete` is estimated from chars at the blended rate; the model is often not the actor's.
   */
  govern(llm: LLM, labels: readonly string[] = this.active): LLM {
    if (labels.length === 0) return llm;

    const guard = (): void => {
      const refusal = this.guard('model_call', labels);

      if (refusal) throw new MissionBudgetExhausted(refusal);
    };

    return {
      stream: (opts) => {
        guard();

        return llm.stream(opts);
      },
      complete: async (prompt) => {
        guard();
        const text = await llm.complete(prompt);
        this.debit(estimateTokens(prompt.length + text.length), { labels, calls: 1 });

        return text;
      },
    };
  }

  private refusalFor(seam: MissionSeam, scope: string, row: MissionRow): MissionBudgetRefusal {
    const snapshot = toSnapshot(row);

    const cap = row.limitTokens !== null
      ? `${row.limitTokens} tokens`
      : `$${(row.limitUsd ?? 0).toFixed(2)}`;

    const about = snapshot.pricing.source === 'catalog' ? '=' : '≈';
    const spent = `${snapshot.spent.tokens} tokens ${about} $${snapshot.spent.usd.toFixed(4)} against ${cap}`;

    return {
      error: 'budget_exhausted',
      seam,
      label: row.label,
      scope,
      limit: snapshot.limits,
      spent: snapshot.spent,
      note: seam === 'spawn'
        ? `Mission budget "${row.label}" is spent (${spent}); no further agents may be spawned under it. Report what the run achieved, or ask the owner to raise the budget.`
        : `Mission budget "${row.label}" is spent (${spent}); the host declined this model call. Report what the run achieved, or ask the owner to raise the budget.`,
    };
  }
}

/** The governor as out-of-process work (a Cloudflare facet) sees it, so a fork can be stopped mid-flight. */
export interface MissionBudgetPort {
  guard(seam: MissionSeam, labels: readonly string[]): Promise<MissionBudgetRefusal | null>;
  debit(tokens: number, opts: {
    labels: readonly string[]; calls?: number; spawns?: number; usage?: Usage;
  }): Promise<void>;
}

export interface MissionScope {
  readonly labels: readonly string[];
  readonly port: MissionBudgetPort;
}

function localMissionPort(governor: MissionGovernor): MissionBudgetPort {
  return {
    async guard(seam, labels) { return governor.guard(seam, labels); },
    async debit(tokens, opts) { governor.debit(tokens, opts); },
  };
}

export function localMissionScope(
  governor: MissionGovernor,
  labels: readonly string[],
): MissionScope | null {
  return labels.length === 0 ? null : { labels: [...labels], port: localMissionPort(governor) };
}

/** Shared by every search engine; without a scope both are no-ops that never reach a port. */
export interface MissionMeter {
  outOfBudget: () => Promise<boolean>;
  charge: (usage: Usage | undefined) => Promise<void>;
}

export function missionMeter(mission: MissionScope | undefined): MissionMeter {
  if (!mission) {
    return { outOfBudget: async () => false, charge: async () => {} };
  }

  return {
    outOfBudget: async () => (await mission.port.guard('model_call', mission.labels)) !== null,
    charge: async (usage) => {
      if (!usage) return;

      // Unreported usage must not be charged as `0`, which would read as a free call.
      if (!usageReported(usage)) return;
      await mission.port.debit(usageTotal(usage) ?? 0, {
        labels: mission.labels, calls: 1, usage,
      });
    },
  };
}

/** Carries a woken turn's mission scope from the schedule that fired it. */
export const MISSION_LABELS_METADATA_KEY = 'missionLabels';

const MissionLabelsMetadataSchema = v.object({
  [MISSION_LABELS_METADATA_KEY]: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
});

/** Malformed metadata reads as unscoped. */
export function readMissionLabels(metadata: JsonObject | undefined): string[] {
  const parsed = v.safeParse(MissionLabelsMetadataSchema, metadata);

  return parsed.success ? parsed.output[MISSION_LABELS_METADATA_KEY] ?? [] : [];
}

/** Null when neither is a usable positive number. */
export function readMissionLimits(input: {
  budget_usd?: JsonValue;
  budget_tokens?: JsonValue;
}): MissionBudgetLimits | null {
  const parsedUsd = v.safeParse(v.number(), input.budget_usd);
  const parsedTokens = v.safeParse(v.number(), input.budget_tokens);

  const usd = parsedUsd.success && Number.isFinite(parsedUsd.output) && parsedUsd.output > 0
    ? parsedUsd.output : undefined;

  const tokens = parsedTokens.success && Number.isFinite(parsedTokens.output) && parsedTokens.output > 0
    ? Math.floor(parsedTokens.output) : undefined;

  if (usd === undefined && tokens === undefined) return null;

  return { usd, tokens };
}
