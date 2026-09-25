/**
 * Backend conformance manifest: for each capability, each composition root
 * either wires it or names why not. Per-root conformance tests compare this
 * against the real composition output in both directions. Test-plane only.
 */

import { AGENTS_TOOL_ACTIONS, BUILTIN_TOOLS, MEMORY_FACT_ACTIONS, MEMORY_NOTE_ACTIONS } from '../tools/registry';
import type { AgentsToolAction, BuiltinToolName, MemoryToolAction } from '../tools/registry';
import type { SpendSource } from '../events/model-call';

/**
 * Producers a root builds unconditionally. `fast` is excluded: whether it
 * exists depends on the workspace's model (vendor smaller tier), not the backend.
 */
export const CONFORMANCE_PRODUCERS = ['judge', 'advisor'] as const satisfies readonly SpendSource[];

export type ConformanceProducer = (typeof CONFORMANCE_PRODUCERS)[number];

/** cf splits by actor profile because the profiles differ (`actorToolDeps`). */
export const CONFORMANCE_ROOTS = ['cf-orchestrator', 'cf-subordinate', 'cli'] as const;

export type ConformanceRoot = (typeof CONFORMANCE_ROOTS)[number];

/** Wired, absent for a stated reason, or lazily built after boot. No state for "forgot". */
export type CapabilityStatus =
  | { readonly wired: true }
  | { readonly absent: string }
  | { readonly lazy: string };

export const WIRED: CapabilityStatus = { wired: true };

export type RootStatuses = Readonly<Record<ConformanceRoot, CapabilityStatus>>;

const EVERYWHERE = { 'cf-orchestrator': WIRED, 'cf-subordinate': WIRED, cli: WIRED } satisfies RootStatuses;

export const CONFORMANCE_PLANES = ['tool', 'agents-action', 'memory-action', 'table', 'producer'] as const;

export type ConformancePlane = (typeof CONFORMANCE_PLANES)[number];

export interface ConformanceManifest {
  /** Keyed by the registry union, so a new tool cannot compile without a per-root decision. */
  readonly tool: Readonly<Record<BuiltinToolName, RootStatuses>>;
  readonly 'agents-action': Readonly<Record<AgentsToolAction, RootStatuses>>;
  readonly 'memory-action': Readonly<Record<MemoryToolAction, RootStatuses>>;
  /** Open-keyed; observed-but-undeclared tables force new entries. */
  readonly table: Readonly<Record<string, RootStatuses>>;
  /** Model producers whose client the root actually built. */
  readonly producer: Readonly<Record<ConformanceProducer, RootStatuses>>;
}

const NO_USER_PLANE = (what: string): string =>
  `${what} rides the owner's UserDO; a signed-out local runtime has no account plane to serve it`;

const ORCHESTRATOR_IS_SINK = 'the orchestrator IS the report sink; only subordinate actors report upward';

/** Subordinates hold the parent's roster surface, bounded by DELEGATION_MAX_DEPTH;
 *  "wired" means wired wherever depth remains. */
const TEAM_RECURSES = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': WIRED,
  cli: WIRED,
} satisfies RootStatuses;

/** Nimbus tables: `createWorkspace` opens Nimbus over the host database every actor shares. */
const NIMBUS_BASE = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': WIRED,
  cli: WIRED,
} satisfies RootStatuses;

const LAZY_ON_FIRST_USE = (what: string): CapabilityStatus => ({ lazy: `created on first use by ${what}, not at boot` });

const NO_LOCAL_INGRESS = 'a local workspace has no inbound HTTP transport, and `kinu triggers <name> webhook` refuses a local target';

const RELEASE_TABLE = {
  'cf-orchestrator': { absent: "the release board lives in the owner's UserDO on cf, not on the workspace DO" },
  'cf-subordinate': { absent: "the release board lives in the owner's UserDO on cf, not on the workspace DO" },
  cli: WIRED,
} satisfies RootStatuses;

export const BACKEND_CONFORMANCE: ConformanceManifest = {
  tool: {
    eval: EVERYWHERE,
    shell: EVERYWHERE,
    file: EVERYWHERE,
    agents: EVERYWHERE,
    memory: EVERYWHERE,
    tasks: EVERYWHERE,
    web: EVERYWHERE,
    report: {
      'cf-orchestrator': { absent: ORCHESTRATOR_IS_SINK },
      'cf-subordinate': WIRED,
      cli: { absent: ORCHESTRATOR_IS_SINK },
    },
  },

  'agents-action': {
    // A swarm needs only a model and a workspace, so it has no deps group to under-wire.
    swarm: EVERYWHERE,
    hire: TEAM_RECURSES,
    // A subordinate has no peer transport: `hire scope=workspace` would let it escape its
    // subtree (delegation/agents-tool.ts). Locally every root agent gets PeerHub.
    msg: TEAM_RECURSES,
    list: TEAM_RECURSES,
    dismiss: TEAM_RECURSES,
  },

  'memory-action': {
    save: EVERYWHERE,
    search: EVERYWHERE,
    conversations: EVERYWHERE,
    remember: EVERYWHERE,
    recall: EVERYWHERE,
    forget: EVERYWHERE,
  },

  table: {
    workspace_identity: EVERYWHERE,
    // The workspace's actor directory; subordinates read the root's roster.
    workspace_actors: EVERYWHERE,
    crafted_tools: EVERYWHERE,
    search_nodes: EVERYWHERE,
    fibers: EVERYWHERE,
    evolution_events: EVERYWHERE,
    executor_output: EVERYWHERE,
    activity_log: EVERYWHERE,
    fork_lineage: EVERYWHERE,
    // The receiver hydrates from these on its first frame (identity/fork.ts).
    fork_transfer: EVERYWHERE,
    fork_staged_files: EVERYWHERE,
    scaffold_versions: EVERYWHERE,
    scaffold_regression_fixtures: EVERYWHERE,
    task_history: EVERYWHERE,
    scaffold_evaluations: EVERYWHERE,
    scaffold_trial_queue: EVERYWHERE,

    turn_outcomes: EVERYWHERE,
    lessons: EVERYWHERE,
    outcome_labels: EVERYWHERE,
    outcome_ensemble_labels: EVERYWHERE,
    proposed_tasks: EVERYWHERE,

    // Actor-private: resume keys on task text, so rows carry `actor_id` in the primary key.
    head_runs: EVERYWHERE,
    head_journal: EVERYWHERE,
    head_evidence: EVERYWHERE,
    head_steps: EVERYWHERE,
    head_merge_results: EVERYWHERE,
    mcts_search_runs: EVERYWHERE,
    // Created by initWorkspaceSchema on every root, so a missing table is a fault.
    alternate_takes: EVERYWHERE,
    exploration_records: EVERYWHERE,
    exploration_seals: EVERYWHERE,
    swarm_node_records: EVERYWHERE,
    // `traces` and `facet_model_operation_outbox` are gone with the facet class;
    // no DDL creates them, so they are not plane members.

    // `outbox_peer` is created lazily; declared with the outbound intent logs below.
    agent_log: EVERYWHERE,
    reply_channels: EVERYWHERE,
    triggers: EVERYWHERE,
    run_events: EVERYWHERE,

    // Actor-private: the world model is the agent's own key space.
    agent_facts: EVERYWHERE,
    actor_config: EVERYWHERE,
    // Per-actor list; uniqueness is (actor_id, seq).
    agent_tasks: EVERYWHERE,
    // Separate because agent_tasks is genesis-locked; reads LEFT JOIN it.
    agent_task_notes: EVERYWHERE,
    plan_task_links: EVERYWHERE,
    // Rows are actor-private; the `*InWorkspace` aggregates are machine-wide because
    // every detached job is a live process tree (jobs/runner.ts).
    background_jobs: EVERYWHERE,
    // Once-only claims (tools/effect-claim.ts), created by `initWorkspaceSchema`; the
    // wrapper in `buildActorTools` needs it on every root.
    tool_effect_claims: EVERYWHERE,
    // Written after a keyed effect ran, never swept (identity/effect-tombstones.ts).
    effect_tombstones: EVERYWHERE,
    // Holds the generated pattern so a replay applies what was decided.
    pattern_extractions: EVERYWHERE,
    // A DO is its own single writer; locally separate OS processes share one SQLite file.
    driver_lease: {
      'cf-orchestrator': {
        absent: 'a Durable Object is the platform\'s own single writer: one activation owns the '
          + 'storage, so no second process can drive the same workspace and there is nothing to '
          + 'arbitrate',
      },
      'cf-subordinate': {
        absent: 'a Durable Object is the platform\'s own single writer: one activation owns the '
          + 'storage, so no second process can drive the same workspace and there is nothing to '
          + 'arbitrate',
      },
      cli: WIRED,
    },
    // The Agents SDK's schedule registry, created by its constructor. The orchestrator
    // sweeps unrunnable rows from it at activation (`orchestrator.ts`).
    cf_agents_schedules: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: {
        absent: 'the Agents SDK\'s Durable Object base is what creates this registry, and a local '
          + 'session has no Durable Object: it is an OS process over its own SQLite file with no DO '
          + 'alarm to register against. Its durable timers are `triggers` rows driven by the local '
          + 'AlarmScheduler (core/src/events/hub/triggers.ts), so there is no vendor schedule '
          + 'registry to wire and nothing to sweep',
      },
    },
    // Created by the first `runFiber` in the shared workspace database.
    cf_agents_runs: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('runFiber'),
      'cf-subordinate': LAZY_ON_FIRST_USE('runFiber'),
      cli: { absent: 'the local scheduler records durable work in the core `fibers` table' },
    },
    cf_agents_fibers: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('runFiber'),
      'cf-subordinate': LAZY_ON_FIRST_USE('runFiber'),
      cli: { absent: 'the local scheduler records durable work in the core `fibers` table' },
    },
    // Agents SDK `ResumableStream` store, created by the chat transport.
    cf_ai_chat_stream_chunks: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('the chat transport'),
      'cf-subordinate': LAZY_ON_FIRST_USE('the chat transport'),
      cli: { absent: 'a local session streams to an in-process client; a redial has nothing to replay from' },
    },
    cf_ai_chat_stream_metadata: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('the chat transport'),
      'cf-subordinate': LAZY_ON_FIRST_USE('the chat transport'),
      cli: { absent: 'a local session streams to an in-process client; a redial has nothing to replay from' },
    },
    // `cf_agents_sub_agents` is absent on purpose: no actor calls `subAgent()`
    // (`state/actor-host.ts`), so it is not a plane member.
    // Only cf wires the deferral channel; the table is shared schema.
    deferred_approvals: EVERYWHERE,
    device_consent_requests: EVERYWHERE,
    slates: EVERYWHERE,
    slate_versions: EVERYWHERE,
    slate_publications: EVERYWHERE,
    slate_deployments: EVERYWHERE,
    slate_resources: EVERYWHERE,
    slate_previews: EVERYWHERE,
    slate_deployment_reservations: EVERYWHERE,
    slate_resource_reservations: EVERYWHERE,
    slate_invocations: EVERYWHERE,
    slate_receipts: EVERYWHERE,
    // The authored slate's `this.storage` KV.
    slate_state: EVERYWHERE,
    slate_file_manifest: EVERYWHERE,
    slate_shares: EVERYWHERE,
    slate_share_users: EVERYWHERE,
    slate_live_shares: EVERYWHERE,
    slate_live_share_users: EVERYWHERE,
    slate_viewer_requests: EVERYWHERE,
    // KINU-N028; the prompt builder reads it every turn.
    instruction_approvals: EVERYWHERE,
    plan_reviews: EVERYWHERE,
    compaction_state: EVERYWHERE,
    compaction_archive: EVERYWHERE,
    imported_experience: EVERYWHERE,

    gepa_runs: EVERYWHERE,
    gepa_candidates: EVERYWHERE,

    prompt_section_versions: EVERYWHERE,
    prompt_section_evaluations: EVERYWHERE,

    // The Evolution Changelog reads it on every root.
    refinement_requests: EVERYWHERE,

    // The `state.*` sandbox namespace.
    actor_program_state: EVERYWHERE,

    // The `db` catalogue only; `app_<name>` tables stay undeclared so the
    // undeclared-table signal still covers them.
    agent_data_tables: EVERYWHERE,

    // On cf these live in the owner's UserDO (user-do.ts initReleaseTables).
    release_sources: RELEASE_TABLE,
    release_changes: RELEASE_TABLE,
    release_checks: RELEASE_TABLE,
    release_approvals: RELEASE_TABLE,
    release_deployments: RELEASE_TABLE,

    kinu_workspace_generation: NIMBUS_BASE,
    // The set NimbusWorkspace.destroy() drops; additions signal a storage contract change.
    inodes: NIMBUS_BASE,
    file_chunks: NIMBUS_BASE,
    content_lifecycle: NIMBUS_BASE,
    vfs_schema_migrations: NIMBUS_BASE,
    // @nimbus-sh/core 0.11.0 tables.
    vfs_append_receipts_v2: NIMBUS_BASE,
    vfs_append_writer_state_v2: NIMBUS_BASE,
    vfs_append_module_state_v2: NIMBUS_BASE,
    vfs_append_pid_revocations_v2: NIMBUS_BASE,
    vfs_append_acked_gaps_v2: NIMBUS_BASE,
    nimbus_filesystem_identity: NIMBUS_BASE,
    nimbus_filesystem_devices: NIMBUS_BASE,
    vfs_ino_allocator: NIMBUS_BASE,
    actor_subordinates: {
      'cf-orchestrator': WIRED,
      // SubordinateRosterStore creates it on first read.
      'cf-subordinate': WIRED,
      cli: WIRED,
    },
    // On cf these fields are columns on the child's `workspace_actors` row.
    subordinate_identity: {
      'cf-orchestrator': { absent: "a hosted actor's identity is its `workspace_actors` row, which the directory owns" },
      'cf-subordinate': { absent: "a hosted actor's identity is its `workspace_actors` row, which the directory owns" },
      cli: LAZY_ON_FIRST_USE("the first local hire's SubordinateIdentityStore"),
    },
    // `facetHomeProvisioner` creates it on first provision in the owning workspace's database.
    kinu_agent_identity: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('facetHomeProvisioner'),
      'cf-subordinate': WIRED,
      cli: LAZY_ON_FIRST_USE('facetHomeProvisioner'),
    },
    // Webhook gate tables, provisioned at boot on cf.
    webhook_rate_windows: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_LOCAL_INGRESS },
    },
    // Replay guard for signed deliveries.
    webhook_replay_claims: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_LOCAL_INGRESS },
    },
    // Live ingress credential; `identity/archive.ts` excludes it from archives.
    webhook_secrets: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('registerDurableWebhook'),
      'cf-subordinate': LAZY_ON_FIRST_USE('registerDurableWebhook'),
      cli: { absent: NO_LOCAL_INGRESS },
    },
    vfs_baseline_manifest: EVERYWHERE,
    vfs_baseline_blob: EVERYWHERE,
    vfs_baseline_generation: EVERYWHERE,
    change_notes: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'a local workspace has no Changes tab, so nothing writes notes on a change-set' },
    },
    // Container lifecycle announcement dedupe, keyed to the workspace's container.
    sandbox_lifecycle_incidents: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'the local executor is the host machine, which has no snapshot, restore or discard stage to fail at' },
    },
    turn_feedback: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'operator feedback arrives through the web surface only' },
    },
    // Keeps the sleep-time answer so a replay applies the same update.
    sleep_time_updates: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: "a local turn's sleep-time compute cannot be interrupted between its call and its write" },
    },
    turn_craft_usage: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: LAZY_ON_FIRST_USE('the in-episode craft clock'),
    },
    cache_warm: EVERYWHERE,

    memory_chunks: EVERYWHERE,
    memory_chunks_fts: EVERYWHERE,
    crafted_tools_fts: EVERYWHERE,

    // Created by their consumers' constructors (evolution/engine.ts, mission-budget.ts).
    completed_turns: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('the EvolutionEngine'),
      'cf-subordinate': LAZY_ON_FIRST_USE('the EvolutionEngine'),
      cli: LAZY_ON_FIRST_USE('the EvolutionEngine'),
    },
    replay_evals: EVERYWHERE,
    mission_budget: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('MissionBudgetLedger'),
      'cf-subordinate': LAZY_ON_FIRST_USE('MissionBudgetLedger'),
      cli: LAZY_ON_FIRST_USE('MissionBudgetLedger'),
    },

    workspace_capability: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_USER_PLANE('the workspace capability token') },
    },

    // On cf created in the ActorAgent constructor, since `onStart` may not precede an RPC.
    // On the CLI `turn_id` is nullable: an idle-queued send is held by the queue.
    pending_steers: EVERYWHERE,
    // File parts of a pending send, one row per part.
    pending_steer_files: EVERYWHERE,
    pending_steer_metadata: EVERYWHERE,
    // Created by `initWorkspaceSchema` (CLI) and the `ActorAgent` constructor (cf),
    // ahead of the `onStart` recovery sweep.
    actor_turn_claims: EVERYWHERE,
    // Numbered per actor, not per turn; written at hydration, so every actor has it.
    session_messages: EVERYWHERE,
    stream_parts: EVERYWHERE,
    actor_contexts: EVERYWHERE,
    actor_context_selection: EVERYWHERE,
    context_revisions: EVERYWHERE,
    context_memberships: EVERYWHERE,
    context_proposals: EVERYWHERE,
    context_proposal_entries: EVERYWHERE,
    context_proposal_sources: EVERYWHERE,
    actor_requests: EVERYWHERE,
    request_renders: EVERYWHERE,
    conversation_entries: EVERYWHERE,
    conversation_heads: EVERYWHERE,
    conversation_entry_parts: EVERYWHERE,
    // Created per root before any read: `actor-agent.ts` on cf, `local-session.ts` on the CLI.
    terminal_effects: EVERYWHERE,

    // Workspace-wide logs; a hire's intent goes to the same log.
    outbox_email: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_USER_PLANE('outbound email') },
    },
    outbox_peer: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_USER_PLANE('cross-workspace peer delivery') },
    },
  },

  producer: {
    // On the CLI without a second model, core's same-model fallback runs.
    judge: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: WIRED,
    },
    // Whether it runs is a per-turn owner switch, not wiring.
    advisor: EVERYWHERE,
  },
};

/** An omitted plane is reported unmeasured, never treated as conformant. */
export interface ObservedSurface {
  readonly root: ConformanceRoot;
  readonly planes: Partial<Record<ConformancePlane, ReadonlySet<string>>>;
}

/** Registry-closed planes, to tell "undeclared" from impossible states. */
export const PLANE_UNIVERSE = {
  tool: BUILTIN_TOOLS,
  'agents-action': AGENTS_TOOL_ACTIONS,
  'memory-action': [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS],
  producer: CONFORMANCE_PRODUCERS,
} satisfies Partial<Record<ConformancePlane, readonly string[]>>;
