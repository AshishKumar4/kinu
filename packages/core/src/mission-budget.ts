/**
 * Mission budget governor — the outer integral over Kinu's call-scoped budgets.
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
 * Accounting reuses what already counts: provider-reported input/output where
 * the turn accumulator sees them, and the `llm.ts` character estimate at the
 * `LLM` seam, which returns text rather than usage.
 *
 * USD is PRICED AT DEBIT TIME, from the catalog rates the model-catalog session
 * already resolves for the actor's model (input, output, and cache-read where
 * the catalog publishes it) — a token count cannot be re-priced later, because
 * the ledger is cumulative across turns that may each have run on a different
 * model. Spend the governor cannot attribute to that model — a judge behind the
 * `LLM` primitive, a fork's sub-agents reporting one blended total — falls back
 * to `llm.ts` BLENDED_USD_PER_1K_TOKENS, and the ledger records exactly how many
 * of its tokens were priced that way, so `agent.budget()` never presents an
 * estimate as a measurement.
 *
 * Exhaustion is an honest structured refusal AT THE SEAM, never a silent stall:
 * the model-call seam declines with {@link MissionBudgetRefusal}, the spawn seam
 * returns it as the tool result the model reads, and the run's event log gets one
 * `budget_exhausted` row per label (the same durable-ledger idiom as
 * `context_budget`). The agent can then report, ask the owner, or conclude.
 */

import * as v from 'valibot';
import type { LLM, RawSqlExec, SqlExecutor } from './types/primitives';
import { BLENDED_USD_PER_1K_TOKENS, estimateTokens, estimateUsdCost } from './llm';
import { reconcileColumns } from './identity/columns';
import type { ModelPricing } from './providers/types';
import type { JsonValue } from './utils/json';
import { usageReported, usageTotal, type Usage } from './usage';

/** A cap on a label. Either dimension may be omitted; a label with neither is a
 *  pure accounting scope (it meters, it never refuses). */
export interface MissionBudgetLimits {
  /** Checked against the ledger's PRICED spend (catalog rates where the model
   *  is known, the blended fallback otherwise). */
  usd?: number;
  tokens?: number;
}

/** Where a label's USD figure came from. */
export interface MissionSpendProvenance {
  /** Tokens priced at the blended fallback rather than catalog rates. */
  blendedTokens: number;
  /** `catalog` = every token priced from the catalog; `blended` = none were;
   *  `mixed` = both (e.g. turns priced, a judge's calls estimated). */
  source: 'catalog' | 'blended' | 'mixed';
}

/** USD for one call at catalog rates (USD per 1M tokens), or undefined when the
 *  provider reported no token counts at all — the same contract as the `usd`
 *  beside a step's usage: absent means UNPRICED, never free.
 *
 *  Exported because per-step cost telemetry must price a call exactly as the
 *  ledger debits it — two implementations of this would drift, and the same
 *  step would then cost different amounts depending on which surface asked. */
export function priceCall(usage: Usage, pricing: ModelPricing): number | undefined {
  if (usageTotal(usage) === undefined) return undefined;
  const prompt = usage.input ?? 0;
  // The parts of a CACHE-INCLUSIVE prompt total, clamped so a nonsense report
  // (parts exceeding the whole) can never drive `fresh` negative. A part the
  // provider never reported contributes nothing and its tokens stay in `fresh`
  // at the plain input rate — the only honest reading for the OpenAI-compatible
  // family, whose adapter reports no cache WRITE at all.
  const cacheRead = Math.min(Math.max(0, usage.cacheRead ?? 0), prompt);
  const cacheWrite = Math.min(Math.max(0, usage.cacheWrite ?? 0), prompt - cacheRead);
  const fresh = prompt - cacheRead - cacheWrite;
  // `cacheWrite1h` is deliberately NOT in this sum: it is a subset of
  // `cacheWrite`, so the `cacheWrite` term below has already charged it, and
  // models.dev publishes ONE `cache_write` rate. Inventing a second rate for the
  // 1h retention tier is exactly the policy drift `gate:policy-drift` catches.
  return (
    fresh * pricing.input
    + cacheRead * (pricing.cacheRead ?? pricing.input)
    + cacheWrite * (pricing.cacheWrite ?? pricing.input)
    + (usage.output ?? 0) * pricing.output
  ) / 1_000_000;
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
  /** How honest the USD figure is. */
  readonly pricing: MissionSpendProvenance;
  readonly calls: number;
  readonly spawns: number;
  readonly exhausted: boolean;
}

/** One ledger row. */
interface MissionRow {
  label: string;
  parent: string | null;
  limitUsd: number | null;
  limitTokens: number | null;
  tokens: number;
  usd: number;
  /** Of `tokens`, how many were priced at the blended fallback. */
  blendedTokens: number;
  calls: number;
  spawns: number;
  exhaustedAt: number | null;
}

/** Nesting depth guard. A chain this long is a bug (a cycle the declare-time
 *  check somehow admitted), and walking it forever would hang a debit. */
const MAX_CHAIN_DEPTH = 32;

/** One already-priced increment, ready to roll up a label chain. */
interface MissionDebit {
  tokens: number;
  usd: number;
  blendedTokens: number;
  calls: number;
  spawns: number;
}

const DDL = `CREATE TABLE IF NOT EXISTS mission_budget (
  label TEXT PRIMARY KEY,
  parent_label TEXT,
  limit_usd REAL,
  limit_tokens INTEGER,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  blended_tokens INTEGER NOT NULL DEFAULT 0,
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
    // Ledgers written before USD was priced carry tokens and no dollars, and
    // everything they spent WAS blended — so the backfill states exactly that
    // rather than reading as $0 spent and silently reopening a USD cap that was
    // already met. Which columns are missing is ASKED, not inferred from a
    // failing ALTER: a locked or read-only database throws the same way as a
    // duplicate column, so the old boolean reported "already present" and
    // skipped the backfill precisely when the ledger was least trustworthy.
    const before = new Set(
      sql<{ name: string }>`SELECT name FROM pragma_table_info('mission_budget')`.map((c) => c.name),
    );
    reconcileColumns(sql, execRaw, 'mission_budget', {
      spent_usd: 'REAL NOT NULL DEFAULT 0',
      blended_tokens: 'INTEGER NOT NULL DEFAULT 0',
    });
    if (!before.has('spent_usd') || !before.has('blended_tokens')) {
      execRaw(`UPDATE mission_budget
        SET spent_usd = spent_tokens * ${BLENDED_USD_PER_1K_TOKENS / 1000},
            blended_tokens = spent_tokens`);
    }
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
    void this.sql`INSERT INTO mission_budget
        (label, parent_label, limit_usd, limit_tokens, spent_tokens, spent_usd, blended_tokens, calls, spawns, created_at, exhausted_at)
      VALUES (${label}, ${effectiveParent}, ${limits.usd ?? null}, ${limits.tokens ?? null}, 0, 0, 0, 0, 0, ${now}, NULL)`;
    return this.get(label)!;
  }

  get(label: string): MissionRow | null {
    const rows = this.sql<MissionBudgetColumns>`
      SELECT label, parent_label, limit_usd, limit_tokens, spent_tokens, spent_usd, blended_tokens,
             calls, spawns, exhausted_at
       FROM mission_budget WHERE label = ${label}`;
    const row = rows[0];
    return row ? toRow(row) : null;
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
  debit(label: string, delta: MissionDebit): void {
    for (const row of this.chain(label)) {
      void this.sql`UPDATE mission_budget
        SET spent_tokens = spent_tokens + ${delta.tokens},
            spent_usd = spent_usd + ${delta.usd},
            blended_tokens = blended_tokens + ${delta.blendedTokens},
            calls = calls + ${delta.calls},
            spawns = spawns + ${delta.spawns}
        WHERE label = ${row.label}`;
    }
  }

  /** Stamp the moment a label first ran out, so the run event fires once. */
  markExhausted(label: string, now: number): void {
    void this.sql`UPDATE mission_budget SET exhausted_at = ${now}
             WHERE label = ${label} AND exhausted_at IS NULL`;
  }
}

/** The ledger's stored columns. Named because two readers decode them — the
 *  governor's own `get`, and the read-only workspace surface below — and two
 *  decoders over one storage shape is how one of them comes to drop a field. */
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
 * Every label the ledger holds, dearest first.
 *
 * The ONE per-mission spend figure. This is the ledger the caps are enforced
 * against, so a surface that answered "what did mission X cost" from anywhere
 * else would be a second answer to a question that already has one.
 *
 * A pure read — no DDL, no governor, no writes — because the workspace spend
 * surface runs in processes that declare no budget of their own: a CLI
 * inspection over a read-only database, a panel fetch.
 *
 * The table's absence is a real answer, not an error, and it is asked about
 * rather than caught. The ledger is OPT-IN by construction: an actor that never
 * declared a budget never built a governor, so nothing ever ran the DDL, and no
 * mission spend exists to report. Reaching that state through a thrown
 * `no such table` would make an ordinary unbudgeted workspace look broken.
 *
 * CUMULATIVE AND LIFETIME, unlike the windowed row types beside it. A cap is
 * cumulative, so a windowed slice of the ledger would be a number no cap is
 * read against. The surface states which scope each half of its table is on.
 */
export function listMissionSpend(sql: SqlExecutor): MissionBudgetSnapshot[] {
  const present = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_budget'`;
  if (present.length === 0) return [];
  return sql<MissionBudgetColumns>`
    SELECT label, parent_label, limit_usd, limit_tokens, spent_tokens, spent_usd, blended_tokens,
           calls, spawns, exhausted_at
     FROM mission_budget
     ORDER BY spent_usd DESC, spent_tokens DESC, label ASC`.map((row) => toSnapshot(toRow(row)));
}

/** True when the row is at or over either of its caps. */
function isOverBudget(row: MissionRow): boolean {
  if (row.limitTokens !== null && row.tokens >= row.limitTokens) return true;
  return row.limitUsd !== null && row.usd >= row.limitUsd;
}

function provenanceOf(row: MissionRow): MissionSpendProvenance {
  const source = row.blendedTokens === 0
    ? 'catalog'
    : row.blendedTokens >= row.tokens ? 'blended' : 'mixed';
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
  /** What the actor's CURRENT model charges (the model-catalog session's
   *  `pricing()`). Read per debit, because the model can change between turns.
   *  Absent — or null before the catalog lookup lands — means every debit uses
   *  the blended fallback, and says so. */
  pricing?(): ModelPricing | null;
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

  /**
   * Charge spend to the active scope (or to explicit labels). A debit under no
   * scope is a no-op that touches no storage.
   *
   * `usage` is the provider's own report for a call on the ACTOR'S CURRENT
   * model — the only spend the catalog can price, since that is the model the
   * catalog session tracks. Everything else (a judge behind the `LLM`
   * primitive, a fork reporting one total across its sub-agents' models) passes
   * tokens alone and is priced at the blended rate, counted in `blendedTokens`.
   *
   * A usage report the catalog CANNOT price — nothing token-billable in it, so
   * `priceCall` declines — is treated exactly like no report at all: the tokens
   * are estimated at the blended rate and counted as blended, so `agent.budget()`
   * still never presents an estimate as a measurement.
   */
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
      usd: priced ?? estimateUsdCost(total),
      blendedTokens: priced === undefined ? total : 0,
      calls: opts?.calls ?? 0,
      spawns: opts?.spawns ?? 0,
    };
    if (delta.tokens === 0 && delta.calls === 0 && delta.spawns === 0) return;
    for (const label of new Set(labels)) this.ledger.debit(label, delta);
  }

  /** The catalog rates for the model the next call resolves to, or null while
   *  the lookup is still in flight / the model is unpriced. The one pricing
   *  source: telemetry that prices a call reads it here rather than opening a
   *  second route to the catalog. */
  pricing(): ModelPricing | null {
    return this.deps.pricing?.() ?? null;
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
   *
   * The seam sees text, not usage, and the model behind it is frequently NOT
   * the actor's (selectJudgeModel deliberately picks cross-family) — so this
   * spend is estimated from characters at the blended rate and lands in
   * `blendedTokens`, where a reader can see it for what it is.
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
    // "≈" only where it is earned: a fully catalog-priced ledger is a
    // measurement, and hedging it would teach the agent to distrust the number.
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

/**
 * The governor as work running OUT OF PROCESS sees it.
 *
 * The ledger lives with the actor that declared the budget, and a forked head
 * does not run there: on Cloudflare it is a separate facet with its own
 * storage, resolving its own model, so the governed `LLM` the fork seam wraps
 * never reaches the calls that head actually makes. Coverage without this is
 * refuse-to-spawn plus one lump debit after the whole fork returns — which
 * cannot stop a run mid-flight, and is exactly when a budget matters.
 *
 * Async because the answer may have to cross a process boundary. In-process
 * backends satisfy it with {@link localMissionPort}, which is the governor
 * itself; a facet satisfies it over an RPC to the actor that holds the ledger.
 *
 * OPT-IN, like everything else here: a port is reached only for a scope with
 * labels in it, so a run that declared no budget issues no call, no query and
 * no refusal.
 */
export interface MissionBudgetPort {
  guard(seam: MissionSeam, labels: readonly string[]): Promise<MissionBudgetRefusal | null>;
  debit(tokens: number, opts: {
    labels: readonly string[]; calls?: number; spawns?: number; usage?: Usage;
  }): Promise<void>;
}

/**
 * A budget scope handed to work that will run elsewhere: which labels it
 * charges, and how to reach them.
 *
 * Carried as a whole rather than as bare labels because the two halves are
 * useless apart — labels with no port charge nothing, and a port with no labels
 * has nothing to charge. Absent means unbudgeted, which is the default.
 */
export interface MissionScope {
  readonly labels: readonly string[];
  readonly port: MissionBudgetPort;
}

/** The port over a governor in this process — the local backend's, and the
 *  receiving half of a remote one. */
export function localMissionPort(governor: MissionGovernor): MissionBudgetPort {
  return {
    async guard(seam, labels) { return governor.guard(seam, labels); },
    async debit(tokens, opts) { governor.debit(tokens, opts); },
  };
}

/** A scope over an in-process governor, or null when `labels` is empty — the
 *  shape that keeps "no budget declared" from ever reaching the ledger. */
export function localMissionScope(
  governor: MissionGovernor,
  labels: readonly string[],
): MissionScope | null {
  return labels.length === 0 ? null : { labels: [...labels], port: localMissionPort(governor) };
}

/**
 * The two questions a search asks its mission ledger between units of work, or
 * the pair of no-ops it asks when there is no ledger.
 *
 * The no-op half is the half that matters: an undeclared run is handed no scope,
 * so `outOfBudget` is a constant `false` and `charge` returns without ever
 * reaching a port. Nothing queries, nothing writes, and the search behaves
 * exactly as it did before a governor existed.
 *
 * ONE PAIR FOR EVERY ENGINE. MCTS asks it per expansion and a swarm asks it per
 * level and per toolless node; a second spelling of the same two questions is
 * how two engines come to disagree about what "spent" means.
 */
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
      // Work whose provider reported nothing is metered as the SPAWN it was, not
      // as a free call: charging `0` here would be indistinguishable from a
      // provider that reported zero tokens.
      if (!usageReported(usage)) return;
      await mission.port.debit(usageTotal(usage) ?? 0, {
        labels: mission.labels, calls: 1, usage,
      });
    },
  };
}

/**
 * The programmatic-turn metadata key that carries a woken turn's mission scope
 * from the schedule that fired it. One name, read by both backends at turn
 * start and written by the reactor — the labels are the only thing linking a
 * cron fire to the ledger its spend belongs to.
 */
export const MISSION_LABELS_METADATA_KEY = 'missionLabels';

const MissionLabelsMetadataSchema = v.object({
  [MISSION_LABELS_METADATA_KEY]: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
});

/** Mission labels off a turn's metadata bag. Anything malformed reads as
 *  unscoped: a turn must never inherit a budget it cannot name properly. */
export function readMissionLabels<Metadata>(metadata: Metadata): string[] {
  const parsed = v.safeParse(MissionLabelsMetadataSchema, metadata);
  return parsed.success ? parsed.output[MISSION_LABELS_METADATA_KEY] ?? [] : [];
}

/** Read `budget_usd` / `budget_tokens` off an untyped tool input. Returns null
 *  when neither is a usable positive number — the uncapped default. */
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
