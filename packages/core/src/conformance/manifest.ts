/**
 * Backend conformance manifest — the declared capability surface of every
 * composition root.
 *
 * The disease this kills: "X never worked on Y backend". Every builtin tool,
 * agents action, memory action and SQL table is dep-gated at a composition
 * root (`buildBuiltinTools`, `ensureSchema`, …), so a capability someone
 * forgot to wire is structurally indistinguishable from one deliberately left
 * out — absence carries no record of intent. This manifest is that record:
 * for each capability, each root either wires it or names the reason it does
 * not. A conformance test per root observes the REAL composition output (the
 * actual built ToolSet, the actual `sqlite_master`) and fails on any
 * disagreement, in either direction:
 *
 *   declared wired, not observed   → a forgotten wire, not a design decision
 *   declared absent, observed      → the manifest is stale; re-declare
 *   observed, not declared         → a new capability landed on one root;
 *                                    the Record types force a decision for
 *                                    EVERY root before it compiles
 *
 * That last direction is the structural guarantee: you cannot add a tool,
 * action or table to one backend without this file forcing an explicit
 * wired-or-absent decision for the others.
 *
 * This is test-plane declaration only. Production code never reads it.
 */

import { AGENTS_TOOL_ACTIONS, BUILTIN_TOOLS, MEMORY_FACT_ACTIONS, MEMORY_NOTE_ACTIONS } from '../tools/registry.js';
import type { AgentsToolAction, BuiltinToolName, MemoryToolAction } from '../tools/registry.js';

/** The composition roots that assemble a model-facing surface. cf splits by
 *  actor profile because the profiles deliberately differ (`actorToolDeps`);
 *  the CLI has one session class. */
export const CONFORMANCE_ROOTS = ['cf-orchestrator', 'cf-subordinate', 'cli'] as const;
export type ConformanceRoot = (typeof CONFORMANCE_ROOTS)[number];

/** Wired, or deliberately absent for a stated reason. There is no third
 *  state — "we forgot" is exactly what must not be representable. */
export type CapabilityStatus = { readonly wired: true } | { readonly absent: string };

export const WIRED: CapabilityStatus = { wired: true };

export type RootStatuses = Readonly<Record<ConformanceRoot, CapabilityStatus>>;

/** Shorthand: wired on every root. */
const EVERYWHERE: RootStatuses = { 'cf-orchestrator': WIRED, 'cf-subordinate': WIRED, cli: WIRED };

export const CONFORMANCE_PLANES = ['tool', 'agents-action', 'memory-action', 'table'] as const;
export type ConformancePlane = (typeof CONFORMANCE_PLANES)[number];

export interface ConformanceManifest {
  /** Builtin tools present in the root's built ToolSet. Keyed by the registry
   *  union, so a new registry tool cannot compile without a per-root decision. */
  readonly tool: Readonly<Record<BuiltinToolName, RootStatuses>>;
  /** Actions live in the `agents` tool's input schema (the enum the model
   *  sees). Keyed by the registry union. */
  readonly 'agents-action': Readonly<Record<AgentsToolAction, RootStatuses>>;
  /** Actions live in the `memory` tool's input schema. */
  readonly 'memory-action': Readonly<Record<MemoryToolAction, RootStatuses>>;
  /** SQL tables present after the root's real schema path has run. Open-keyed
   *  (there is no closed table type); the observed-but-undeclared direction is
   *  what forces new tables into this record. */
  readonly table: Readonly<Record<string, RootStatuses>>;
}

// ── Recurring reasons ────────────────────────────────────────────────────────

const SUBORDINATE_SCOPED = (what: string): string =>
  `${what} is a workspace-level surface; a subordinate reaches it through its orchestrator, not directly`;
const NO_USER_PLANE = (what: string): string =>
  `${what} rides the owner's UserDO; a local session has no user plane to serve it`;
const CF_ONLY_PLANE = (what: string): string => `${what} is a Cloudflare-plane feature with no local equivalent`;
const ORCHESTRATOR_IS_SINK = 'the orchestrator IS the report sink; only subordinate actors report upward';
const CLI_HAS_NO_STAFF = 'local sessions have no subordinate roster; the fork rung is the whole local ladder';
const LAZY_ON_FIRST_USE = (what: string): string => `created lazily on first use by ${what}, not at boot`;
const PRODUCT_CHANGE_TABLE: RootStatuses = {
  'cf-orchestrator': { absent: "the product-change board lives in the owner's UserDO on cf, not on the workspace DO" },
  'cf-subordinate': { absent: SUBORDINATE_SCOPED('the product-change lane') },
  cli: WIRED,
};

// ── The manifest ─────────────────────────────────────────────────────────────

export const BACKEND_CONFORMANCE: ConformanceManifest = {
  tool: {
    execute_tools: EVERYWHERE,
    run: EVERYWHERE,
    file: EVERYWHERE,
    skills: EVERYWHERE,
    agents: EVERYWHERE,
    memory: EVERYWHERE,
    web: EVERYWHERE,
    experience: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the experience library') },
      cli: { absent: NO_USER_PLANE('the cross-workspace experience library') },
    },
    report: {
      'cf-orchestrator': { absent: ORCHESTRATOR_IS_SINK },
      'cf-subordinate': WIRED,
      cli: { absent: `${ORCHESTRATOR_IS_SINK}, and ${CLI_HAS_NO_STAFF}` },
    },
    product_change: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the product-change lane') },
      cli: WIRED,
    },
  },

  'agents-action': {
    fork: EVERYWHERE,
    staff: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('staffing') },
      cli: { absent: CLI_HAS_NO_STAFF },
    },
    ask: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the team/peer transports') },
      cli: { absent: CLI_HAS_NO_STAFF },
    },
    send: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the team/peer transports') },
      cli: { absent: CLI_HAS_NO_STAFF },
    },
    reply: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('peer reply channels') },
      cli: { absent: NO_USER_PLANE('peer messaging') },
    },
    list: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the roster') },
      cli: { absent: CLI_HAS_NO_STAFF },
    },
    dismiss: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the roster') },
      cli: { absent: CLI_HAS_NO_STAFF },
    },
  },

  'memory-action': {
    save: EVERYWHERE,
    search: EVERYWHERE,
    sessions: EVERYWHERE,
    remember: EVERYWHERE,
    recall: EVERYWHERE,
    forget: EVERYWHERE,
  },

  table: {
    // ── the shared actor substrate (core initAllTables) ──
    workspace_identity: EVERYWHERE,
    messages: EVERYWHERE,
    conversation_history: EVERYWHERE,
    vfs_files: EVERYWHERE,
    crafted_tools: EVERYWHERE,
    craft_scores: EVERYWHERE,
    search_nodes: EVERYWHERE,
    fibers: EVERYWHERE,
    evolution_events: EVERYWHERE,
    executor_output: EVERYWHERE,
    activity_log: EVERYWHERE,
    fork_lineage: EVERYWHERE,
    scaffold_versions: EVERYWHERE,
    scaffold_regression_fixtures: EVERYWHERE,
    task_history: EVERYWHERE,
    scaffold_evaluations: EVERYWHERE,

    // ── evolution / outcome ledger ──
    turn_outcomes: EVERYWHERE,
    lessons: EVERYWHERE,
    outcome_labels: EVERYWHERE,
    outcome_ensemble_labels: EVERYWHERE,
    proposed_tasks: EVERYWHERE,

    // ── heads / exploration ──
    head_runs: EVERYWHERE,
    head_journal: EVERYWHERE,
    head_evidence: EVERYWHERE,
    head_steps: EVERYWHERE,
    head_merge_results: EVERYWHERE,
    mcts_search_runs: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: LAZY_ON_FIRST_USE('the MCTS engine') },
    },

    // ── events hub ──
    agent_log: EVERYWHERE,
    reply_channels: EVERYWHERE,
    triggers: EVERYWHERE,
    peer_outbox: EVERYWHERE,
    run_events: EVERYWHERE,

    // ── durable state ──
    agent_facts: EVERYWHERE,
    agent_config: EVERYWHERE,
    background_jobs: EVERYWHERE,
    compaction_state: EVERYWHERE,
    compaction_archive: EVERYWHERE,
    imported_experience: EVERYWHERE,

    // ── gepa ──
    gepa_runs: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: LAZY_ON_FIRST_USE('the GEPA persistence layer') },
    },
    gepa_candidates: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: LAZY_ON_FIRST_USE('the GEPA persistence layer') },
    },
    gepa_pareto_membership: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: LAZY_ON_FIRST_USE('the GEPA persistence layer') },
    },

    // ── product change ──
    // The board's home differs by backend and nothing recorded that until this
    // manifest: on cf it lives in the owner's UserDO (user-do.ts calls
    // initProductChangeTables), on the CLI it lives on the session db.
    product_source_bindings: PRODUCT_CHANGE_TABLE,
    product_change_requests: PRODUCT_CHANGE_TABLE,
    product_change_checks: PRODUCT_CHANGE_TABLE,
    product_change_approvals: PRODUCT_CHANGE_TABLE,
    product_deployments: PRODUCT_CHANGE_TABLE,

    // ── cf-orchestrator-local planes ──
    workspace_subordinates: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the roster') },
      cli: { absent: CLI_HAS_NO_STAFF },
    },
    subordinate_identity: {
      'cf-orchestrator': { absent: 'lives on each subordinate DO, seeded by setSubordinateIdentity' },
      'cf-subordinate': WIRED,
      cli: { absent: CLI_HAS_NO_STAFF },
    },
    webhook_rate_windows: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('webhook ingress') },
      cli: { absent: CF_ONLY_PLANE('webhook ingress') },
    },
    vfs_baseline: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the workspace VFS baseline snapshot') },
      cli: { absent: 'local file state is checkpointed by the shadow-git store, not a VFS baseline table' },
    },
    turn_feedback: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('operator feedback capture') },
      cli: { absent: 'operator feedback arrives through the web surface only' },
    },
    turn_craft_usage: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('craft-usage telemetry') },
      cli: { absent: LAZY_ON_FIRST_USE('the in-episode craft clock') },
    },

    // ── shared FTS5 stores (agent-utils MemoryStore / CraftStore) ──
    memory_chunks: EVERYWHERE,
    memory_chunks_fts: EVERYWHERE,
    crafted_tools_fts: EVERYWHERE,

    // ── core evolution stores created at engine/session construction ──
    session_window: EVERYWHERE,
    replay_evals: EVERYWHERE,
    mission_budget: EVERYWHERE,

    // ── workspace capability token (cf identity plane) ──
    workspace_capability: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_USER_PLANE('the workspace capability token') },
    },
  },
};

/** What a conformance harness measured on one root. A plane a harness cannot
 *  observe is omitted — the comparator reports it as unmeasured, loudly;
 *  an unmeasured plane is NEVER treated as conformant (layergate rule: silent
 *  perfection for untested surface is worse than no gate). */
export interface ObservedSurface {
  readonly root: ConformanceRoot;
  readonly planes: Partial<Record<ConformancePlane, ReadonlySet<string>>>;
}

/** The registry-closed planes, used by the comparator to distinguish
 *  "undeclared" (open plane: add a manifest entry) from impossible states. */
export const PLANE_UNIVERSE: Partial<Record<ConformancePlane, readonly string[]>> = {
  tool: BUILTIN_TOOLS,
  'agents-action': AGENTS_TOOL_ACTIONS,
  'memory-action': [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS],
};
