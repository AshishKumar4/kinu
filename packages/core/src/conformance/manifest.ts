/**
 * Backend conformance manifest — the declared capability surface of every
 * composition root.
 *
 * The disease this kills: "X never worked on Y backend". Every builtin tool,
 * agents action, memory action and SQL table is dep-gated at a composition
 * root (`buildActorTools`, `ensureSchema`, …), so a capability someone
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

import { AGENTS_TOOL_ACTIONS, BUILTIN_TOOLS, MEMORY_FACT_ACTIONS, MEMORY_NOTE_ACTIONS } from '../tools/registry';
import type { AgentsToolAction, BuiltinToolName, MemoryToolAction } from '../tools/registry';
import type { SpendSource } from '../events/model-call';

/**
 * Producers whose client a composition root builds UNCONDITIONALLY, so its
 * presence is a wiring fact a root can be held to.
 *
 * `fast` is deliberately not here, and the reason is MEASURED rather than
 * assumed: `createFastLLM` and its CLI twin answer undefined when the chat
 * vendor declares no smaller tier, so whether `rt.fastLlm` exists is a property
 * of the workspace's MODEL and not of the backend. Observed 2026-08-20 against
 * this repository's own harnesses: absent on cf-orchestrator, cf-subordinate and
 * cli alike, because their fixtures pin no model and the default vendor declares
 * no smaller tier. Declaring it here would put a config outcome in a wiring
 * manifest, and the first workspace on a vendor with a small tier would
 * contradict it.
 */
export const CONFORMANCE_PRODUCERS = ['judge', 'advisor'] as const satisfies readonly SpendSource[];
export type ConformanceProducer = (typeof CONFORMANCE_PRODUCERS)[number];

/** The composition roots that assemble a model-facing surface. cf splits by
 *  actor profile because the profiles deliberately differ (`actorToolDeps`);
 *  the CLI has one session class. */
export const CONFORMANCE_ROOTS = ['cf-orchestrator', 'cf-subordinate', 'cli'] as const;
export type ConformanceRoot = (typeof CONFORMANCE_ROOTS)[number];

/** Wired, deliberately absent for a stated reason, or built on first use by a
 *  named creator: held by the root, only not at boot, which is when the
 *  observer looks. There is no fourth state — "we forgot" is exactly what
 *  must not be representable. */
export type CapabilityStatus =
  | { readonly wired: true }
  | { readonly absent: string }
  | { readonly lazy: string };

export const WIRED: CapabilityStatus = { wired: true };

export type RootStatuses = Readonly<Record<ConformanceRoot, CapabilityStatus>>;

/** Shorthand: wired on every root. */
const EVERYWHERE = { 'cf-orchestrator': WIRED, 'cf-subordinate': WIRED, cli: WIRED } satisfies RootStatuses;

export const CONFORMANCE_PLANES = ['tool', 'agents-action', 'memory-action', 'table', 'producer'] as const;
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
  /** Model producers whose client the root actually BUILT
   *  ({@link CONFORMANCE_PRODUCERS}). Not model-facing like the three planes
   *  above, and here for exactly the disease this file names: a reviewer that
   *  was never wired on one backend is indistinguishable from one left out on
   *  purpose, and "the advisor does nothing on the CLI" is the sentence this
   *  plane makes impossible to arrive at by accident. */
  readonly producer: Readonly<Record<ConformanceProducer, RootStatuses>>;
}

// ── Recurring reasons ────────────────────────────────────────────────────────

const NO_USER_PLANE = (what: string): string =>
  `${what} rides the owner's UserDO; a signed-out local runtime has no account plane to serve it`;
const ORCHESTRATOR_IS_SINK = 'the orchestrator IS the report sink; only subordinate actors report upward';
/** A subordinate tree is recursive: a subordinate holds the same roster surface
 *  its parent does, bounded by DELEGATION_MAX_DEPTH rather than by absence. The
 *  bound is a DERIVED budget — at the cap the team deps are not wired and these
 *  actions vanish for that actor — so "wired" here means wired wherever depth
 *  remains, which is the only state the conformance observer can build. */
const TEAM_RECURSES = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': WIRED,
  cli: WIRED,
} satisfies RootStatuses;

/**
 * The workspace filesystem's own tables.
 *
 * WIRED wherever a workspace lives: `createWorkspace` opens Nimbus over the
 * host database — the orchestrator's own `ctx.storage.sql` on cf, the session's
 * SQLite file locally — so these sit beside the conversation and the memory
 * index that reads them. Every hosted actor of that workspace is scoped over
 * that same database and works in that same tree, which is the point of hiring
 * one, so a subordinate observes exactly these tables too.
 */
const NIMBUS_BASE = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': WIRED,
  cli: WIRED,
} satisfies RootStatuses;
const LAZY_ON_FIRST_USE = (what: string): CapabilityStatus => ({ lazy: `created on first use by ${what}, not at boot` });
const NO_LOCAL_INGRESS = 'a local workspace has no inbound HTTP transport, and `kinu triggers <name> webhook` refuses a local target';
/** The release board's home is the OWNER's UserDO on cf, so no workspace
 *  database there holds it — neither the root's rows nor a hire's. */
const RELEASE_TABLE = {
  'cf-orchestrator': { absent: "the release board lives in the owner's UserDO on cf, not on the workspace DO" },
  'cf-subordinate': { absent: "the release board lives in the owner's UserDO on cf, not on the workspace DO" },
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
      cli: { absent: ORCHESTRATOR_IS_SINK },
    },
  },

  'agents-action': {
    // Wherever the exploration substrate is, and by construction rather than by
    // wiring: a search needs a model to expand with and a workspace to measure in,
    // which is exactly what that substrate carries, so it has no deps group of its
    // own to under-wire.
    swarm: EVERYWHERE,
    hire: TEAM_RECURSES,
    // Wired wherever a roster or a peer transport is, and its `event_id` half
    // only beside the latter: a subordinate has no peer transport, so it
    // addresses agents by name and never answers a cross-workspace event. That
    // is the depth cap rather than tidiness — `hire scope=workspace` rides the
    // peer transport and creates the ROOT of a fresh tree, so a subordinate
    // holding peers could escape its own subtree in one call
    // (tools/agents-tool.ts, AgentsToolDeps.peers) — and cross-workspace reach
    // is also an ownership boundary its parent owns and it is not party to.
    // Locally the whole action is wired: a local virtual workspace groups
    // several ROOT agents as equal peers over one directory, and LocalAgentHost
    // gives each of them the same PeerHub transport the hosted backend runs.
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
    // ── the shared actor substrate (core initAllTables) ──
    workspace_identity: EVERYWHERE,
    // The workspace's actor DIRECTORY — one row per actor the workspace issued,
    // and the authority `openWorkspaceMainActor` reads to bind a handle. It is
    // the ONE workspace database's own table, so every root observes it: a
    // subordinate is not a workspace root, but it has no database of its own to
    // hold an identity in, and the roster it reads is the root's.
    workspace_actors: EVERYWHERE,
    messages: EVERYWHERE,
    crafted_tools: EVERYWHERE,
    search_nodes: EVERYWHERE,
    fibers: EVERYWHERE,
    evolution_events: EVERYWHERE,
    executor_output: EVERYWHERE,
    activity_log: EVERYWHERE,
    fork_lineage: EVERYWHERE,
    // The unpublished transfer a fork target is receiving, and the files it has
    // already published into the plane. On every root because `initAllTables`
    // creates them and the receiver hydrates from them on its FIRST frame — a
    // target whose table were missing would refuse the fork rather than resume
    // it (identity/fork.ts, ForkStagingState).
    fork_transfer: EVERYWHERE,
    fork_staged_files: EVERYWHERE,
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
    // ACTOR-PRIVATE, all six. A run belongs to the actor that split it: its live
    // roster is carried into that actor's model steps, its reconciliation
    // settles the heads it spawned, and the reclaim in `findResumableRun` /
    // `findResumable` / `findRunningSwarms` keys on TASK TEXT — so two actors
    // handed the same instruction present the same key, and without an owner
    // predicate one would take over the other's tree. Every one of these
    // carries `actor_id` and has it in its primary key, because none of their
    // ids is minted globally either: a fork re-drive DERIVES a head id from its
    // branch point and slot, a step id is `${headId}-s${seq}`, and evidence ids
    // come from the report.
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
    // The exploration leaderboard, on every root for the same reason: the record
    // read models are wired on the orchestrator and a local session forks down
    // into the same workspace, so a table only the first swarm run creates would
    // make an unsearched workspace's leaderboard a `no such table` throw.
    exploration_records: EVERYWHERE,
    // The per-node content a swarm re-entry reads back after an eviction, on every root
    // for the same reason: `initWorkspaceSchema` creates it, and a swarm forked down
    // into a local session re-enters the same rows.
    swarm_node_records: EVERYWHERE,
    // `traces` AND `facet_model_operation_outbox` ARE DELIBERATELY ABSENT FROM
    // THIS REGISTRY, and their removal is the entry. Both belonged to the
    // hosted facet class: `traces` held a branch rollout's step text across the
    // two RPCs that could hibernate between them, and the outbox buffered the
    // operation frames a facet forwarded to its root. A rollout branch is a
    // logical actor in the workspace's own database now — its trace is the
    // handle it produced and `search_nodes.observation` beside it
    // (`cf-backend/src/exploration-hosting.ts`), and there is no isolate
    // boundary left to buffer operation frames across — so no DDL in this tree
    // creates either table on any root. Declaring them `absent` with a reason
    // would say the product could have them and chose not to; declaring them
    // `wired` said they existed. Neither is true, so they are not plane
    // members, and the comparator reports an observed-but-undeclared table
    // loudly if that is ever wrong.

    // ── events hub ──
    // `outbox_peer` is not in this group: the shared outbox creates its table
    // lazily on first use, so its per-root wiring decision is recorded with
    // the outbound intent logs below.
    agent_log: EVERYWHERE,
    reply_channels: EVERYWHERE,
    triggers: EVERYWHERE,
    run_events: EVERYWHERE,

    // ── durable state ──
    // ACTOR-PRIVATE: the world model is the agent's own key space. `remember`,
    // `recall` and `forget` are this actor's tool, the top-K goes into THIS
    // actor's prompt, and sleep-time compression rewrites its own model — so a
    // sibling that learns "deploy target" must not overwrite what this one
    // observed under the same words. Adoption still lands here and is still a
    // copy INTO a target: an experience import upserts the imported fact into
    // the importing actor's own set under `source: experience:<workspace>`.
    agent_facts: EVERYWHERE,
    actor_config: EVERYWHERE,
    // The agent's own task list. A subordinate keeps its own rather than
    // writing into its parent's: it is given its own assignment, and one plan
    // per actor is what makes the list mean anything. `t{seq}` is minted from
    // the owner's own sequence, so two actors both hold a `t1` and the
    // uniqueness that makes the id referable is UNIQUE (actor_id, seq).
    agent_tasks: EVERYWHERE,
    // The plan revision a task was added under, owned alongside the task.
    plan_task_links: EVERYWHERE,
    // SPLIT OWNERSHIP, and the store interface is where the split is stated.
    // The ROW is actor-private — its roster feeds one actor's context block, an
    // id alone is not authority to settle a sibling's work, and `clearSettled`
    // is one actor's history. The AGGREGATES are not: `countRunningInWorkspace`,
    // `resumeOwedIdsInWorkspace`, `nextResumeAtInWorkspace` and
    // `hasLiveJobsInWorkspace` answer questions about the machine, because
    // every detached job is a live process tree whichever agent launched it
    // (jobs/runner.ts). Narrowing the cap would multiply the machine ceiling by
    // the actor count; widening the roster would put a sibling's work in this
    // actor's prompt.
    background_jobs: EVERYWHERE,
    // The once-only boundary in front of a tool whose effects leave the process:
    // one row per claimed call, `PRIMARY KEY (turn_id, normalized_call_id,
    // call_digest)` with a nullable `result_json`, written before the effect and
    // settled after it (tools/effect-claim.ts). Owned by core on every root and
    // by neither backend: `initToolEffectClaimTable` runs inside
    // `initWorkspaceSchema`, and the wrapper that writes the rows is applied
    // inside `buildActorTools`, which is the ONE surface both backends build
    // their actor from. So there is no root where a claimed tool runs without
    // this table — a root that had the wrapper and not the table would fail its
    // first claimed call, and one with the table and not the wrapper would
    // replay an effect it recorded nothing about.
    tool_effect_claims: EVERYWHERE,
    // The other half of once-only: `PRIMARY KEY (scope, key)` and nothing else,
    // written AFTER a keyed effect ran and never swept
    // (identity/effect-tombstones.ts). EVERYWHERE for the same reason as the
    // claims above — the completed-turn window, the review lane, the shadow
    // trial queue and branch settlement all read it on every root, and each of
    // them retires its own rows, so a root without this table would repeat the
    // work of any replayed effect whose row had already gone.
    effect_tombstones: EVERYWHERE,
    // The generated pattern, held between the model call that produced it and
    // the crafted tool it becomes — so a replay applies what was DECIDED rather
    // than asking a model that may answer differently. Wherever a turn review
    // runs, which is every root.
    pattern_extractions: EVERYWHERE,
    // The single-driver lease over ONE local conversation. Local-only, and the
    // asymmetry is the platform's rather than an omission: a Durable Object IS
    // the single writer, so on either cf root one activation owns the storage
    // and there is nothing to arbitrate. Locally a workspace is one SQLite FILE
    // and the participants are separate OS processes — a detached daemon and
    // every `kinu chat`/`kinu exec` — so two of them can bind the same pending
    // event and convert it twice. The in-process claim the orchestrator makes
    // holds w.r.t. one event loop, which is exactly the boundary the CLI
    // crosses and cf does not.
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
    // The Agents SDK's OWN schedule registry, and the only vendor table in this
    // census. Not ours to create: `Agent._ensureSchema` runs it from the SDK's
    // constructor on every wake, so both cf roots have it from activation
    // whether or not that actor ever schedules anything. Declared because the
    // orchestrator READS it directly at activation — the unrunnable-row sweep in
    // `orchestrator.ts` deletes overdue `type IN ('delayed','scheduled')` rows
    // that no alarm will ever carry — and a table a root's own SQL depends on
    // belongs in the census whoever wrote the DDL. A subordinate holds the same
    // table and never sweeps it: its wakes come from its parent, not from an
    // alarm of its own.
    //
    // The CLI has no vendor base at all, which is why this is the honest place
    // for the asymmetry rather than a lazy-creation caveat.
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
    // The Agents SDK's durable execution rows, created by the first `runFiber`
    // in the object's own database — the one database every actor of that
    // workspace shares, so both cf roots see them from the same creator.
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
    // The Agents SDK's session store — the tables Think's activation creates
    // (`Session.create(this)` then a session read in Think's `onStart`, which
    // runs `AgentSessionProvider.ensureTable`) on every wake of either cf root,
    // in the one database every actor of the workspace shares. Declared because
    // Kinu READS them directly: `assistant_messages` is the pane store
    // `identity/conversation-store.ts` selects on a hosted workspace, and the
    // fork, archive, search, eval-split and inherited-context readers all name
    // it in raw SQL. `@cloudflare/think`'s unreleased `brisk-chats-branch`
    // changeset lifts these into `cf_agents_session_*` on first wake and DROPS
    // them, which is exactly the disappearance this census must report.
    // `assistant_compactions` and `assistant_config` are read by nothing in
    // Kinu and are here so the one `ensureTable` that creates all four is
    // observed whole. `assistant_fts` is the provider's FTS5 index
    // (`normalizeObservedTables` folds its shadow tables); Kinu's own index is
    // `conversation_fts`.
    assistant_messages: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'a local session has no Think base; its default chat is the core `messages` table, the store `hasPaneStore` falls to' },
    },
    assistant_compactions: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'a local session has no Think base and no SDK compaction overlay; compaction is the core transformContext extension' },
    },
    assistant_config: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'a local session has no Think base; session settings are `actor_config` rows' },
    },
    assistant_fts: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'a local session has no Think base; the conversation index is the core `conversation_fts` table' },
    },
    // `cf_agents_sub_agents` IS DELIBERATELY ABSENT FROM THIS REGISTRY, and its
    // absence is the entry. It is the Agents SDK's facet registry, created by
    // the first `subAgent()` call. No Kinu actor spawns a facet: a hired
    // subordinate, a temporary, a head, a swarm node and an MCTS branch are all
    // logical actors bound over the ONE workspace object's SQLite
    // (`state/actor-host.ts`), so nothing calls `subAgent()` and the table is
    // never created on any root. Declaring it `absent` with a reason would say
    // the product could have it and chose not to; declaring it `wired` would
    // say it exists. Neither is true, so it is not a plane member — the
    // registry enumerates what a workspace HAS, and the comparator reports an
    // observed-but-undeclared table loudly if this is ever wrong.
    // Gated commands parked on the owner. The TABLE is part of the shared
    // workspace schema everywhere; what differs is who can decide the rows —
    // the deferral channel is wired into the approval policy on cf, where the
    // needs-you queue that decides them lives. A local session keeps its
    // interactive channel (the human is at the terminal), so nothing parks.
    deferred_approvals: EVERYWHERE,
    slates: EVERYWHERE,
    slate_versions: EVERYWHERE,
    slate_publications: EVERYWHERE,
    slate_deployments: EVERYWHERE,
    slate_resources: EVERYWHERE,
    slate_previews: EVERYWHERE,
    slate_deployment_reservations: EVERYWHERE,
    slate_resource_reservations: EVERYWHERE,
    slate_content: EVERYWHERE,
    slate_content_chunks: EVERYWHERE,
    slate_invocations: EVERYWHERE,
    slate_receipts: EVERYWHERE,
    // Which workspace instruction bytes the owner approved for system placement
    // (KINU-N028). EVERYWHERE for the same reason prompt_section_versions is:
    // the prompt builder classifies AGENTS.md and skills on every turn on every
    // root, and a missing table there would fail the read that decides trust.
    instruction_approvals: EVERYWHERE,
    plan_reviews: EVERYWHERE,
    compaction_state: EVERYWHERE,
    compaction_archive: EVERYWHERE,
    imported_experience: EVERYWHERE,

    // ── gepa ──
    gepa_runs: EVERYWHERE,
    gepa_candidates: EVERYWHERE,

    // ── evolved prompt sections ──
    // The promoted rows are read by the prompt builder on every turn, on every
    // root, so the table is EVERYWHERE for the same reason `alternate_takes`
    // is: a reader that finds no table is a fault, not an empty result.
    prompt_section_versions: EVERYWHERE,
    prompt_section_evaluations: EVERYWHERE,

    // ── continual refinement ──
    // One request row per refinement, EVERYWHERE for the same reason
    // prompt_section_versions is: the Evolution Changelog reads it on every
    // digest view on every root, and a reader that finds no table is a fault
    // rather than an empty listing. Every actor accrues evolution debt, so a
    // root that could not open a request would accumulate corrections nothing
    // reviews.
    refinement_requests: EVERYWHERE,

    // ── execute_tools state ──
    // The `state.*` sandbox namespace: what one program saved for the next.
    // In `initActorTables`, because every root that can run a program can keep
    // something between two of them.
    actor_program_state: EVERYWHERE,

    // ── agent data (the `db` capability) ──
    // The CATALOGUE, not the tables it catalogues: a table an agent declares
    // exists only once one declares it, while the catalogue every `db` read
    // resolves against is created with the workspace schema — so
    // `db.listTables()` on a workspace that has never declared anything is an
    // empty list rather than a missing table. Physical agent tables are named
    // `app_<name>` and are DELIBERATELY not declared here, individually or as a
    // family: an undeclared-but-observed table is the signal this manifest
    // exists to raise, and a prefix wildcard would switch that signal off for
    // exactly the family whose contents nothing else vouches for.
    agent_data_tables: EVERYWHERE,

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
    // ONE workspace per host database, on every backend: the local CLI's
    // bun:sqlite file and the orchestrator's own `ctx.storage.sql`.
    kinu_workspace_generation: NIMBUS_BASE,
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
    actor_subordinates: {
      'cf-orchestrator': WIRED,
      // Created by SubordinateRosterStore's own ensureSchema on first read, so
      // it exists on a subordinate that has hired and on one that has not.
      'cf-subordinate': WIRED,
      cli: WIRED,
    },
    // A subordinate's own name, mission, depth and lifetime — the CLI's
    // durable identity row for a hired child. On cf those four are columns on
    // the child's `workspace_actors` row, written by the directory under its
    // parent's authority, so nothing on either cf root creates this table.
    subordinate_identity: {
      'cf-orchestrator': { absent: "a hosted actor's identity is its `workspace_actors` row, which the directory owns" },
      'cf-subordinate': { absent: "a hosted actor's identity is its `workspace_actors` row, which the directory owns" },
      cli: LAZY_ON_FIRST_USE("the first local hire's SubordinateIdentityStore"),
    },
    // One uid/gid row per actor home, in the database of the workspace that
    // owns the file plane: `facetHomeProvisioner` creates the table on the
    // first provision (orchestrator.ts provisionHostedActorHome; the CLI
    // runtime's nodeRuntime). Every hosted actor of that workspace is
    // provisioned a home when it is acquired, so a subordinate observes the
    // rows — its own among them — rather than holding a table of its own.
    kinu_agent_identity: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('facetHomeProvisioner'),
      'cf-subordinate': WIRED,
      cli: LAZY_ON_FIRST_USE('facetHomeProvisioner'),
    },
    // The webhook gate — auth, replay window, rate limit — is core's, and the
    // cloud orchestrator provisions its tables at boot, in the one database
    // every actor of that workspace reads. A local workspace has no inbound
    // HTTP transport in front of it: it mints no URL, `kinu triggers <name>
    // webhook` refuses a local target, and the session holds no delivery door,
    // so it provisions neither gate table.
    webhook_rate_windows: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_LOCAL_INGRESS },
    },
    // One row per signed delivery already spent, so a captured HMAC request
    // cannot be admitted twice inside its own signature window. Provisioned
    // beside the rate window by the one ingress init, on every root that has a
    // webhook gate at all — a host holding the window and not this would still
    // admit replays.
    webhook_replay_claims: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_LOCAL_INGRESS },
    },
    // The plaintext HMAC/bearer secret a registered webhook was created with,
    // built once a webhook is actually registered on cf, where the orchestrator
    // memoizes it (`_webhookSecrets ??=`). `identity/archive.ts` deliberately
    // excludes this table from a workspace archive because it is a live ingress
    // credential, so a restore does not resurrect one.
    webhook_secrets: {
      'cf-orchestrator': LAZY_ON_FIRST_USE('registerDurableWebhook'),
      'cf-subordinate': LAZY_ON_FIRST_USE('registerDurableWebhook'),
      cli: { absent: NO_LOCAL_INGRESS },
    },
    vfs_baseline: EVERYWHERE,
    // One row per container lifecycle incident the workspace has been told
    // about, carrying only whether that incident's announcement landed — the
    // dedupe that makes a retrying container produce one turn rather than one
    // per retry. Keyed to the WORKSPACE's container, which every actor of that
    // workspace shares and reads the incidents of; the CLI's executor is the
    // host machine rather than a container that can be restored, snapshotted
    // or discarded.
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
    // The sleep-time answer a terminal effect already paid for, kept between the
    // model call and the fact mutation so a replay applies the same update.
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

    // ── shared FTS5 stores (agent-utils MemoryStore / CraftStore) ──
    memory_chunks: EVERYWHERE,
    memory_chunks_fts: EVERYWHERE,
    crafted_tools_fts: EVERYWHERE,

    // ── core evolution stores created at engine/session construction ──
    // Both of these are created by their own consumer's constructor and by no
    // shared entry point, so a booted root that has not yet built one does not
    // have the table: `initCompletedTurnTable` runs in the EvolutionEngine
    // (evolution/engine.ts) and the mission ledger's DDL in
    // `new MissionBudgetLedger` (mission-budget.ts).
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

    // ── workspace capability token (cf identity plane) ──
    workspace_capability: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: NO_USER_PLANE('the workspace capability token') },
    },

    // ── the cf turn-lifecycle plane (created in the ActorAgent constructor) ──
    // Created before any read on BOTH cf roots, because the SDK does not
    // guarantee `onStart` precedes an RPC.
    pending_steers: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: { absent: 'a local session holds its steer queue in the driver that owns the turn; an eviction cannot separate the two' },
    },
    // The durable admission ledger that REPLACED the single `active_durable_turn`
    // row: one row keyed `id = 1` could hold one turn id for a whole database, so
    // it could name neither which issued actor owned the turn nor tell an evicted
    // activation from the one that replaced it. EVERYWHERE, unlike the row it
    // replaces, because the lifecycle is core's now: `initWorkspaceSchema` creates
    // both tables for the CLI and the shared `ActorAgent` constructor creates them
    // for both Durable Object roots, ahead of the `onStart` recovery sweep that
    // reads them. A resumed turn reads the context revision it was interrupted at
    // rather than the newest one, so the revisions travel with the claims.
    actor_turn_claims: EVERYWHERE,
    actor_context_revisions: EVERYWHERE,
    // The raw working history a `/context` edit rewrites, numbered per ACTOR
    // rather than per turn: an edit authored between turns, or before the
    // actor's first turn, belongs to no turn at all. Created unconditionally by
    // `initActorClaimTables` beside the two tables above, because the working
    // snapshot is written at hydration and turn admission — not on first edit —
    // so an actor that never edits anything still has it.
    actor_working_revisions: EVERYWHERE,
    // The terminal ledger is EVERYWHERE now. It was cf-only while the CLI
    // released its claims at transcript persist and had no recovery at all —
    // KINU-021 hoisted the lifecycle into core and the CLI drives the same
    // class, so an interrupted laptop turn replays its suffix exactly as an
    // evicted isolate does. Created per root rather than by a shared
    // initializer — `cf-backend/src/actor-agent.ts` in the shared `ActorAgent`
    // body (so both Durable Object roots) and `cli-backend/src/local-session.ts`
    // in the session constructor — which is still before any read on all three.
    terminal_effects: EVERYWHERE,
    // The CLI's alone, and the asymmetry is the platform's. A Durable Object is
    // told about its own answer by the runtime that persisted it, so a claim
    // written after that hook still covers the whole suffix. A local process can
    // die between persisting the answer and claiming it, so the roster is frozen
    // into this row in the SAME transaction as the messages and swept at the
    // next start.
    terminal_intents: {
      'cf-orchestrator': { absent: 'the response hook runs inside the activation that persisted the answer, so the claim cannot be separated from it' },
      'cf-subordinate': { absent: 'the response hook runs inside the activation that persisted the answer, so the claim cannot be separated from it' },
      cli: WIRED,
    },

    // ── the cf outbound intent logs (write-ahead + idempotency) ──
    // The WORKSPACE's logs, and both cf roots observe them: one database holds
    // every actor's rows, and a hire's outbound intent is written to the same
    // log the workspace's own is.
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
    // Built unconditionally by createCFRuntime for both actor profiles. On a
    // local session it exists only when the operator configured a second model:
    // the CLI has no credential catalogue to search for a cross-family one, so
    // core's documented same-model fallback is what runs, and every consumer
    // states that fallback rather than hiding it here.
    judge: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: WIRED,
    },
    // The turn reviewer, everywhere. Whether it RUNS is the owner's switch, read
    // per turn — never a wiring decision, because a workspace that turns the
    // advisor on must not need a redeploy to get one.
    advisor: EVERYWHERE,
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
  producer: CONFORMANCE_PRODUCERS,
} satisfies Partial<Record<ConformancePlane, readonly string[]>>;
