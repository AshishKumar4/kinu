// AgentConfigStore — typed accessors over the `agent_config` key/value table.
//
// Before this, 23 raw `SELECT ... FROM agent_config` / `INSERT OR REPLACE ...`
// sites were scattered across orchestrator.ts, runtime.ts, head-runtime.ts,
// fork.ts. Adding a new tunable meant editing schema + 5 different files.
//
// The store is a deep module (small interface, real behavior): typed getters
// for known keys, generic get/set/delete for everything else, all() for fork.
import type { SqlExecutor, RawSqlExec } from '../types/primitives.js';
import type { DirectoryBackup } from '../execution/sandbox.js';
import { isReasoningEffort, type ReasoningEffort } from '../strategy/effort.js';

export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Known config keys. Adding one here forces a typed getter/setter — that
 *  catches typos at compile time. */
export const AGENT_CONFIG_KEYS = {
  model: 'model',
  reasoningEffort: 'reasoning_effort',
  displayName: 'display_name',
  /** 'user' once the operator sets a name explicitly — suppresses auto-titling. */
  nameOrigin: 'name_origin',
  shellApprovalMode: 'shell_approval_mode',
  sleepTimeCompute: 'sleep_time_compute',
  autoPromoteScaffold: 'auto_promote_scaffold',
  shadowSampleRate: 'shadow_sample_rate',
  /** Fraction of scaffold proposals that branch from an archived variant
   *  instead of the live current (DGM archive exploration). */
  scaffoldExploreShare: 'scaffold_explore_share',
  /** `<provider>/<modelId>` the agent's own output is judged on. Unset = pick
   *  the first available cross-family model (selectJudgeModel). */
  reviewModel: 'review_model',
  /** Comma-separated list of skill names the operator wants always-on. */
  alwaysActiveSkills: 'always_active_skills',
  /** The executor namespace the agent most recently ran a tool in — so the UI
   *  (diff / file manager) defaults to where work actually happened. */
  lastActiveExecutor: 'last_active_executor',
  /** Serialized DirectoryBackup handle for the agent's /workspace snapshot. */
  workspaceBackup: 'workspace_backup',
  /** Epoch ms of the last successful /workspace backup (backup debounce). */
  workspaceBackupAt: 'workspace_backup_at',
  /** Run GEPA self-optimization after this many turns of new execution traces
   *  (0 = off; unset = the autonomous default cadence). Trace-driven, not
   *  clock-driven. */
  autoGepaEveryNTurns: 'auto_gepa_every_n_turns',
  /** Epoch ms of the operator's last Evolution Changelog view — entries newer
   *  than this drive the unseen badge. */
  changelogSeenAt: 'changelog_seen_at',
  /** Session windows this agent has closed over its lifetime — the pace the
   *  lifetime timescale (replay eval → consolidation → MCTS) runs at. Durable
   *  because no agent instance outlives it: a `proteus exec` process handles
   *  one turn, and a Durable Object is evicted between requests. */
  closedSessionWindows: 'closed_session_windows',
  /** Total outcome-labeled instances a GEPA run draws into its train/val
   *  split (buildOutcomeEvalSplit) — see DEFAULT_GEPA_EVAL_BUDGET. */
  gepaEvalBudget: 'gepa_eval_budget',
  /** Operator-tuned MCTS knobs (Settings UI / setMctsConfig). Unset = engine
   *  defaults (DEFAULT_CONFIG.mcts) at the call site. */
  mctsExplorationWeight: 'mcts_c',
  mctsBudget: 'mcts_iterations',
  mctsMaxDepth: 'mcts_depth',
  mctsBranches: 'mcts_branches',
  mctsJudgeSamples: 'mcts_judge_samples',
  mctsMaxEvalLLMCalls: 'mcts_eval_llm_calls',
  /** 'false' silences owner emails (changelog digests, job completions).
   *  Defaults on; sends only happen when the platform email pieces exist. */
  emailNotifications: 'email_notifications',
  /** One-time semantic-memory backfill markers. Vectorize was added after FTS5,
   *  so chunks indexed earlier are embedded lazily on boot. 'true' once the whole
   *  memory_chunks table is embedded; the cursor pages a large table across boots
   *  without re-embedding. Internal plumbing — accessed via generic get/set. */
  memoryVectorBackfillDone: 'memory_vector_backfill_done',
  memoryVectorBackfillCursor: 'memory_vector_backfill_cursor',
} as const;
export type AgentConfigKey = (typeof AGENT_CONFIG_KEYS)[keyof typeof AGENT_CONFIG_KEYS];

export interface AgentConfigStore {
  // ── Generic accessors ──
  /** Read a single config value. Returns null if unset. */
  get(key: string): string | null;
  /** Write (upsert) a config value. */
  set(key: string, value: string): void;
  /** Delete a config value. No-op if absent. */
  delete(key: string): void;
  /** All config rows as a plain object. Used by fork.ts to copy state. */
  all(): Record<string, string>;

  // ── Typed accessors for known keys ──
  getModel(): string | null;
  setModel(spec: string): void;
  getReasoningEffort(): ReasoningEffort | null;
  setReasoningEffort(effort: ReasoningEffort): void;
  getDisplayName(): string | null;
  setDisplayName(name: string): void;
  getNameOrigin(): 'user' | 'auto' | null;
  setNameOrigin(origin: 'user' | 'auto'): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): void;
  getSleepTimeComputeEnabled(): boolean;
  setSleepTimeComputeEnabled(enabled: boolean): void;
  getAutoPromoteScaffold(): boolean;
  setAutoPromoteScaffold(enabled: boolean): void;
  /** Fraction of turns that also run through the candidate scaffold for the
   *  shadow verdict (0..1, default 0.25). */
  getShadowSampleRate(): number;
  setShadowSampleRate(rate: number): void;
  /** Archive-exploration share for proposal base selection (0..1, default 0.2). */
  getScaffoldExploreShare(): number;
  setScaffoldExploreShare(share: number): void;
  /** The model the agent's own output is judged on, or null to let
   *  selectJudgeModel pick a cross-family one. */
  getReviewModel(): string | null;
  /** Pin the review model; null / blank clears the pin. */
  setReviewModel(spec: string | null): void;
  /** Skills the operator has pinned as always-active for this agent. */
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void;
  /** The executor namespace the agent last ran a tool in, or null. */
  getLastActiveExecutor(): string | null;
  /** Record the last-active executor. Ignores values that aren't a plausible
   *  executor namespace (defense against a poisoned config value). */
  setLastActiveExecutor(name: string): void;
  /** The persisted /workspace backup handle, or null if none / malformed. */
  getWorkspaceBackup(): DirectoryBackup | null;
  /** Persist the latest /workspace backup handle and stamp the backup time. */
  setWorkspaceBackup(backup: DirectoryBackup): void;
  /** Epoch ms of the last successful /workspace backup, or 0. */
  getWorkspaceBackupAt(): number;
  /** Turns-of-new-traces between auto-GEPA passes (0 = disabled; unset
   *  defaults to DEFAULT_AUTO_GEPA_EVERY_N_TURNS). */
  getAutoGepaEveryNTurns(): number;
  /** Set the auto-GEPA cadence (turns). 0 / negative explicitly disables. */
  setAutoGepaEveryNTurns(n: number): void;
  /** Epoch ms of the last changelog view (0 = never seen). */
  getChangelogSeenAt(): number;
  setChangelogSeenAt(ms: number): void;
  /** Count one more closed session window and return the new lifetime total. */
  countClosedSessionWindow(): number;
  /** GEPA eval budget — labeled instances per run (train + val). See
   *  DEFAULT_GEPA_EVAL_BUDGET / clampGepaEvalBudget. */
  getGepaEvalBudget(): number;
  /** Set the GEPA eval budget. Clamped to the settable range rather than
   *  rejected: the bounds are a cost policy, not a correctness constraint. */
  setGepaEvalBudget(n: number): void;
  /** Operator MCTS overrides — only the explicitly-set, valid knobs. Spread
   *  into runMCTS call sites so unset knobs keep engine defaults. */
  getMctsOverrides(): MctsOverrides;
  /** Persist MCTS overrides; undefined fields are left untouched. */
  setMctsOverrides(overrides: MctsOverrides): void;
  /** Owner-email notifications (changelog digests, job completions). */
  getEmailNotificationsEnabled(): boolean;
  setEmailNotificationsEnabled(enabled: boolean): void;
}

export interface MctsOverrides {
  explorationWeight?: number;
  budget?: number;
  maxDepth?: number;
  branches?: number;
  /** Judge ensemble size per branch evaluation (median-aggregated). */
  judgeSamples?: number;
  /** Per-branch evaluation LLM-call budget (assertions + judge samples). */
  maxEvalLLMCalls?: number;
}

/** Default auto-GEPA cadence when the agent has no explicit setting: one
 *  pass per 25 turns of new traces. Frequent enough to keep learning from
 *  fresh outcome labels, sparse enough that each pass sees a genuinely new
 *  eval split (the trace-driven counter pauses it on idle agents anyway). */
export const DEFAULT_AUTO_GEPA_EVERY_N_TURNS = 25;

/**
 * Outcome-labeled instances one GEPA pass draws (train + val together).
 * Every instance in `val` costs a full scaffold execution plus a judge call
 * for EVERY candidate scored, so this is the dominant cost knob — and the
 * thing that decides whether the winner's score means anything. 24 draws ~12
 * failures (8 to reflect on, 4 held out) and ~12 accepted guards, putting ~16
 * instances under every candidate. 95% half-width at an aggregate of 0.5:
 * ±0.28 on the old 8-instance split, ±0.22 at 16, ±0.19 at 24, ±0.14 at 48 —
 * cost is linear in instances while the width falls off as 1/√n, so this is
 * the last doubling that buys much. The per-instance Pareto comparison is
 * paired across candidates and resolves finer than the absolute aggregate.
 */
export const DEFAULT_GEPA_EVAL_BUDGET = 24;

/** The operator-settable range for the GEPA eval budget. The floor keeps a
 *  disjoint split possible at all (2 failures + 2 guards); the ceiling is the
 *  most an operator can spend on one pass. */
export function clampGepaEvalBudget(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 4), 64) : DEFAULT_GEPA_EVAL_BUDGET;
}

/** Validate a rate/share setting. Rejects rather than clamps: an out-of-range
 *  probability is a caller bug, and silently storing 1 for 100 would hide it. */
function unitInterval(key: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid ${key}: ${value} (expected a fraction between 0 and 1)`);
  }
  return value;
}

export function initAgentConfigTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  )`);
}

export function createAgentConfigStore(sql: SqlExecutor): AgentConfigStore {
  const get = (key: string): string | null => {
    try {
      const rows = sql<{ value: string }>`
        SELECT value FROM agent_config WHERE key = ${key} LIMIT 1`;
      return rows[0]?.value ?? null;
    } catch { return null; }
  };
  const set = (key: string, value: string): void => {
    sql`INSERT INTO agent_config (key, value) VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  };
  return {
    get,
    set,
    delete(key) { sql`DELETE FROM agent_config WHERE key = ${key}`; },
    all() {
      try {
        const rows = sql<{ key: string; value: string }>`SELECT key, value FROM agent_config`;
        const out: Record<string, string> = {};
        for (const r of rows) out[r.key] = r.value;
        return out;
      } catch { return {}; }
    },
    getModel() { return get(AGENT_CONFIG_KEYS.model); },
    setModel(spec) { set(AGENT_CONFIG_KEYS.model, spec); },
    getReasoningEffort() {
      const effort = get(AGENT_CONFIG_KEYS.reasoningEffort);
      return isReasoningEffort(effort) ? effort : null;
    },
    setReasoningEffort(effort) {
      if (!isReasoningEffort(effort)) throw new Error(`Invalid reasoning effort: ${String(effort)}`);
      set(AGENT_CONFIG_KEYS.reasoningEffort, effort);
    },
    getDisplayName() { return get(AGENT_CONFIG_KEYS.displayName); },
    setDisplayName(name) { set(AGENT_CONFIG_KEYS.displayName, name); },
    getNameOrigin() { const v = get(AGENT_CONFIG_KEYS.nameOrigin); return v === 'user' || v === 'auto' ? v : null; },
    setNameOrigin(origin) { set(AGENT_CONFIG_KEYS.nameOrigin, origin); },
    getShellApprovalMode(): ShellApprovalMode {
      const v = get(AGENT_CONFIG_KEYS.shellApprovalMode);
      return v === 'allow_all' || v === 'deny_all' ? v : 'strict';
    },
    setShellApprovalMode(mode) { set(AGENT_CONFIG_KEYS.shellApprovalMode, mode); },
    // Autonomy switches default ON (the "unleash, don't cap" flip): the
    // Evolution Changelog makes every self-change visible and revertable,
    // and the misevolution gate + shadow veto + archive are the safety net.
    // Only an explicit 'false' opts out — stored values always win.
    getSleepTimeComputeEnabled() {
      return get(AGENT_CONFIG_KEYS.sleepTimeCompute) !== 'false';
    },
    setSleepTimeComputeEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.sleepTimeCompute, enabled ? 'true' : 'false');
    },
    getAutoPromoteScaffold() {
      return get(AGENT_CONFIG_KEYS.autoPromoteScaffold) !== 'false';
    },
    setAutoPromoteScaffold(enabled) {
      set(AGENT_CONFIG_KEYS.autoPromoteScaffold, enabled ? 'true' : 'false');
    },
    getShadowSampleRate() {
      const v = get(AGENT_CONFIG_KEYS.shadowSampleRate);
      const n = v ? Number(v) : 0.25;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25;
    },
    setShadowSampleRate(rate) { set(AGENT_CONFIG_KEYS.shadowSampleRate, String(unitInterval('shadow_sample_rate', rate))); },
    getScaffoldExploreShare() {
      const v = get(AGENT_CONFIG_KEYS.scaffoldExploreShare);
      const n = v ? Number(v) : 0.2;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
    },
    setScaffoldExploreShare(share) { set(AGENT_CONFIG_KEYS.scaffoldExploreShare, String(unitInterval('scaffold_explore_share', share))); },
    getReviewModel() { return get(AGENT_CONFIG_KEYS.reviewModel); },
    setReviewModel(spec) {
      const trimmed = spec?.trim();
      if (trimmed) set(AGENT_CONFIG_KEYS.reviewModel, trimmed);
      else sql`DELETE FROM agent_config WHERE key = ${AGENT_CONFIG_KEYS.reviewModel}`;
    },
    getAlwaysActiveSkills() {
      const v = get(AGENT_CONFIG_KEYS.alwaysActiveSkills);
      if (!v) return [];
      return v.split(',').map(s => s.trim()).filter(Boolean);
    },
    setAlwaysActiveSkills(names) {
      const v = Array.from(new Set(names.map(n => n.trim()).filter(Boolean))).join(',');
      if (v.length === 0) sql`DELETE FROM agent_config WHERE key = ${AGENT_CONFIG_KEYS.alwaysActiveSkills}`;
      else set(AGENT_CONFIG_KEYS.alwaysActiveSkills, v);
    },
    getLastActiveExecutor() { return get(AGENT_CONFIG_KEYS.lastActiveExecutor); },
    setLastActiveExecutor(name) {
      // Provider namespaces are short identifiers; reject anything else so a
      // bad value can't poison the UI default. Not a fixed allow-list (executors
      // are registered dynamically) — just a shape check.
      if (/^[a-z0-9_-]{1,32}$/i.test(name)) set(AGENT_CONFIG_KEYS.lastActiveExecutor, name);
    },
    getWorkspaceBackup() {
      const v = get(AGENT_CONFIG_KEYS.workspaceBackup);
      if (!v) return null;
      try {
        const o = JSON.parse(v) as Partial<DirectoryBackup>;
        if (typeof o?.id === 'string' && typeof o?.dir === 'string') {
          return { id: o.id, dir: o.dir, localBucket: o.localBucket };
        }
      } catch { /* malformed → treat as no backup */ }
      return null;
    },
    setWorkspaceBackup(backup) {
      set(AGENT_CONFIG_KEYS.workspaceBackup, JSON.stringify({ id: backup.id, dir: backup.dir, localBucket: backup.localBucket }));
      set(AGENT_CONFIG_KEYS.workspaceBackupAt, String(Date.now()));
    },
    getWorkspaceBackupAt() {
      const n = Number(get(AGENT_CONFIG_KEYS.workspaceBackupAt));
      return Number.isFinite(n) ? n : 0;
    },
    getAutoGepaEveryNTurns() {
      const raw = get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns);
      if (raw == null) return DEFAULT_AUTO_GEPA_EVERY_N_TURNS;
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    setAutoGepaEveryNTurns(n) {
      // Persist 0 explicitly — unset now means "autonomous default", so a
      // deliberate disable must stick as a stored value.
      const value = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      set(AGENT_CONFIG_KEYS.autoGepaEveryNTurns, String(value));
    },
    getGepaEvalBudget() {
      const raw = get(AGENT_CONFIG_KEYS.gepaEvalBudget);
      if (raw == null) return DEFAULT_GEPA_EVAL_BUDGET;
      const n = Number(raw);
      return Number.isFinite(n) ? clampGepaEvalBudget(n) : DEFAULT_GEPA_EVAL_BUDGET;
    },
    setGepaEvalBudget(n) { set(AGENT_CONFIG_KEYS.gepaEvalBudget, String(clampGepaEvalBudget(n))); },
    getChangelogSeenAt() {
      const n = Number(get(AGENT_CONFIG_KEYS.changelogSeenAt));
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    setChangelogSeenAt(ms) {
      if (Number.isFinite(ms) && ms > 0) set(AGENT_CONFIG_KEYS.changelogSeenAt, String(Math.floor(ms)));
    },
    countClosedSessionWindow() {
      const previous = Math.floor(Number(get(AGENT_CONFIG_KEYS.closedSessionWindows)));
      const next = (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
      set(AGENT_CONFIG_KEYS.closedSessionWindows, String(next));
      return next;
    },
    getMctsOverrides() {
      const positive = (key: string): number | undefined => {
        const raw = get(key);
        if (raw == null) return undefined;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const out: MctsOverrides = {};
      const w = positive(AGENT_CONFIG_KEYS.mctsExplorationWeight);
      const budget = positive(AGENT_CONFIG_KEYS.mctsBudget);
      const maxDepth = positive(AGENT_CONFIG_KEYS.mctsMaxDepth);
      const branches = positive(AGENT_CONFIG_KEYS.mctsBranches);
      const judgeSamples = positive(AGENT_CONFIG_KEYS.mctsJudgeSamples);
      const maxEvalLLMCalls = positive(AGENT_CONFIG_KEYS.mctsMaxEvalLLMCalls);
      if (w !== undefined) out.explorationWeight = w;
      if (budget !== undefined) out.budget = Math.floor(budget);
      if (maxDepth !== undefined) out.maxDepth = Math.floor(maxDepth);
      if (branches !== undefined) out.branches = Math.floor(branches);
      if (judgeSamples !== undefined) out.judgeSamples = Math.floor(judgeSamples);
      if (maxEvalLLMCalls !== undefined) out.maxEvalLLMCalls = Math.floor(maxEvalLLMCalls);
      return out;
    },
    setMctsOverrides(overrides) {
      const write = (key: string, value: number | undefined, integer: boolean) => {
        if (value === undefined) return;
        if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid MCTS setting for ${key}: ${value}`);
        set(key, String(integer ? Math.floor(value) : value));
      };
      write(AGENT_CONFIG_KEYS.mctsExplorationWeight, overrides.explorationWeight, false);
      write(AGENT_CONFIG_KEYS.mctsBudget, overrides.budget, true);
      write(AGENT_CONFIG_KEYS.mctsMaxDepth, overrides.maxDepth, true);
      write(AGENT_CONFIG_KEYS.mctsBranches, overrides.branches, true);
      write(AGENT_CONFIG_KEYS.mctsJudgeSamples, overrides.judgeSamples, true);
      write(AGENT_CONFIG_KEYS.mctsMaxEvalLLMCalls, overrides.maxEvalLLMCalls, true);
    },
    getEmailNotificationsEnabled() {
      return get(AGENT_CONFIG_KEYS.emailNotifications) !== 'false';
    },
    setEmailNotificationsEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.emailNotifications, enabled ? 'true' : 'false');
    },
  };
}
