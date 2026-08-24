// AgentConfigStore — typed accessors over the `agent_config` key/value table.
//
// Before this, 23 raw `SELECT ... FROM agent_config` / `INSERT OR REPLACE ...`
// sites were scattered across orchestrator.ts, runtime.ts, head-runtime.ts,
// fork.ts. Adding a new tunable meant editing schema + 5 different files.
//
// The store is a deep module (small interface, real behavior): typed getters
// for known keys, generic get/set/delete for everything else, all() for fork.
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import { isReasoningEffort, type ReasoningEffort } from '../strategy/effort';
import { isTierId, isValidRoleId, type RoleId, type TierId } from '../profiles/catalog';
import {
  DEFAULT_CACHE_RETENTION, isCacheRetention, type CacheRetention,
} from '../prompting/cache-breakpoints';
import {
  formatApprovalGrant, parseApprovalGrant, type ApprovalGrant,
} from '../safety/approval-gate';
import {
  DEFAULT_ADVISOR_MIN_SEVERITY, isAdvisorSeverity, type AdvisorSeverity,
} from '../advisor/review';

export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Known config keys. Adding one here forces a typed getter/setter — that
 *  catches typos at compile time. */
export const AGENT_CONFIG_KEYS = {
  model: 'model',
  reasoningEffort: 'reasoning_effort',
  /** How long providers should keep this agent's prompt-cache prefix
   *  (prompting/cache-breakpoints.ts). Unset = the provider default TTL. */
  cacheRetention: 'cache_retention',
  displayName: 'display_name',
  /** 'user' once the operator sets a name explicitly — suppresses auto-titling. */
  nameOrigin: 'name_origin',
  /** The agent's durable active role (profiles/catalog.ts). The NEXT turn
   *  resolves it; a running step keeps the profile it already resolved.
   *  Unset reads as `general` — and a pre-profile `agent_stance` value
   *  migrates into it on first read. */
  activeRoleId: 'active_role_id',
  /** The owner's self-switch policy: 'allow' | 'approval' | 'locked'. */
  roleChangePolicy: 'role_change_policy',
  /** The inference tier a PARENT pinned on this agent when it hired it.
   *
   *  Unset is the ordinary case and it is not a default: it means no tier was
   *  pinned, so the turn boundary derives one from the role, which is the
   *  documented promise that "a role's own default tier is re-derived by the
   *  child at its next turn boundary from its roleId". A pin is what a hire
   *  with an EXPLICIT tier leaves behind, because that choice is not
   *  recoverable from the roleId. */
  assignedTier: 'assigned_tier',
  /** The shell-approval MODE the owner set (strict | allow_all | deny_all). */
  shellApprovalMode: 'shell_approval_mode',
  /** Comma-separated `<rule>@<executor>` pairs the owner has said "always" to.
   *  Sits beside the approval MODE deliberately: both are the same knob — how
   *  much the gate asks — read live at exec time, revocable in one place. */
  shellApprovalGrants: 'shell_approval_grants',
  sleepTimeCompute: 'sleep_time_compute',
  autoPromoteScaffold: 'auto_promote_scaffold',
  shadowSampleRate: 'shadow_sample_rate',
  /** Fraction of scaffold proposals that branch from an archived variant
   *  instead of the live current (DGM archive exploration). */
  scaffoldExploreShare: 'scaffold_explore_share',
  advisorMinSeverity: 'advisor_min_severity',
  /** 'true' switches the turn reviewer on. Off by default: it is one more model
   *  call per turn, and the owner pays for it. */
  advisorEnabled: 'advisor_enabled',
  /** Comma-separated list of skill names the operator wants always-on. */
  alwaysActiveSkills: 'always_active_skills',
  /** The executor namespace the agent most recently ran a tool in — so the UI
   *  (diff / file manager) defaults to where work actually happened. */
  lastActiveExecutor: 'last_active_executor',
  /** Run GEPA self-optimization after this many turns of new execution traces
   *  (0 = off; unset = the autonomous default cadence). Trace-driven, not
   *  clock-driven. */
  autoGepaEveryNTurns: 'auto_gepa_every_n_turns',
  /** Epoch ms of the operator's last Evolution Changelog view — entries newer
   *  than this drive the unseen badge. */
  changelogSeenAt: 'changelog_seen_at',
  /** Turn windows this agent has closed over its lifetime. The lifetime
   * timescale runs replay evaluation and consolidation at this pace. */
  closedTurnWindows: 'closed_turn_windows',
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
  /** Constructions of this agent object, bumped once per activation. The span
   *  attribute `kinu.isolate_gen` — persisted BECAUSE a boot-time counter
   *  cannot see a reconstruction that reuses the isolate, which is how a Kinu
   *  fork most commonly dies (`ctx.facets.abort()`). */
  isolateGen: 'isolate_gen',
} as const;


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
  /** Prompt-cache retention for this agent's turns. Always answers — an unset
   *  or malformed row reads as the `short` default, so the caching seam never
   *  has to decide what a missing value means. */
  getCacheRetention(): CacheRetention;
  setCacheRetention(retention: CacheRetention): void;
  getDisplayName(): string | null;
  setDisplayName(name: string): void;
  getNameOrigin(): 'user' | 'auto' | null;
  setNameOrigin(origin: 'user' | 'auto'): void;
  /** Persist the visible title and its ownership in one SQLite statement. */
  setDisplayNameOrigin(name: string, origin: 'user' | 'auto'): void;
  /** The agent's durable active role. Always answers: unset reads as
   *  `general`, and a pre-profile `agent_stance` value migrates into the
   *  role on first read (research→researcher, build→implementer,
   *  audit→auditor). */
  getActiveRoleId(): RoleId;
  /** Set the agent's durable active role. The NEXT resolved turn reads it; a
   *  running step keeps the profile it already resolved (profiles/
   *  role-change.ts). This is the writer a hire uses to seed a child's role,
   *  and the reason it is typed: the value must be a catalog role id, and a
   *  generic `set` let an unvalidated string reach a reader that answers
   *  `general` for anything it does not recognise — a dropped assignment that
   *  looks exactly like an agent nobody assigned. */
  setActiveRoleId(roleId: RoleId): void;
  /** The tier a parent pinned at hire, or null when none was. Null is the
   *  instruction to derive from the role rather than a tier of its own, so
   *  callers pass `?? undefined` as the resolver's `explicitTier`. */
  getAssignedTier(): TierId | null;
  /** Pin the hired tier, or clear it with null. */
  setAssignedTier(tier: TierId | null): void;
  /** The owner's self-switch policy for this agent. Unset reads as `allow`. */
  getRoleChangePolicy(): 'allow' | 'approval' | 'locked';
  setRoleChangePolicy(policy: 'allow' | 'approval' | 'locked'): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): void;
  /** Standing (rule, executor) grants. Never widens what a command may reach;
   *  it only stops the gate asking again about a kind of command the owner has
   *  already blessed in one place. */
  getShellApprovalGrants(): ApprovalGrant[];
  /** Remember one or more grants. Idempotent — granting twice is one grant. */
  grantShellApproval(grants: readonly ApprovalGrant[]): void;
  /** Forget grants. An unknown grant is not an error: revoking twice is one
   *  revocation, which is what a UI that can double-submit needs. */
  revokeShellApproval(grants: readonly ApprovalGrant[]): void;
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
  /** Whether the turn reviewer runs. False unless the owner switched it on. */
  getAdvisorEnabled(): boolean;
  setAdvisorEnabled(enabled: boolean): void;
  /** The lowest severity that reaches the conversation. Always answers: unset
   *  or unknown reads as `concern`, so the delivery seam never has to decide
   *  what a missing floor means. */
  getAdvisorMinSeverity(): AdvisorSeverity;
  setAdvisorMinSeverity(severity: AdvisorSeverity): void;
  /** Skills the operator has pinned as always-active for this agent. */
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void;
  /** The executor namespace the agent last ran a tool in, or null. */
  getLastActiveExecutor(): string | null;
  /** Record the last-active executor. Ignores values that aren't a plausible
   *  executor namespace (defense against a poisoned config value). */
  setLastActiveExecutor(name: string): void;
  /** Turns-of-new-traces between auto-GEPA passes (0 = disabled; unset
   *  defaults to DEFAULT_AUTO_GEPA_EVERY_N_TURNS). */
  getAutoGepaEveryNTurns(): number;
  /** Set the auto-GEPA cadence (turns). 0 / negative explicitly disables. */
  setAutoGepaEveryNTurns(n: number): void;
  /** Epoch ms of the last changelog view (0 = never seen). */
  getChangelogSeenAt(): number;
  setChangelogSeenAt(ms: number): void;
  /** Count one more closed turn window and return the new lifetime total. */
  countClosedTurnWindow(): number;
  /** Count one more construction of this agent object and return the new
   *  generation. Called once per activation, from `onStart`; the RETURNED value is
   *  what every span carries, so a discontinuity between two spans on one
   *  `selfPath` is a positive reset signal instead of an inferred one. */
  countIsolateGeneration(): number;
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
    const rows = sql<{ value: string }>`
      SELECT value FROM agent_config WHERE key = ${key} LIMIT 1`;
    return rows[0]?.value ?? null;
  };
  const set = (key: string, value: string): void => {
    void sql`INSERT INTO agent_config (key, value) VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  };
  /** Read-modify-write of a monotone counter, returning the new value. Shared by
   *  the two lifetime counters here — closed session windows, and isolate
   *  generations — because they differ only in their key and a byte-identical
   *  second copy is what `gate:duplication` exists to reject. An absent, empty or
   *  unparseable row reads as 0, so a first bump answers 1: the caller uses the
   *  RETURN value, and `null` would make it decide what an unwritten counter means.
   */
  const increment = (key: string): number => {
    const previous = Math.floor(Number(get(key)));
    const next = (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
    set(key, String(next));
    return next;
  };
  /** Reads in the parsed domain, so an unparseable token is not just ignored
   *  on read but dropped on the next write — the row never accretes rubbish a
   *  human has to look at when they go to revoke something. */
  const storedGrants = (): ApprovalGrant[] => {
    const raw = get(AGENT_CONFIG_KEYS.shellApprovalGrants) ?? '';
    return raw.split(',').map(parseApprovalGrant).filter((g) => g !== null);
  };
  const writeGrants = (grants: readonly ApprovalGrant[]): void => {
    const value = [...new Set(grants.map(formatApprovalGrant))].join(',');
    if (value.length === 0) void sql`DELETE FROM agent_config WHERE key = ${AGENT_CONFIG_KEYS.shellApprovalGrants}`;
    else set(AGENT_CONFIG_KEYS.shellApprovalGrants, value);
  };
  return {
    get,
    set,
    delete(key) { void sql`DELETE FROM agent_config WHERE key = ${key}`; },
    all() {
      const rows = sql<{ key: string; value: string }>`SELECT key, value FROM agent_config`;
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
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
    getCacheRetention() {
      const value = get(AGENT_CONFIG_KEYS.cacheRetention);
      return isCacheRetention(value) ? value : DEFAULT_CACHE_RETENTION;
    },
    setCacheRetention(retention) {
      if (!isCacheRetention(retention)) throw new Error(`Invalid cache retention: ${String(retention)}`);
      set(AGENT_CONFIG_KEYS.cacheRetention, retention);
    },
    getDisplayName() { return get(AGENT_CONFIG_KEYS.displayName); },
    setDisplayName(name) { set(AGENT_CONFIG_KEYS.displayName, name); },
    getNameOrigin() { const v = get(AGENT_CONFIG_KEYS.nameOrigin); return v === 'user' || v === 'auto' ? v : null; },
    setNameOrigin(origin) { set(AGENT_CONFIG_KEYS.nameOrigin, origin); },
    setDisplayNameOrigin(name, origin) {
      void sql`
        INSERT INTO agent_config (key, value) VALUES
          (${AGENT_CONFIG_KEYS.displayName}, ${name}),
          (${AGENT_CONFIG_KEYS.nameOrigin}, ${origin})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `;
    },
    getActiveRoleId(): RoleId {
      const stored = get(AGENT_CONFIG_KEYS.activeRoleId);
      if (stored !== null) return isValidRoleId(stored) ? stored : 'general';
      // One-time stance→role migration: the pre-profile behavior selection
      // maps onto the catalog role that carries the same intent, then the
      // legacy key dies. Unknown values read as `general` and are dropped.
      const legacy = get('agent_stance');
      const mapped = legacy === 'research' ? 'researcher'
        : legacy === 'build' ? 'implementer'
        : legacy === 'audit' ? 'auditor'
        : legacy === 'general' ? 'general'
        : null;
      if (mapped !== null) set(AGENT_CONFIG_KEYS.activeRoleId, mapped);
      if (legacy !== null) void sql`DELETE FROM agent_config WHERE key = ${'agent_stance'}`;
      return mapped ?? 'general';
    },
    setActiveRoleId(roleId) { set(AGENT_CONFIG_KEYS.activeRoleId, roleId); },
    getAssignedTier(): TierId | null {
      const stored = get(AGENT_CONFIG_KEYS.assignedTier);
      // An unrecognised value reads as unpinned rather than throwing: the
      // honest answer for a tier this build does not know is "no pin", and the
      // role's own tier is a working turn instead of a dead agent.
      return stored !== null && isTierId(stored) ? stored : null;
    },
    setAssignedTier(tier) {
      if (tier === null) {
        void sql`DELETE FROM agent_config WHERE key = ${AGENT_CONFIG_KEYS.assignedTier}`;
        return;
      }
      set(AGENT_CONFIG_KEYS.assignedTier, tier);
    },
    getRoleChangePolicy(): 'allow' | 'approval' | 'locked' {
      const v = get(AGENT_CONFIG_KEYS.roleChangePolicy);
      return v === 'approval' || v === 'locked' ? v : 'allow';
    },
    setRoleChangePolicy(policy) { set(AGENT_CONFIG_KEYS.roleChangePolicy, policy); },
    getShellApprovalMode(): ShellApprovalMode {
      const v = get(AGENT_CONFIG_KEYS.shellApprovalMode);
      return v === 'allow_all' || v === 'deny_all' ? v : 'strict';
    },
    setShellApprovalMode(mode) { set(AGENT_CONFIG_KEYS.shellApprovalMode, mode); },
    getShellApprovalGrants: storedGrants,
    grantShellApproval(grants) { writeGrants([...storedGrants(), ...grants]); },
    revokeShellApproval(grants) {
      const dropped = new Set(grants.map(formatApprovalGrant));
      writeGrants(storedGrants().filter((g) => !dropped.has(formatApprovalGrant(g))));
    },
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
    getAdvisorEnabled() { return get(AGENT_CONFIG_KEYS.advisorEnabled) === 'true'; },
    setAdvisorEnabled(enabled) { set(AGENT_CONFIG_KEYS.advisorEnabled, String(enabled)); },
    getAdvisorMinSeverity() {
      const stored = get(AGENT_CONFIG_KEYS.advisorMinSeverity);
      return isAdvisorSeverity(stored) ? stored : DEFAULT_ADVISOR_MIN_SEVERITY;
    },
    setAdvisorMinSeverity(severity) { set(AGENT_CONFIG_KEYS.advisorMinSeverity, severity); },
    getAlwaysActiveSkills() {
      const v = get(AGENT_CONFIG_KEYS.alwaysActiveSkills);
      if (!v) return [];
      return v.split(',').map(s => s.trim()).filter(Boolean);
    },
    setAlwaysActiveSkills(names) {
      const v = Array.from(new Set(names.map(n => n.trim()).filter(Boolean))).join(',');
      if (v.length === 0) void sql`DELETE FROM agent_config WHERE key = ${AGENT_CONFIG_KEYS.alwaysActiveSkills}`;
      else set(AGENT_CONFIG_KEYS.alwaysActiveSkills, v);
    },
    getLastActiveExecutor() { return get(AGENT_CONFIG_KEYS.lastActiveExecutor); },
    setLastActiveExecutor(name) {
      // Provider namespaces are short identifiers; reject anything else so a
      // bad value can't poison the UI default. Not a fixed allow-list (executors
      // are registered dynamically) — just a shape check.
      if (/^[a-z0-9_-]{1,32}$/i.test(name)) set(AGENT_CONFIG_KEYS.lastActiveExecutor, name);
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
    countClosedTurnWindow() {
      if (get(AGENT_CONFIG_KEYS.closedTurnWindows) === null) {
        const legacy = get('closed_session_windows');
        if (legacy !== null) set(AGENT_CONFIG_KEYS.closedTurnWindows, legacy);
        void sql`DELETE FROM agent_config WHERE key = ${'closed_session_windows'}`;
      }
      return increment(AGENT_CONFIG_KEYS.closedTurnWindows);
    },
    countIsolateGeneration() {
      return increment(AGENT_CONFIG_KEYS.isolateGen);
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
