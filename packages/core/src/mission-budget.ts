/**
 * Mission budget governor — the outer integral over Proteus's call-scoped budgets.
 *
 * Every existing budget is scoped to ONE call: a fork's `budget`/`wall_clock_ms`,
 * MCTS's `maxCostUSD` pre-run estimate gate, a head's 5-minute default. A cron
 * -driven run is an unbounded number of turns, each individually bounded and
 * cumulatively unbounded, and a crafted tool that tracks its own spend is the
 * code that overspends policing the code that was supposed to stop. The stop has
 * to live at the host seam.
 *
 * So: a durable ledger keyed by LABEL — a trigger id, a mission name, a run name
 * — where every model call and every spawn that happens under that label debits
 * the same row, transitively, including everything descendants spawn. A label may
 * nest under a parent label (a fork declaring its own sub-budget inside a mission),
 * and a debit rolls up the whole chain, so the outer cap is real no matter how
 * deeply the work is delegated.
 *
 * OPT-IN, ALWAYS. There is no default cap and no default label: an actor that
 * never declares a budget never touches this table, never runs a query, and never
 * sees a refusal. The governor exists only where a run asked for one — "unleash,
 * don't cap" is the standing rule, and a governor that capped by default would
 * break it.
 *
 * Accounting reuses what already counts. Tokens are the single stored quantity:
 * provider-reported input+output where the turn accumulator sees them, and the
 * `llm.ts` character estimate at the `LLM` seam, which returns text rather than
 * usage. USD is derived on read through the same blended rate the rest of the
 * system sizes runs with (llm.ts BLENDED_USD_PER_1K_TOKENS) — never stored, so
 * there is one source of truth for spend and no second telemetry system.
 *
 * Exhaustion is an honest structured refusal AT THE SEAM, never a silent stall:
 * the model-call seam declines with {@link MissionBudgetRefusal}, the spawn seam
 * returns it as the tool result the model reads, and the run's event log gets one
 * `budget_exhausted` row per label (the same durable-ledger idiom as
 * `context_budget`). The agent can then report, ask the owner, or conclude.
 */

import type { LLM, RawSqlExec, SqlExecutor } from './types/primitives.js';
import { estimateTokens, estimateUsdCost } from './llm.js';

/** A cap on a label. Either dimension may be omitted; a label with neither is a
 *  pure accounting scope (it meters, it never refuses). */
export interface MissionBudgetLimits {
  /** Blended USD, converted to tokens on read through the llm.ts rate. */
  usd?: number;
  tokens?: number;
}

/** Which host seam turned the work away. */
export type MissionSeam = 'model_call' | 'spawn';

/** What a seam returns instead of spending. Structured so a tool result is
 *  inspectable by the model and a log line is greppable by the owner. */
export interface MissionBudgetRefusal {
  readonly error: 'budget_exhausted';
  readonly seam: MissionSeam;
  /** The exhausted label — the label the work ran under, or an ancestor of it. */
  readonly label: string;
  /** The label the work was actually running under. */
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
  /** Absent dimensions are uncapped. Never negative. */
  readonly remaining: { tokens?: number; usd?: number };
  readonly calls: number;
  readonly spawns: number;
  readonly exhausted: boolean;
}

/** One ledger row, before USD is derived. */
interface MissionRow {
  label: string;
  parent: string | null;
  limitUsd: number | null;
  limitTokens: number | null;
  tokens: number;
  calls: number;
  spawns: number;
  exhaustedAt: number | null;
}

/** Nesting depth guard. A chain this long is a bug (a cycle the declare-time
 *  check somehow admitted), and walking it forever would hang a debit. */
const MAX_CHAIN_DEPTH = 32;

const DDL = `CREATE TABLE IF NOT EXISTS mission_budget (
  label TEXT PRIMARY KEY,
  parent_label TEXT,
  limit_usd REAL,
  limit_tokens INTEGER,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  spawns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  exhausted_at INTEGER
)`;

/** The durable spend ledger. */
export class MissionBudgetLedger {
  constructor(
    private readonly sql: SqlExecutor,
    execRaw: RawSqlExec,
  ) {
    execRaw(DDL);
  }

  /**
   * Attach a budget to a label, idempotently. A re-declaration of an existing
   * label is a no-op that returns the live row: a cron trigger firing for the
   * hundredth time continues the SAME cumulative ledger rather than resetting
   * it, which is the entire point of a cumulative governor.
   */
  declare(label: string, limits: MissionBudgetLimits, parent: string | null, now: number): MissionRow {
    const existing = this.get(label);
    if (existing) return existing;
    const effectiveParent = parent !== null && parent !== label && this.get(parent) !== null ? parent : null;
    this.sql`INSERT INTO mission_budget
        (label, parent_label, limit_usd, limit_tokens, spent_tokens, calls, spawns, created_at, exhausted_at)
      VALUES (${label}, ${effectiveParent}, ${limits.usd ?? null}, ${limits.tokens ?? null}, 0, 0, 0, ${now}, NULL)`;
    return this.get(label)!;
  }

  get(label: string): MissionRow | null {
    const rows = this.sql<{
      label: string; parent_label: string | null; limit_usd: number | null; limit_tokens: number | null;
      spent_tokens: number; calls: number; spawns: number; exhausted_at: number | null;
    }>`SELECT label, parent_label, limit_usd, limit_tokens, spent_tokens, calls, spawns, exhausted_at
       FROM mission_budget WHERE label = ${label}`;
    const row = rows[0];
    if (!row) return null;
    return {
      label: row.label,
      parent: row.parent_label,
      limitUsd: row.limit_usd,
      limitTokens: row.limit_tokens,
      tokens: row.spent_tokens,
      calls: row.calls,
      spawns: row.spawns,
      exhaustedAt: row.exhausted_at,
    };
  }

  /** The label and its ancestors, innermost first. Unknown labels yield []. */
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

  /** Add spend to a label AND every ancestor — the transitive debit. */
  debit(label: string, delta: { tokens: number; calls: number; spawns: number }): void {
    for (const row of this.chain(label)) {
      this.sql`UPDATE mission_budget
        SET spent_tokens = spent_tokens + ${delta.tokens},
            calls = calls + ${delta.calls},
            spawns = spawns + ${delta.spawns}
        WHERE label = ${row.label}`;
    }
  }

  /** Stamp the moment a label first ran out, so the run event fires once. */
  markExhausted(label: string, now: number): void {
    this.sql`UPDATE mission_budget SET exhausted_at = ${now}
             WHERE label = ${label} AND exhausted_at IS NULL`;
  }
}

/** True when the row is at or over either of its caps. */
function isOverBudget(row: MissionRow): boolean {
  if (row.limitTokens !== null && row.tokens >= row.limitTokens) return true;
  return row.limitUsd !== null && estimateUsdCost(row.tokens) >= row.limitUsd;
}

function toSnapshot(row: MissionRow): MissionBudgetSnapshot {
  const usd = estimateUsdCost(row.tokens);
  return {
    label: row.label,
    parent: row.parent,
    limits: {
      ...(row.limitUsd !== null ? { usd: row.limitUsd } : {}),
      ...(row.limitTokens !== null ? { tokens: row.limitTokens } : {}),
    },
    spent: { tokens: row.tokens, usd },
    remaining: {
      ...(row.limitTokens !== null ? { tokens: Math.max(0, row.limitTokens - row.tokens) } : {}),
      ...(row.limitUsd !== null ? { usd: Math.max(0, row.limitUsd - usd) } : {}),
    },
    calls: row.calls,
    spawns: row.spawns,
    exhausted: isOverBudget(row),
  };
}

/** Thrown by a governed `LLM` when the model-call seam declines. Carries the
 *  structured refusal so a catching caller reports the real reason instead of a
 *  bare message. */
export class MissionBudgetExhausted extends Error {
  constructor(readonly refusal: MissionBudgetRefusal) {
    super(refusal.note);
    this.name = 'MissionBudgetExhausted';
  }
}

export interface MissionGovernorDeps {
  storage: { sql: SqlExecutor; execRaw: RawSqlExec };
  /** Fired ONCE per label, the first time a seam refuses under it — the
   *  backend wires its RunEventRecorder here so exhaustion lands in the run's
   *  durable event log alongside `context_budget`. */
  onExhausted?(refusal: MissionBudgetRefusal): void;
  now?(): number;
}

/**
 * The host-side governor: the active mission scope plus the two enforcement
 * seams. One per actor; the active scope is safe as instance state because an
 * actor runs exactly one turn at a time (the serialized loop), and work that
 * genuinely runs concurrently — forks — is passed its labels explicitly.
 */
export class MissionGovernor {
  private readonly ledger: MissionBudgetLedger;
  private active: readonly string[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: MissionGovernorDeps) {
    this.now = deps.now ?? Date.now;
    this.ledger = new MissionBudgetLedger(deps.storage.sql, deps.storage.execRaw);
  }

  /** The labels the current turn runs under. Empty = unbudgeted (the default). */
  get scope(): readonly string[] {
    return this.active;
  }

  /** Bind the current turn's mission scope. Unknown labels are dropped: a turn
   *  cannot conjure a budget by naming one that was never declared. */
  activate(labels: readonly string[]): void {
    this.active = labels.length === 0
      ? []
      : [...new Set(labels)].filter((label) => this.ledger.get(label) !== null);
  }

  /**
   * Declare (or re-enter) a budget label. Nests under the innermost active
   * label unless a parent is named, so a fork's own cap is bounded by the
   * mission it was spawned inside.
   */
  declare(label: string, limits: MissionBudgetLimits, opts?: { parent?: string }): MissionBudgetSnapshot {
    const parent = opts?.parent ?? this.active[0] ?? null;
    return toSnapshot(this.ledger.declare(label, limits, parent, this.now()));
  }

  /**
   * The enforcement check. Returns the refusal for the FIRST exhausted label in
   * any active chain, or null when there is room (including the common case of
   * no budget at all, which never reads storage).
   */
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

  /** Charge spend to the active scope (or to explicit labels). A debit under no
   *  scope is a no-op that touches no storage. */
  debit(tokens: number, opts?: { labels?: readonly string[]; calls?: number; spawns?: number }): void {
    const labels = opts?.labels ?? this.active;
    if (labels.length === 0) return;
    const delta = { tokens: Math.max(0, Math.round(tokens)), calls: opts?.calls ?? 0, spawns: opts?.spawns ?? 0 };
    if (delta.tokens === 0 && delta.calls === 0 && delta.spawns === 0) return;
    for (const label of new Set(labels)) this.ledger.debit(label, delta);
  }

  /** One label's state, or every active label's when omitted. */
  snapshot(label?: string): MissionBudgetSnapshot[] {
    const labels = label !== undefined ? [label] : this.active;
    return labels.map((l) => this.ledger.get(l)).filter((r): r is MissionRow => r !== null).map(toSnapshot);
  }

  /**
   * Wrap an `LLM` so every completion is guarded before it is issued and
   * metered after it returns. This is the model-call seam for everything that
   * reaches a model through the `LLM` primitive — MCTS branch evaluation, the
   * judge ensemble, convergence, craft generalization.
   *
   * `stream` is guarded but not metered, exactly as `meterLLM` counts only
   * `complete`: the streaming callers are the turn loops, whose spend the turn
   * accumulator already debits from the provider's own usage report. Metering
   * the stream here as well would double-count them.
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
    return {
      error: 'budget_exhausted',
      seam,
      label: row.label,
      scope,
      limit: snapshot.limits,
      spent: snapshot.spent,
      note: seam === 'spawn'
        ? `Mission budget "${row.label}" is spent (${snapshot.spent.tokens} tokens ≈ $${snapshot.spent.usd.toFixed(4)} against ${cap}); no further agents may be spawned under it. Report what the run achieved, or ask the owner to raise the budget.`
        : `Mission budget "${row.label}" is spent (${snapshot.spent.tokens} tokens ≈ $${snapshot.spent.usd.toFixed(4)} against ${cap}); the host declined this model call. Report what the run achieved, or ask the owner to raise the budget.`,
    };
  }
}

/**
 * The programmatic-turn metadata key that carries a woken turn's mission scope
 * from the schedule that fired it. One name, read by both backends at turn
 * start and written by the reactor — the labels are the only thing linking a
 * cron fire to the ledger its spend belongs to.
 */
export const MISSION_LABELS_METADATA_KEY = 'missionLabels';

/** Mission labels off a turn's metadata bag. Anything malformed reads as
 *  unscoped: a turn must never inherit a budget it cannot name properly. */
export function readMissionLabels(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const raw = (metadata as Record<string, unknown>)[MISSION_LABELS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is string => typeof l === 'string' && l.length > 0);
}

/** Read `budget_usd` / `budget_tokens` off an untyped tool input. Returns null
 *  when neither is a usable positive number — the uncapped default. */
export function readMissionLimits(input: {
  budget_usd?: unknown; budget_tokens?: unknown;
}): MissionBudgetLimits | null {
  const usd = typeof input.budget_usd === 'number' && Number.isFinite(input.budget_usd) && input.budget_usd > 0
    ? input.budget_usd : undefined;
  const tokens = typeof input.budget_tokens === 'number' && Number.isFinite(input.budget_tokens) && input.budget_tokens > 0
    ? Math.floor(input.budget_tokens) : undefined;
  if (usd === undefined && tokens === undefined) return null;
  return { ...(usd !== undefined ? { usd } : {}), ...(tokens !== undefined ? { tokens } : {}) };
}
