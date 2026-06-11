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

export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Known config keys. Adding one here forces a typed getter/setter — that
 *  catches typos at compile time. */
export const AGENT_CONFIG_KEYS = {
  model: 'model',
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
  toolSurfacingMode: 'tool_surfacing_mode',
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
   *  (0 = off). Trace-driven, not clock-driven. */
  autoGepaEveryNTurns: 'auto_gepa_every_n_turns',
  /** Operator-tuned MCTS knobs (Settings UI / setMctsConfig). Unset = engine
   *  defaults (DEFAULT_CONFIG.mcts) at the call site. */
  mctsExplorationWeight: 'mcts_c',
  mctsBudget: 'mcts_iterations',
  mctsMaxDepth: 'mcts_depth',
  mctsBranches: 'mcts_branches',
  mctsJudgeSamples: 'mcts_judge_samples',
  mctsMaxEvalLLMCalls: 'mcts_eval_llm_calls',
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
  getDisplayName(): string | null;
  setDisplayName(name: string): void;
  getNameOrigin(): 'user' | 'auto' | null;
  setNameOrigin(origin: 'user' | 'auto'): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): void;
  getSleepTimeComputeEnabled(): boolean;
  setSleepTimeComputeEnabled(enabled: boolean): void;
  getAutoPromoteScaffold(): boolean;
  getShadowSampleRate(): number;
  /** Archive-exploration share for proposal base selection (0..1, default 0.2). */
  getScaffoldExploreShare(): number;
  getToolSurfacingMode(): 'all' | 'relevant';
  getReviewModel(): string | null;
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
  /** Turns-of-new-traces between auto-GEPA passes (0 = disabled). */
  getAutoGepaEveryNTurns(): number;
  /** Set the auto-GEPA cadence (turns). 0 / negative disables. */
  setAutoGepaEveryNTurns(n: number): void;
  /** Operator MCTS overrides — only the explicitly-set, valid knobs. Spread
   *  into runMCTS call sites so unset knobs keep engine defaults. */
  getMctsOverrides(): MctsOverrides;
  /** Persist MCTS overrides; undefined fields are left untouched. */
  setMctsOverrides(overrides: MctsOverrides): void;
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
    getDisplayName() { return get(AGENT_CONFIG_KEYS.displayName); },
    setDisplayName(name) { set(AGENT_CONFIG_KEYS.displayName, name); },
    getNameOrigin() { const v = get(AGENT_CONFIG_KEYS.nameOrigin); return v === 'user' || v === 'auto' ? v : null; },
    setNameOrigin(origin) { set(AGENT_CONFIG_KEYS.nameOrigin, origin); },
    getShellApprovalMode(): ShellApprovalMode {
      const v = get(AGENT_CONFIG_KEYS.shellApprovalMode);
      return v === 'allow_all' || v === 'deny_all' ? v : 'strict';
    },
    setShellApprovalMode(mode) { set(AGENT_CONFIG_KEYS.shellApprovalMode, mode); },
    getSleepTimeComputeEnabled() {
      return get(AGENT_CONFIG_KEYS.sleepTimeCompute) === 'true';
    },
    setSleepTimeComputeEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.sleepTimeCompute, enabled ? 'true' : 'false');
    },
    getAutoPromoteScaffold() {
      return get(AGENT_CONFIG_KEYS.autoPromoteScaffold) === 'true';
    },
    getShadowSampleRate() {
      const v = get(AGENT_CONFIG_KEYS.shadowSampleRate);
      const n = v ? Number(v) : 0.25;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25;
    },
    getScaffoldExploreShare() {
      const v = get(AGENT_CONFIG_KEYS.scaffoldExploreShare);
      const n = v ? Number(v) : 0.2;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
    },
    getToolSurfacingMode() {
      const v = get(AGENT_CONFIG_KEYS.toolSurfacingMode);
      return v === 'relevant' ? 'relevant' : 'all';
    },
    getReviewModel() { return get(AGENT_CONFIG_KEYS.reviewModel); },
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
      const n = Math.floor(Number(get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns)));
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    setAutoGepaEveryNTurns(n) {
      if (Number.isFinite(n) && n > 0) set(AGENT_CONFIG_KEYS.autoGepaEveryNTurns, String(Math.floor(n)));
      else sql`DELETE FROM agent_config WHERE key = ${AGENT_CONFIG_KEYS.autoGepaEveryNTurns}`;
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
  };
}
