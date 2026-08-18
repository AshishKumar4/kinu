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
const EVERYWHERE = { 'cf-orchestrator': WIRED, 'cf-subordinate': WIRED, cli: WIRED } satisfies RootStatuses;

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
const ORCHESTRATOR_IS_SINK = 'the orchestrator IS the report sink; only subordinate actors report upward';
const CLI_HAS_NO_ROSTER = 'local sessions have no subordinate roster; the fork rung is the whole local ladder';
/** A subordinate tree is recursive: a subordinate holds the same roster surface
 *  its parent does, bounded by DELEGATION_MAX_DEPTH rather than by absence. The
 *  bound is a DERIVED budget — at the cap the team deps are not wired and these
 *  actions vanish for that actor — so "wired" here means wired wherever depth
 *  remains, which is the only state the conformance observer can build. */
const TEAM_RECURSES = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': WIRED,
  cli: { absent: CLI_HAS_NO_ROSTER },
} satisfies RootStatuses;

const NIMBUS_BASE = {
  'cf-orchestrator': { absent: 'the hosted workspace lives in its NIMBUS_SESSION Durable Object' },
  'cf-subordinate': { absent: 'the hosted workspace lives in its NIMBUS_SESSION Durable Object' },
  cli: WIRED,
} satisfies RootStatuses;
const LAZY_ON_FIRST_USE = (what: string): string => `created lazily on first use by ${what}, not at boot`;
const RELEASE_TABLE = {
  'cf-orchestrator': { absent: "the release board lives in the owner's UserDO on cf, not on the workspace DO" },
  'cf-subordinate': { absent: SUBORDINATE_SCOPED('the release lane') },
  cli: WIRED,
} satisfies RootStatuses;

// ── The manifest ─────────────────────────────────────────────────────────────

export const BACKEND_CONFORMANCE: ConformanceManifest = {
  tool: {
    execute_tools: EVERYWHERE,
    run: EVERYWHERE,
    file: EVERYWHERE,
    agents: EVERYWHERE,
    memory: EVERYWHERE,
    tasks: EVERYWHERE,
    web: EVERYWHERE,
    report: {
      'cf-orchestrator': { absent: ORCHESTRATOR_IS_SINK },
      'cf-subordinate': WIRED,
      cli: { absent: `${ORCHESTRATOR_IS_SINK}, and ${CLI_HAS_NO_ROSTER}` },
    },
  },

  'agents-action': {
    fork: EVERYWHERE,
    hire: TEAM_RECURSES,
    ask: TEAM_RECURSES,
    send: TEAM_RECURSES,
    reply: {
      'cf-orchestrator': WIRED,
      // The one team-adjacent action a subordinate does NOT get, and the reason
      // is the depth cap: `hire scope=workspace` rides the peer transport and
      // creates the ROOT of a fresh tree, so a subordinate holding peers could
      // escape its own subtree in one call (tools/agents-tool.ts, AgentsToolDeps
      // .peers). Cross-workspace reach is also an ownership boundary its parent
      // owns and it is not party to.
      'cf-subordinate': { absent: 'cross-workspace reach would let a subordinate mint a fresh tree root and escape its own depth cap; the peer boundary is its parent\'s to cross' },
      cli: { absent: NO_USER_PLANE('peer messaging') },
    },
    list: TEAM_RECURSES,
    dismiss: TEAM_RECURSES,
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
    crafted_tools: EVERYWHERE,
    craft_scores: EVERYWHERE,
    _v2_codegen_migration_done: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: 'the one-time crafted-tool duplicate migration runs only on the orchestrator' },
      cli: { absent: 'the one-time crafted-tool duplicate migration runs only on the hosted orchestrator' },
    },
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
    scaffold_trial_queue: EVERYWHERE,

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
    mcts_search_runs: EVERYWHERE,
    // Created by initWorkspaceSchema on every root, not by "the first MCTS run",
    // so a reader that finds no table is a fault rather than an empty result
    // nobody can tell from no takes (workspace-schema.ts:184).
    alternate_takes: EVERYWHERE,

    // ── events hub ──
    agent_log: EVERYWHERE,
    reply_channels: EVERYWHERE,
    triggers: EVERYWHERE,
    peer_outbox: EVERYWHERE,
    run_events: EVERYWHERE,

    // ── durable state ──
    agent_facts: EVERYWHERE,
    agent_config: EVERYWHERE,
    // The agent's own task list. A subordinate keeps its own rather than
    // writing into its parent's: it is given its own assignment, and one plan
    // per actor is what makes the list mean anything.
    agent_tasks: EVERYWHERE,
    background_jobs: EVERYWHERE,
    // Gated commands parked on the owner. The TABLE is part of the shared
    // workspace schema everywhere; what differs is who can decide the rows —
    // the deferral channel is wired into the approval policy on cf, where the
    // needs-you queue that decides them lives. A local session keeps its
    // interactive channel (the human is at the terminal), so nothing parks.
    deferred_approvals: EVERYWHERE,
    plan_reviews: EVERYWHERE,
    compaction_state: EVERYWHERE,
    compaction_archive: EVERYWHERE,
    imported_experience: EVERYWHERE,

    // ── gepa ──
    gepa_runs: EVERYWHERE,
    gepa_candidates: EVERYWHERE,
    gepa_pareto_membership: EVERYWHERE,

    // ── agent-authored views ──
    // One table per workspace, wherever a workspace lives: `initViewTables` is
    // part of `initActorTables`, so every root that can run a turn can publish
    // a dashboard. The subordinate gets it too — its UI surface is the parent's,
    // but its storage is its own and a half-initialized schema is worse than an
    // unused table.
    agent_views: EVERYWHERE,

    // ── release change ──
    // The board's home differs by backend and nothing recorded that until this
    // manifest: on cf it lives in the owner's UserDO (user-do.ts calls
    // initReleaseTables), on the CLI it lives on the session db.
    release_sources: RELEASE_TABLE,
    release_changes: RELEASE_TABLE,
    release_checks: RELEASE_TABLE,
    release_approvals: RELEASE_TABLE,
    release_deployments: RELEASE_TABLE,

    // ── the workspace filesystem ──
    // The local CLI retains the embedded SQLite workspace. Hosted actors use
    // NIMBUS_SESSION directly and never create this second filesystem.
    proteus_workspace_generation: NIMBUS_BASE,
    // The filesystem itself. This is the exact set NimbusWorkspace.destroy()
    // drops — the namespace the library commits to owning inside a host's
    // database — so an addition here is a signal that the dependency changed
    // its storage contract, which is worth failing a gate over.
    inodes: NIMBUS_BASE,
    file_chunks: NIMBUS_BASE,
    content_lifecycle: NIMBUS_BASE,
    vfs_schema_migrations: NIMBUS_BASE,
    vfs_append_receipts: NIMBUS_BASE,
    vfs_append_writer_state: NIMBUS_BASE,
    vfs_append_module_state: NIMBUS_BASE,
    vfs_append_pid_revocations: NIMBUS_BASE,
    vfs_append_acked_gaps: NIMBUS_BASE,
    // ── the roster plane, held by every actor that can hire ──
    workspace_subordinates: {
      'cf-orchestrator': WIRED,
      // Created by SubordinateRosterStore's own ensureSchema on first read, so
      // it exists on a subordinate that has hired and on one that has not.
      'cf-subordinate': WIRED,
      cli: { absent: CLI_HAS_NO_ROSTER },
    },
    subordinate_identity: {
      'cf-orchestrator': { absent: 'lives on each subordinate DO, seeded by setSubordinateIdentity' },
      'cf-subordinate': WIRED,
      cli: { absent: CLI_HAS_NO_ROSTER },
    },
    // The webhook gate — auth, replay window, rate limit — is core's, so a
    // local session provisions the same window table the cloud one does. What
    // the CLI has no equivalent of is the inbound HTTP transport in front of
    // it: a local workspace mints no URL, and a delivery reaches it only
    // through acceptWebhookDelivery.
    webhook_rate_windows: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('webhook ingress') },
      cli: WIRED,
    },
    // The plaintext HMAC/bearer secret a registered webhook was created with.
    // Present on a local session from boot — `local-session.ts` builds the store
    // in its constructor — and only once a webhook is actually registered on cf,
    // where the orchestrator memoizes it (`_webhookSecrets ??=`). The split is
    // real rather than cosmetic: `identity/archive.ts` deliberately excludes this
    // table from a workspace archive because it is a live ingress credential, so
    // a restore does not resurrect one.
    webhook_secrets: {
      'cf-orchestrator': { absent: LAZY_ON_FIRST_USE('registerDurableWebhook') },
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('webhook ingress') },
      cli: WIRED,
    },
    vfs_baseline: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': { absent: SUBORDINATE_SCOPED('the workspace VFS baseline snapshot') },
      cli: WIRED,
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
export const PLANE_UNIVERSE = {
  tool: BUILTIN_TOOLS,
  'agents-action': AGENTS_TOOL_ACTIONS,
  'memory-action': [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS],
} satisfies Partial<Record<ConformancePlane, readonly string[]>>;
