/**
 * `agents` — the ONE delegation tool. Every helper an actor can spawn or talk
 * to lives behind a single surface where the KIND of helper is a parameter:
 *
 *   swarm   — a configured search over ephemeral nodes of the calling agent,
 *             each a full multi-step tool loop on the same workspace, whose
 *             candidates are MEASURED against the caller's own objective.
 *   hire    — a persistent named subordinate that keeps its own context
 *             across turns and stays in the roster until dismissed;
 *             scope=workspace creates a specialist peer workspace instead.
 *   ask     — TWO targets, one action, and the target decides the lifetime.
 *             `agent` hands an EXISTING agent work: a subordinate's report (or
 *             a peer's reply) arrives as an event that wakes you. `role`
 *             creates a temporary full agent for this one question, waits for
 *             its single answer, returns it here, and releases it — it never
 *             enters the roster, and its transcript is kept.
 *   send    — fire-and-forget message to any agent.
 *   reply   — answer an incoming agent message event by event_id.
 *   list    — the unified roster: subordinates, peer workspaces, and the
 *             temporary agents running right now.
 *   dismiss — retire a subordinate (archived by default; context kept).
 *
 * The machinery underneath: swarm dispatches through `strategy/swarm-run.ts`,
 * whose nodes are real tool-using agents on the heads runtime; hire/ask/send
 * ride TeamToolDeps' facet substrate — a role-targeted ask through the very
 * same `SubordinateRuntime`, which is why a temporary agent is a REAL agent and
 * not a bare model call — and peer messaging rides PeersToolDeps' EventsHub
 * transport. Which actions exist is decided structurally by which deps the
 * backend wires — see agentsActionsFor.
 *
 * The swarm action's call contract is specified by docs/EXPLORATION.md — "Presets",
 * "Validity over the resolved configuration" and "Accepted and ignored".
 */
import { tool, jsonSchema } from 'ai';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import {
  AGENTS_TOOL_ACTIONS,
  BUILTIN_TOOL_SPECS,
  DELEGATION_CONVERSE,
  DELEGATION_FRAME,
  DELEGATION_INHERITANCE,
  DELEGATION_RUNGS,
  type AgentsToolAction,
} from './registry';
import { SwarmConfigSchema, SwarmNodeAssignmentsSchema, SwarmObjectiveSchema } from './swarm-input';
import { runSwarm, type SwarmRunDeps } from '../strategy/swarm-run';
import type { NodeLoopHost } from '../strategy/node-agent';
import type { PublishHeadStream } from '../heads/head-stream';
import { readStartedSwarmProfile } from '../strategy/swarm-resume';
import {
  NAMED_SWARM_PRESETS, SWARM_PRESETS, SWARM_PRESET_DOCTRINE,
  resolveSwarm, swarmValidity,
  type NamedSwarmPreset, type SwarmConfig, type SwarmInput, type SwarmNodeAssignment,
  type SwarmPreset,
} from '../strategy/swarm';
import {
  TIER_IDS,
  deriveRoleLabel, effectiveRoleCatalog,
  resolveTurnProfile,
  type ProfileAuthorityInputs, type ProfileProvenance,
  type ResolvedTurnProfile, type RoleId, type TierId,
} from '../profiles';
import { VERIFIER_KIND_DOC, VERIFIER_KINDS } from '../strategy/objective';
import type { Objective } from '../strategy/objective';
import { readResumeRedrive, readSpawnStarted } from '../jobs/threshold';
import {
  localMissionScope, readMissionLimits,
  type MissionGovernor, type MissionScope,
} from '../mission-budget';
import type { NodeWorkspace, NodeWorkspaceProvisioner } from '../strategy/node-workspace';
import type { AgentRuntime } from '../types/agent-runtime';
import type { CostModel } from '../mcts/cost';
import type { WorkMode } from '../prompting/surface';
import { nanoid } from '../utils/nanoid';
import type { RoleSelection } from '../config/store';
import { diagnostics, renderThrownChain } from '../obs/index';
import {
  delegationDepthRefusal,
  delegationExhausted,
  type DelegationBudget,
  type DelegationDepthRefusal,
} from '../subordinates/depth';
import type {
  SubordinateLifetime,
  TemporaryAgentPort,
  TemporaryRunRequest,
} from '../subordinates/temporary';
import {
  parseJsonObject,
  type JsonObject,
  type JsonValue,
} from '../utils/json';

// ── Team (subordinate agents) deps contract ─────────────────────────────────
// The deps implementation rides the workspace DO's facet substrate: spawn =
// subAgent(SubordinateAgent, name) + seeded identity + roster row; assign /
// message publish `subordinate_task` events into the subordinate's EventLog
// (drained as its programmatic turn); reports come back as
// `subordinate_report` events on the parent.

export type SubordinateStatus = 'idle' | 'working' | 'awaiting_input' | 'dismissed';

/** One row of the workspace_subordinates roster: lifecycle and task facts
 *  ONLY. The title and role a subordinate presents live in its own
 *  agent_config (subordinates/support.ts SubordinateDescriptorSource) — the
 *  parent never mirrors them. */
export interface SubordinateRosterEntry {
  name: string;
  createdBy: 'orchestrator' | 'user';
  status: SubordinateStatus;
  currentTask: string | null;
  createdAt: number;
  dismissedAt: number | null;
  /**
   * How long this helper is MEANT to live — the one fact a role-targeted `ask`
   * adds to this roster, and the one nothing else can derive: a task-lifetime
   * row working on its question and a durable row working on an assignment are
   * the same shape, and only the first is released when it answers.
   */
  lifetime: SubordinateLifetime;
  /**
   * The EventLog id of the assignment this row is working on, or null when it
   * has none open. It is the id the eventual `subordinate_report` cites and the
   * id the sender was handed as {@link SubordinateHandoff.eventId}, so it is the
   * correlation this surface already documents rather than a second one.
   */
  taskEventId: string | null;
}

/**
 * How a handoff reaches a subordinate's model context.
 *
 * This is NOT a mode the caller picks — there is one delivery policy (the
 * subordinate's own drain decides), and this reports which branch it took.
 *
 * - `starts_now` — the subordinate was idle; the drain turns the event into a
 *   turn immediately.
 * - `queued` — the subordinate was busy or admission deduped against work
 *   already waiting; the task gets its own mode-homogeneous turn.
 */
export type SubordinateDelivery = 'starts_now' | 'queued';

/** What the subordinate was doing when the handoff landed. */
export interface SubordinatePhase {
  busy: boolean;
  lastActivityAt: number | null;
  /** The most recent activity line, or null when it has done nothing yet. */
  workingOn: string | null;
}

/**
 * The sender's half of a handoff. `eventId` is the id the eventual
 * `subordinate_report` cites, which is what lets a caller correlate an answer
 * arriving turns later with the thing it asked for.
 */
export interface SubordinateHandoff {
  eventId: string;
  delivery: SubordinateDelivery;
  phase: SubordinatePhase;
}

export interface TeamToolDeps {
  /**
   * Where the actor holding this roster sits in the subordinate tree, and how
   * much room is left below it (subordinates/depth.ts).
   *
   * On the roster rather than beside it because the two cannot be wired apart:
   * an actor with a roster HAS a position in the tree, and one without a roster
   * has no tree to have a position in. As a sibling optional field it was a
   * capability a backend could forget — the CLI has no roster at all, so it
   * would have had a contract to under-wire and nothing to gate.
   */
  readonly delegation: DelegationBudget;
  /** The workspace's subordinate roster (dismissed entries excluded). */
  list(): Promise<SubordinateRosterEntry[]>;
  /** Synchronous roster snapshot for the per-step dynamic context. */
  snapshot(): SubordinateRosterEntry[];
  /** Create an idle durable subordinate identity. This is the owner-facing
   *  operation: a mission defines the agent, but does not become a task until
   *  the owner explicitly messages or assigns it.
   *
   *  EVERY FIELD IS OPTIONAL, because an owner adding a second agent to a
   *  workspace has usually decided nothing about it yet. Omitted, `role` is
   *  the catalog's `general` and `mission` is the CREATING ACTOR'S OWN
   *  mission — the workspace's purpose, which is what a further agent in it
   *  is for. A caller that supplies nothing to name the agent by gets a blank
   *  display name and `auto` origin, which is what lets the shared
   *  first-interaction title policy claim it (identity/naming.ts). The
   *  model's `hire` goes through {@link spawn} and stays strict.
   *
   *  `role` is ONE typed selection — catalog id or legacy freeform line,
   *  written to the child's own config store at seed time. */
  create(input: {
    name?: string;
    /** A title the owner typed. Given, the name is THEIRS: origin `user`,
     *  never auto-retitled. */
    displayName?: string;
    role?: RoleSelection;
    tier?: TierId;
    mission?: string;
  }): Promise<{
    name: string; displayName: string; subordinate: SubordinateRosterEntry;
  }>;
  /** Retitle a subordinate on the OWNER's behalf: writes the child's own
   *  naming state with a `user` origin — which permanently stops
   *  auto-titling, since `planWorkspaceTitle` refuses that origin. */
  rename(input: { name: string; displayName: string }): Promise<{
    ok: true; name: string; displayName: string; subordinate: SubordinateRosterEntry;
  }>;
  /** Record a title the CHILD has already settled on its own naming state —
   *  the first-interaction auto-title, which only the child can run because
   *  only the child sees its own owner-driven turns.
   *
   *  The child IS the naming authority, so this writes nothing: it refreshes
   *  roster listeners so every reader re-projects from the child descriptor. */
  recordTitle(input: { name: string; displayName: string }): Promise<{
    ok: true; name: string; displayName: string;
  }>;
  /** Create a durable subordinate; its first turn is the mission. Same role
   *  vocabulary as {@link create}. */
  spawn(input: {
    name?: string;
    role: RoleSelection;
    mission: string;
    tier?: TierId;
    mode: WorkMode;
  }): Promise<{
    name: string; displayName: string;
  }>;
  /** Enqueue a task on the subordinate (drained as its next turn). */
  assign(input: { name: string; task: string; deliverable?: string; deadlineHint?: string; mode: WorkMode }): Promise<
    { ok: true; name: string } & SubordinateHandoff
  >;
  /**
   * Does this roster hold `name` AT ALL — including a row it has archived?
   *
   * Separate from {@link list} because the two questions differ on exactly the
   * rows that matter here. `list` is the WORKING SET, and ask/send route on it:
   * a dismissed agent must not be handed new work. This is PROVENANCE, and
   * `list`'s answer was wrong for it — a released temporary agent's own result
   * names it, and a `list` detail lookup on that name fell through to the peer
   * path and dead-ended. Archived rows are readable, never addressable.
   */
  knows(name: string): Promise<boolean>;
  /** Roster row + live snapshot for one subordinate, or the whole roster.
   *  Resolves an ARCHIVED row too, which is what makes a released temporary
   *  agent's transcript reachable by the name its result reported. */
  status(input: { name?: string }): Promise<object>;
  /** Conversational injection into the subordinate's next turn. */
  message(input: { name: string; content: string; mode: WorkMode }): Promise<
    { ok: true; name: string } & SubordinateHandoff
  >;
  /** Retire a subordinate. Default is ARCHIVE (facet + context kept, no
   *  longer addressed); storage is wiped only on explicit keepHistory=false. */
  dismiss(input: {
    name: string;
    keepHistory?: boolean;
    /** Trusted caller attribution. The model tool omits this, while the owner
     *  RPC supplies `user`; user-created agents cannot be retired by a model. */
    requestedBy?: 'orchestrator' | 'user';
  }): Promise<{
    ok: true; name: string; historyKept: boolean;
  }>;
  /**
   * The TEMPORARY rung: one full child agent, run to completion inside the
   * call, its single answer returned as the tool result, and ARCHIVED in the
   * roster above the moment it answers. It is a row in that one roster while it
   * works, under `lifetime:'task'` — the rung adds a lifetime, never a register.
   *
   * OPTIONAL IN THE TYPE, REQUIRED IN EFFECT wherever a backend wires a child
   * substrate at all — the same shape {@link AgentsForkDeps.resolveModel}
   * carries. It is a port and not a deps GROUP because it is not a capability
   * an actor can hold independently: it rides this roster's own
   * `SubordinateRuntime`, so an actor with a roster has the substrate for it by
   * construction and one without has nothing to build it from. Unwired, `ask`
   * takes only an existing agent — structurally, in the schema, in the sandbox
   * declaration and in the prompt.
   */
  readonly temporary?: TemporaryAgentPort;
}

// ── Peers (cross-workspace agents) deps contract ────────────────────────────
// The deps implementation rides the existing EventsHub peer transport:
// PeerHub queues an `outbox_peer` row → receiver's receivePeerMessage →
// EventLog → turn, with replies routed back through the receiver's peer-back
// reply channel.

export type PeerSendOutcome =
  | { status: 'delivered' | 'queued'; message_id: string }
  | { status: 'rejected'; reason: string };

export type PeerAskOutcome =
  | { status: 'replied'; from: string; reply: JsonValue | undefined }
  | { status: 'rejected'; reason: string };

export type PeerReplyOutcome = { ok: true } | { ok: false; error: string };

export type PeerSpawnOutcome = { agent: string; created: boolean } & PeerAskOutcome;

export interface PeersToolDeps {
  /** The owner's other workspaces' agents this one may address (self excluded). */
  listPeers(): Promise<Array<{ name: string; displayName?: string }>>;
  /** Send-and-await: deliver a message and wait for the reply. There is no
   *  elapsed limit on the wait — it ends when the reply arrives, and a reply
   *  that outlives this activation arrives as a peer event instead. */
  ask(input: { agent: string; topic: string; message: string; mode: WorkMode; signal?: AbortSignal }): Promise<PeerAskOutcome>;
  /** Fire-and-forget: deliver a message without waiting for a reply. */
  send(input: { agent: string; topic: string; message: string; mode: WorkMode }): Promise<PeerSendOutcome>;
  /** Answer a peer message event received this (or an earlier) turn. */
  reply(input: { eventId: string; message: string }): Promise<PeerReplyOutcome>;
  /** Create (or reuse by name) a specialist workspace, message its agent, await
   *  the result — under the same no-elapsed-limit wait as {@link ask}. */
  spawnWorkspace(input: { name?: string; purpose: string; message: string; mode: WorkMode; signal?: AbortSignal }): Promise<PeerSpawnOutcome>;
}

/** Reserved topic for transport-generated reply envelopes; user sends must not claim it. */
export const PEER_REPLY_TOPIC = 'peer_reply';

/** What the sender is told about a handoff, in the tool's snake_case shape. */
function renderHandoff(handoff: SubordinateHandoff) {
  return {
    event_id: handoff.eventId,
    delivery: handoff.delivery,
    subordinate_phase: handoff.phase,
  };
}

const ASSIGN_NOTES = {
  starts_now: 'Assigned. The subordinate was idle and starts on it now.',
  queued: 'Queued behind the subordinate\'s current or already-admitted work as its own turn.',
} satisfies Record<SubordinateDelivery, string>;

// ── Exploration substrate deps contract ─────────────────────────────────────

/**
 * What an actor needs to run a search of its own: a model to expand with and a
 * workspace to measure in. Wired under the `fork` key on
 * {@link AgentsToolDeps}; both backends construct the same typed contract.
 *
 * `runSwarmAction` reads `rt`, `model`, `nodeHost`, `provisionNodeHome`,
 * `reportNodeDelta` and `compactShared`. The members exist because the
 * backends' one builder produces the whole bag, not because this module
 * dispatches a strategy.
 */
export interface AgentsForkDeps {
  rt: AgentRuntime;
  model: LanguageModel;
  /**
   * The ONE seam that turns a resolved tier's model SPEC into the model a
   * delegated node actually runs on.
   *
   * `model` above is the CALLER's own turn model, and until this existed it was
   * also every node's: `tier` was documented as "the ONE routing input" for a
   * delegation, the resolver produced the tier's model, the run recorded it in
   * its durable snapshot — and then handed the caller's model to every node. A
   * `tier:'deep'` search ran at the caller's tier and its ledger said
   * otherwise, which is worse than not routing at all: the spend and the
   * provenance both name a model that never ran.
   *
   * Takes the spec in the same spelling as `ProfileCatalogEnvelope` tier
   * assignments and `ProviderCatalogSnapshot.availableModels`, so the string
   * the owner configured is the string resolved here.
   *
   * OPTIONAL IN THE TYPE, REQUIRED IN EFFECT wherever
   * {@link AgentsToolDeps.profile} is wired: a run carrying a profile snapshot
   * and finding no resolver REFUSES (`runSwarm`), rather than running one model
   * under a record claiming another. Absent with no catalog is the honest
   * unrouted case — there is no tier to route to — and then nodes run
   * `model`.
   */
  resolveModel?: (spec: string) => LanguageModel;
  /** The caller conversation at dispatch. Frozen into the search ledger so
   * `context:'fork'` survives background re-drive and DO eviction. */
  originContext?: () => readonly ModelMessage[];
  /** What the resolved model charges, for gates on projected spend before
   *  starting. Backends wire the ModelCatalogSession they already hold;
   *  absence makes the gate blend and say so. */
  costModel?: () => CostModel;
  /**
   * Where a tool-using swarm node's loop runs, resolved per call.
   *
   * A FACTORY for the same reason `costModel` is: a
   * backend may not be able to build one until the actor has an owner, so
   * resolving it at dispatch keeps the refusal where it can be reported rather
   * than at wiring time. Absent is a backend with no facets, and then a node's
   * loop runs in this isolate — the same body, without a storage boundary.
   */
  nodeHost?: () => NodeLoopHost;
  /**
   * The host-owned provisioner for one node's private home. The provisioner is
   * async because a hosted Nimbus session owns the filesystem; a synchronous
   * `SqliteVFS` view is only one possible implementation, not the contract.
   *
   * It is resolved per swarm call. Absent means this backend cannot provide a
   * credentialed home, so nodes accurately report the shared plane.
   */
  provisionNodeHome?: () => NodeWorkspaceProvisioner;
  /**
   * The host-owned builder for one node's own runtime, over the workspace that
   * provisioner just handed back.
   *
   * Paired with {@link provisionNodeHome} and useless without it: a home is
   * uid/gid/mode on real inodes, and the shell and file plane the node's loop
   * uses have to act as that uid or the boundary holds on neither. Absent is a
   * backend that provisions but cannot re-credential its own primitives, and
   * then the loop runs as the origin — see
   * {@link NodeAgentDeps.runtimeForWorkspace}.
   */
  runtimeForNodeWorkspace?: () => (workspace: NodeWorkspace) => Promise<AgentRuntime>;
  /**
   * Where a node's transient output frames go while a step is still being
   * produced — the backend's own broadcast channel, resolved per call for the
   * same reason {@link nodeHost} is.
   *
   * A HOSTED node does not use this: its facet publishes to the parent over the
   * RPC it already holds. This is the IN-ISOLATE half, where there is no facet
   * and the loop runs beside the socket. Absent is a backend with nothing
   * watching, and costs a node nothing — the frames are superseded by its steps.
   */
  reportNodeDelta?: () => PublishHeadStream;
  /**
   * The shared-prefix compaction ladder for *Inherited context*, over the same
   * `SwarmRunDeps.compactShared` seam the engine consumes. The backend wires the real
   * better-compact ladder here (packages/compaction); absent, a parent past its window
   * inherits verbatim and the provider refuses — the loud failure the seam documents.
   */
  compactShared?: SwarmRunDeps['compactShared'];
}

/**
 * What an actor needs to resolve role/tier/preset precedence: the catalog
 * authority its turns run under, a provider snapshot to check tier models
 * against, its own active role, and the action surface role narrowing applies
 * to. Wired under {@link AgentsToolDeps.profile} by every backend that has an
 * authority — signed in (account catalog) or signed out (local catalog).
 * Absent is an actor whose backend has no catalog yet: hire falls back to its
 * legacy freeform behaviour, and swarm requires an explicit preset.
 */
export interface AgentsProfileContext extends ProfileAuthorityInputs {
  /** The actor's own active role — what a swarm or hire without an explicit
   *  role resolves through, and whose `spawns` list bounds both. */
  readonly roleId: RoleId;
  /** The caller's merged tool surface, for the resolver's narrowing half. */
  readonly availableTools: readonly string[];
}

/** Project one resolved turn into the profile context the agents tool needs. */
export function agentsProfileContext(
  profile: ResolvedTurnProfile | null,
  authority: ProfileAuthorityInputs | null,
): AgentsProfileContext | null {
  if (!profile || !authority) return null;
  return {
    ...authority,
    roleId: profile.role.id,
    availableTools: profile.allowedTools,
  };
}

export interface DelegatedProfile {
  readonly resolved: ResolvedTurnProfile;
  readonly sources: ProfileProvenance;
}

export interface AgentsToolDeps {
  /** Trusted mode of the turn executing this dispatch. It is host-owned and
   * never appears in the model schema, so a delegated child cannot opt out of
   * a Plan turn's mutation bar. */
  mode: WorkMode;
  /** The exploration substrate — a model to expand with and a workspace to
   *  measure in. Wired wherever a backend has one: both backends, subordinates
   *  too. Its presence is what puts `swarm` in this actor's enum. */
  fork?: AgentsForkDeps;
  /** Persistent subordinates. Wired on every actor that can hold a roster —
   *  the workspace orchestrator and, since a subordinate tree is recursive,
   *  every subordinate with depth left below it. */
  team?: TeamToolDeps;
  /** Cross-workspace peer messaging — workspace-orchestrator only.
   *
   *  Deliberately NOT granted to subordinates, and the reason is the depth cap
   *  rather than tidiness: `hire scope=workspace` creates a WORKSPACE, whose
   *  orchestrator is the root of a fresh tree with the whole cap below it. A
   *  subordinate holding `peers` could therefore mint a new root and escape its
   *  own subtree in one call, making the derivation below decorative. The
   *  second reason stands on its own — a peer workspace is a boundary its
   *  parent owns, and a subordinate reaching across it acts on an ownership
   *  relation it is not party to. */
  peers?: PeersToolDeps;
  /** The actor's mission budget governor. Wired, it makes this the SPAWN seam — no
   *  helper is launched under an exhausted label, and a fork's own declared cap nests
   *  under the mission that spawned it — and it hands a search the PORT its model calls
   *  charge through as it makes them, so a cap stops the run rather than being reported
   *  after it. Unwired (or unscoped, the default) changes nothing. */
  budget?: MissionGovernor;
  /** The actor's profile authority — the one resolver input set role/tier/
   *  precedence reads. A thunk because a backend may sign in (or load its
   *  local catalog) after the toolset was built, and an absent factory is an
   *  actor with no catalog: hire keeps its legacy freeform behaviour and
   *  swarm demands an explicit preset. */
  profile?: () => AgentsProfileContext | null;
}

interface UnifiedRosterResult {
  /** ONE roster. A temporary agent is a row in it while it works, carrying
   *  `lifetime:'task'`; a released one is the archived row this same roster
   *  keeps, readable through `list` with an `agent` name. */
  subordinates?: SubordinateRosterEntry[];
  peers?: Array<{ name: string; displayName?: string }>;
  note?: string;
}

/** Which actions this deps set structurally supports. The single gating rule
 *  shared by the tool schema, the system prompt's Delegation section and the
 *  `agents.*` codemode namespace.
 *  Presence-typed so prompt assembly can ask without building the substrate. */
export function agentsActionsFor(deps: { fork?: object; team?: object; peers?: object }): AgentsToolAction[] {
  const converse = !!deps.team || !!deps.peers;
  const present = {
    // Structural rather than a choice: a search needs a model to expand with and a
    // workspace to measure in, which is exactly what AgentsForkDeps carries. It is
    // not a capability a backend could wire half of, so it gets no deps group of
    // its own — an actor with the exploration substrate can run a configured
    // search, and one without it has no search rung at all.
    swarm: !!deps.fork,
    hire: converse,
    ask: converse,
    send: converse,
    reply: !!deps.peers,
    list: converse,
    dismiss: !!deps.team,
  } satisfies Record<AgentsToolAction, boolean>;
  return AGENTS_TOOL_ACTIONS.filter((action) => present[action]);
}

/** The docstring for a given action surface — composed from the same registry
 *  constants the full spec is built from, so a full surface renders the
 *  registry description verbatim and a gated one drops whole rungs. */
export function renderAgentsToolDescription(deps: AgentsToolDeps): string {
  const spec = BUILTIN_TOOL_SPECS.agents;
  const use = [
    DELEGATION_FRAME,
    ...(deps.fork ? [DELEGATION_RUNGS.swarm] : []),
    ...(deps.team?.temporary ? [DELEGATION_RUNGS.temporary] : []),
    ...(deps.team || deps.peers ? [DELEGATION_RUNGS.hire] : []),
    ...(deps.peers
      ? [DELEGATION_CONVERSE]
      : deps.team
        ? ['ask/send message a subordinate by name (ask hands it work and expects its report back, send is fire-and-forget); list shows the roster.']
        : []),
  ].join(' ');
  return [
    spec.summary,
    `Use when: ${use}`,
    `Avoid when: ${spec.whenNotToUse}`,
    `Returns: ${spec.result}`,
  ].join('\n');
}

// ── Input shape ─────────────────────────────────────────────────────────────

export interface AgentsToolInput {
  action: AgentsToolAction;
  // swarm — the configured-search rung. `preset` and `objective` are the two halves
  // of the *Presets* rule: a preset fixes the search, the caller supplies the
  // objective.
  /** What the search is for, in prose — never the measured quantity. */
  task?: string;
  /** Cumulative spend cap for everything this helper transitively spawns.
   *  Nests under the caller's mission scope, so an inner cap can only ever be
   *  tighter than the outer one. Omit for the uncapped default. */
  budget_usd?: number;
  budget_tokens?: number;
  /** Name the sub-ledger. Defaults to a generated label under the caller's
   *  mission; naming it lets a run keep one budget across several calls. */
  budget_label?: string;
  preset?: SwarmPreset;
  /** What is measured, in what unit, which direction is better. OPTIONAL on every
   *  preset — omitted, a preset takes its judged sweep; refused on `ideate`, which
   *  has no value signal by design. */
  objective?: Objective;
  /** The coverage key an archive bins elites into. */
  key?: string;
  /** The axes, with `preset:'custom'` only — the OVERRIDE half of a composition. */
  config?: Partial<SwarmConfig>;
  from?: NamedSwarmPreset;
  label?: string;
  /** What this search is called — the short handle the exploration surface
   *  shows on the tree root, the run rows and the detail header. Optional;
   *  a search without one is named from its task. */
  name?: string;
  branches?: number;
  depth?: number;
  /** The first level, node by node: `{ prompt, task }` each. Mutually exclusive
   *  with `branches`, whose count-based mode has the engine vary the angle
   *  instead. See {@link SwarmInput.nodes}. */
  nodes?: readonly SwarmNodeAssignment[];
  /** The role a delegation runs under — the swarm's nodes, the hired
   *  subordinate, or the TEMPORARY agent a role-targeted `ask` creates.
   *  Explicit wins; omitted, a swarm rides the caller's own active role. One
   *  swarm is ROLE-HOMOGENEOUS — mixed-role candidates confound comparison, so
   *  there is one role per call, never a list. On `ask` it is the target: it is
   *  mutually exclusive with `agent`, and naming it is what asks for a helper
   *  that does not exist yet. */
  role?: RoleId;
  /** The inference tier the delegation runs at: `tiny|fast|default|slow|deep`.
   *  Explicit wins; omitted resolves through the role's default tier, then
   *  `default`. This is the ONE routing input — direct model specs are not
   *  part of this surface. */
  tier?: TierId;
  // hire / converse
  agent?: string;
  mission?: string;
  scope?: 'subordinate' | 'workspace';
  message?: string;
  topic?: string;
  deliverable?: string;
  deadline_hint?: string;
  event_id?: string;
  keep_history?: boolean;
  /**
   * Material a role-targeted `ask` answers over, BY WORKSPACE PATH.
   *
   * The paths are authorized against this workspace's file plane and handed to
   * the temporary agent, which reads them itself — in ranges when they are
   * large, because it is a real agent with real file tools. The bytes never
   * enter YOUR window, which is the whole reason to name a spill file here
   * instead of pasting it into `message`. A path this workspace cannot resolve
   * is refused by name; nothing is truncated and nothing is guessed.
   */
  context_ref?: readonly string[];
}

/** Every input field except the discriminant. */
export type AgentsToolInputField = Exclude<keyof AgentsToolInput, 'action'>;

/**
 * Which fields each action's handler reads — the relation nothing enforced.
 *
 * An action could join `AGENTS_TOOL_ACTIONS` while its fields never joined the
 * schema, and the only symptom was that every one of them arrived ABSENT: a
 * caller who asked for something got the same input a caller who asked for
 * nothing did. This map is what makes that a build failure instead: it is
 * `Record<AgentsToolAction, ...>`, so an action added to the picklist with no
 * fields does not compile, and `gate:agents-fields` holds each list to the
 * `input.<field>` reads its case arm in `dispatchAgentsAction` actually performs
 * — the handler, not this declaration, is the authority for what an action reads.
 *
 * Load-bearing at runtime, not just under the gate: a refusal names the fields
 * the called action takes, and a field outside the list is refused rather than
 * accepted and ignored.
 */
export const AGENTS_ACTION_FIELDS = {
  // The mission caps sit beside the swarm's own fields because *Presets* puts them
  // there deliberately: `budget_usd`, `budget_tokens` and `budget_label` are
  // PRE-EXISTING caps on this input, read through `missionScope` and enforced by the
  // governor.
  //
  // An ITERATION cap and a WALL-CLOCK cap are DELIBERATELY ABSENT, and that is a
  // disagreement recorded rather than papered over: the removed specification called
  // both optional on every preset — but nothing here cuts a search off on either, so
  // declaring them would make this surface accept a cap nothing applies, which is the
  // precise defect *Accepted and ignored* is written against. A caller who sends one
  // is TOLD (the field refusal names the actions that read it) instead of quietly
  // ignored. They join this list when something enforces them.
  swarm: [
    'task', 'preset', 'objective', 'key', 'config', 'from', 'label', 'name', 'branches', 'depth',
    'nodes',
    'role', 'tier',
    'budget_usd', 'budget_tokens', 'budget_label',
  ],
  hire: ['agent', 'role', 'mission', 'tier', 'scope', 'message'],
  // Two TARGETS, one action. `agent` names one that exists; `role` asks for one
  // that does not and gets a temporary agent for the question. `context_ref`
  // belongs to the second only — an existing agent already has this workspace,
  // so naming paths at it would be advice, not a channel.
  // Ordered by VARIANT, existing target first: the codemode declaration renders
  // one object per variant and the union of those objects is held to this list,
  // so the order here is the order a reader meets the fields in.
  ask: ['agent', 'message', 'topic', 'deliverable', 'deadline_hint', 'role', 'context_ref'],
  send: ['agent', 'message', 'topic'],
  reply: ['event_id', 'message'],
  list: ['agent'],
  dismiss: ['agent', 'keep_history'],
} as const satisfies Record<AgentsToolAction, readonly AgentsToolInputField[]>;

/** One action's fields, as plain names. The `as const` above keeps each list's
 *  literal type — which is what lets the advertised JSON-Schema properties be
 *  DERIVED from it below — and this is where that precision is spent for the
 *  ordinary string work: membership, and the list a refusal prints. */
const fieldsOf = (action: AgentsToolAction): readonly string[] => AGENTS_ACTION_FIELDS[action];

/** Every input field and its type, declared ONCE. The two policies below read
 *  these same entries — the model-facing parse REFUSES an unrecognised field,
 *  the replay filter DROPS it — so neither can come to declare a field the
 *  other does not. */
const AgentsInputEntries = {
  action: v.picklist(AGENTS_TOOL_ACTIONS),
  task: v.optional(v.string()),
  budget_usd: v.optional(v.number()),
  budget_tokens: v.optional(v.number()),
  budget_label: v.optional(v.string()),
  // swarm. Spelled out here rather than spread in from tools/swarm-input.ts, because
  // `gate:agents-fields` reads THESE KEYS as the declaration side of the relation: a
  // spread would hide every one of them from the gate, which is the same
  // pass-by-omission the gate exists to catch.
  preset: v.optional(v.picklist(SWARM_PRESETS)),
  objective: v.optional(SwarmObjectiveSchema),
  key: v.optional(v.string()),
  config: v.optional(SwarmConfigSchema),
  from: v.optional(v.picklist(NAMED_SWARM_PRESETS)),
  label: v.optional(v.string()),
  name: v.optional(v.string()),
  branches: v.optional(v.number()),
  depth: v.optional(v.number()),
  nodes: v.optional(SwarmNodeAssignmentsSchema),
  agent: v.optional(v.string()),
  role: v.optional(v.string()),
  mission: v.optional(v.string()),
  // The one routing input. A picklist, not a string: an unknown tier name is a
  // caller error worth naming the five slots over, not a freeform value to
  // guess at.
  tier: v.optional(v.picklist(TIER_IDS)),
  scope: v.optional(v.picklist(['subordinate', 'workspace'])),
  message: v.optional(v.string()),
  topic: v.optional(v.string()),
  deliverable: v.optional(v.string()),
  deadline_hint: v.optional(v.string()),
  event_id: v.optional(v.string()),
  keep_history: v.optional(v.boolean()),
  context_ref: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
};

/**
 * The TypeScript type each input field renders as in the codemode
 * declaration. Declared HERE, beside the field lists and the parse entries,
 * because this is the one place that already owns every field name — the
 * `agents.*` namespace renders its input types from this table plus
 * {@link AGENTS_ACTION_FIELDS}, so a field that joins the surface without a
 * rendered type fails to compile rather than silently missing from the
 * sandbox contract.
 */
export const AGENTS_FIELD_TS_TYPES = {
  task: 'string',
  budget_usd: 'number',
  budget_tokens: 'number',
  budget_label: 'string',
  preset: `"${SWARM_PRESETS.join('" | "')}"`,
  objective: 'object',
  key: 'string',
  config: 'object',
  from: `"${NAMED_SWARM_PRESETS.join('" | "')}"`,
  label: 'string',
  name: 'string',
  branches: 'number',
  depth: 'number',
  nodes: '{ prompt: string; task: string }[]',
  role: 'string',
  tier: `"${TIER_IDS.join('" | "')}"`,
  agent: 'string',
  mission: 'string',
  scope: '"subordinate" | "workspace"',
  message: 'string',
  topic: 'string',
  deliverable: 'string',
  deadline_hint: 'string',
  event_id: 'string',
  keep_history: 'boolean',
  context_ref: 'string[]',
} as const satisfies Record<AgentsToolInputField, string>;

/**
 * The fields each action's caller MUST supply — the `?`-less half of the same
 * relation {@link AGENTS_ACTION_FIELDS} states. The codemode declaration
 * renders optionality from it; the dispatch arms re-check it at runtime
 * because the sandbox parse cannot see which action is coming.
 */
export const AGENTS_ACTION_REQUIRED_FIELDS = {
  swarm: ['task'],
  hire: ['role', 'mission'],
  ask: ['agent', 'message'],
  send: ['agent', 'message'],
  reply: ['event_id', 'message'],
  list: [],
  dismiss: ['agent'],
} as const satisfies Record<AgentsToolAction, readonly AgentsToolInputField[]>;
const HIRE_SUBORDINATE_FIELDS = [
  'agent', 'role', 'mission', 'tier',
] as const satisfies readonly AgentsToolInputField[];
const HIRE_WORKSPACE_FIELDS = [
  'agent', 'mission', 'scope', 'message',
] as const satisfies readonly AgentsToolInputField[];
/** The temporary rung's own fields. `tier` is deliberately absent: a temporary
 *  agent runs at its ROLE's tier, which is the one routing input this surface
 *  has, and a second knob here would be a model spec by another name. */
const ASK_ROLE_FIELDS = [
  'role', 'message', 'context_ref',
] as const satisfies readonly AgentsToolInputField[];

export interface AgentsActionInputVariant {
  readonly required: readonly AgentsToolInputField[];
  readonly fields: readonly AgentsToolInputField[];
  readonly scope?: 'subordinate' | 'workspace';
  readonly scopeOptional?: boolean;
  /**
   * Fields that must be ABSENT for this variant — the XOR half of a choice with
   * no discriminant field to be `const` on.
   *
   * `hire` has one: `scope` is a literal, so exactly one branch matches and the
   * variants separate themselves. `ask` has none — its two targets are two
   * different FIELDS, so without this the two branches overlap and a call
   * naming both would satisfy each of them. Stated here, the schema TELLS the
   * model the targets are exclusive; the dispatch below is what enforces it,
   * with a message a caller can correct itself from.
   */
  readonly excludes?: readonly AgentsToolInputField[];
}

/** The accepted input variants for one action on this actor. Native JSON
 * Schema and codemode declarations both project this table. */
export function agentsActionInputVariantsFor(
  deps: AgentsToolDeps,
  action: AgentsToolAction,
): readonly AgentsActionInputVariant[] {
  if (action === 'ask') return askInputVariants(deps);
  if (action !== 'hire') {
    return [{
      fields: agentsActionFieldsFor(deps, action),
      required: AGENTS_ACTION_REQUIRED_FIELDS[action],
    }];
  }
  const variants: AgentsActionInputVariant[] = [];
  if (deps.team) {
    const fields: AgentsToolInputField[] = [...HIRE_SUBORDINATE_FIELDS];
    if (deps.peers) fields.push('scope');
    variants.push({
      fields,
      required: ['role', 'mission'],
      scope: 'subordinate',
      scopeOptional: true,
    });
  }
  if (deps.peers) {
    variants.push({
      fields: HIRE_WORKSPACE_FIELDS,
      required: ['mission', 'scope', 'message'],
      scope: 'workspace',
    });
  }
  return variants;
}

/** `ask`'s targets: the existing-agent handoff always, and the temporary agent
 *  only where the port that runs one is wired. */
function askInputVariants(deps: AgentsToolDeps): readonly AgentsActionInputVariant[] {
  const existing: AgentsToolInputField[] = ['agent', 'message'];
  if (deps.peers) existing.push('topic');
  if (deps.team) existing.push('deliverable', 'deadline_hint');
  const existingTarget: AgentsActionInputVariant = {
    fields: existing,
    required: ['agent', 'message'],
  };
  // The exclusion only exists when the other target does: with no temporary port
  // there is no `role` on this action to be exclusive WITH.
  if (deps.team?.temporary) Object.assign(existingTarget, { excludes: ['role'] });
  const variants: AgentsActionInputVariant[] = [existingTarget];
  if (deps.team?.temporary) {
    variants.push({
      fields: ASK_ROLE_FIELDS,
      required: ['role', 'message'],
      excludes: ['agent'],
    });
  }
  return variants;
}

/** Fields one action actually reads under the transports this actor wires. */
export function agentsActionFieldsFor(
  deps: AgentsToolDeps,
  action: AgentsToolAction,
): readonly AgentsToolInputField[] {
  const fields = AGENTS_ACTION_FIELDS[action];
  switch (action) {
    case 'swarm':
      return deps.fork ? fields : [];
    case 'hire':
      if (deps.team && deps.peers) {
        return fields.filter(field =>
          HIRE_SUBORDINATE_FIELDS.some(candidate => candidate === field)
          || HIRE_WORKSPACE_FIELDS.some(candidate => candidate === field));
      }
      if (deps.team) return HIRE_SUBORDINATE_FIELDS;
      if (deps.peers) return HIRE_WORKSPACE_FIELDS;
      return [];
    case 'ask':
      return fields.filter(field =>
        field === 'agent'
        || field === 'message'
        || ((field === 'role' || field === 'context_ref') && deps.team?.temporary !== undefined)
        || (field === 'topic' && deps.peers !== undefined)
        || ((field === 'deliverable' || field === 'deadline_hint') && deps.team !== undefined));
    case 'send':
      return fields.filter(field =>
        field === 'agent' || field === 'message' || (field === 'topic' && deps.peers !== undefined));
    case 'reply':
      return deps.peers ? fields : [];
    case 'list':
      return deps.team || deps.peers ? fields : [];
    case 'dismiss':
      return deps.team ? fields : [];
  }
}

function agentsJsonSchemaVariants(
  deps: AgentsToolDeps,
  actions: readonly AgentsToolAction[],
) {
  return actions.flatMap(action =>
    agentsActionInputVariantsFor(deps, action).map((variant) => {
      const properties = {
        action: { const: action },
        scope: variant.scope === undefined ? false : { const: variant.scope },
      };
      const branch = {
        type: 'object' as const,
        properties,
        required: ['action', ...variant.required],
      };
      // Exclusivity as JSON Schema: the fields this branch REFUSES. Without it
      // the two `ask` targets overlap and a call naming both matches each, so
      // `oneOf` would be decorative on exactly the mistake it is here for.
      if (variant.excludes && variant.excludes.length > 0) {
        Object.assign(branch, {
          not: { anyOf: variant.excludes.map((field) => ({ required: [field] })) },
        });
      }
      return branch;
    }));
}

/**
 * The model-facing parse. `strictObject`, not `object`: valibot's `object`
 * EXCLUDES an unrecognised entry rather than rejecting it, which on this surface
 * is not a cosmetic difference. Measured against the flat `object` this replaces:
 *
 *   parseAgentsToolInput({ action:'fork', task:'x', budgetUsd:5, wallClockMs:1000 })
 *     -> { action:'fork', task:'x' }
 *
 * Both caps gone. A model that spelled a cap camelCase asked for a $5 ceiling,
 * got no ceiling, and nothing in the error, the result or the run record said its
 * request had vanished. `fork` has since left the picklist, so that exact call is
 * refused twice over — but the shape the surface provokes is unchanged, because
 * every cap on it is still snake_case and camelCase is the expected mistake.
 */
const AgentsToolInputSchema = v.strictObject(AgentsInputEntries);

/**
 * The REPLAY parse, over a durable job row instead of a model's call. A row is
 * history: no model is listening for a correction, and refusing the row would
 * turn an interrupted search into a hard failure (JobNotResumable) over a field
 * that was ALREADY dropped when the row was first dispatched. So unknown entries
 * are dropped here — which is what makes the re-drive faithful to the run it
 * resumes — and `resumableAgentsInput` logs the drop rather than repeating it
 * silently.
 *
 * `action` is a plain string here and a picklist on the model-facing parse, and
 * that difference is the whole point: a row can name an action this surface no
 * longer has, and translating it is exactly the job. Refusing it at the parse
 * would strand the rows the translation exists for.
 */
const StoredAgentsInputSchema = v.object({ ...AgentsInputEntries, action: v.string() });

/** Every field name in declaration order — what a refusal suggests from when the
 *  action itself is unreadable, and the set the picklist gate holds the
 *  per-action map against. */
const AGENTS_INPUT_FIELDS: readonly string[] = Object.keys(AgentsInputEntries)
  .filter((field) => field !== 'action');

/** True when `action`'s handler reads `field`. The gate holds AGENTS_ACTION_FIELDS
 *  to what `dispatchAgentsAction` actually reads, so a field outside this relation
 *  provably cannot reach the call it was written on. */
function actionReads(action: AgentsToolAction, field: string): boolean {
  return fieldsOf(action).some((declared) => declared === field);
}

/** One typo, or the same word under another convention. */
const MAX_FIELD_EDIT_DISTANCE = 2;

/** Everything a naming convention can differ by. Collapsing it is what makes
 *  `budgetUsd`, `budget-usd` and `Budget USD` all reach `budget_usd` — the
 *  measured mistake, not a hypothetical one. */
const FIELD_NAME_SEPARATORS = /[^a-z0-9]/gi;

/** Levenshtein distance, abandoned once every cell in a row exceeds `limit`: a
 *  candidate that cannot be the intended field costs a length check rather than
 *  |a|x|b| cells. Returns `limit + 1` for "further away than limit". */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitute = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = row[j];
      const next = Math.min(substitute, row[j] + 1, row[j - 1] + 1);
      row[j] = next;
      if (next < best) best = next;
    }
    if (best > limit) return limit + 1;
  }
  return row[b.length];
}

/** The field `name` was probably meant to be, or undefined when nothing is close
 *  enough to name. Convention first, then one or two character edits (`mision`
 *  for `mission`) — both collapse to the same comparison. */
function nearestField(name: string, candidates: readonly string[]): string | undefined {
  const target = name.replace(FIELD_NAME_SEPARATORS, '').toLowerCase();
  let nearest: string | undefined;
  let shortest = MAX_FIELD_EDIT_DISTANCE + 1;
  for (const candidate of candidates) {
    const collapsed = candidate.replace(FIELD_NAME_SEPARATORS, '').toLowerCase();
    const distance = editDistance(target, collapsed, MAX_FIELD_EDIT_DISTANCE);
    if (distance >= shortest) continue;
    nearest = candidate;
    shortest = distance;
    if (distance === 0) break;
  }
  return nearest;
}

/** An input's own field names, with nothing asserted about its values: a
 *  primitive the model sent where an object belongs yields none, and the schema
 *  behind this is what reports what it actually is. */
const FieldNamesSchema = v.record(v.string(), v.unknown());

function fieldNames<T>(value: T): readonly string[] {
  const parsed = v.safeParse(FieldNamesSchema, value);
  return parsed.success ? Object.keys(parsed.output) : [];
}

/** Said once, after the specifics: WHY a name mistake is an error now. */
const FIELD_RULE = 'A field the called action cannot act on is refused rather than dropped — a cap'
  + ' that never reached the run is a cap that was never applied.';

function takesSentence(action: AgentsToolAction): string {
  return `action "${action}" takes: ${fieldsOf(action).join(', ')}.`;
}

/**
 * What is wrong with the field NAMES of `input`, or undefined when nothing is.
 *
 * Runs ahead of the schema so a name mistake gets a message naming the field that
 * was MEANT — `explainNativeToolReferenceError`'s job at the other end of the
 * same call: the caller is a model, and an error it cannot act on is a silent
 * drop with extra steps. The strict schemas behind it still refuse anything this
 * misses, so the refusal never depends on this being exhaustive.
 *
 * Two kinds, one message. An UNKNOWN field is a name this surface does not have.
 * A MISPLACED one is a real field the called action's handler never reads:
 * `budget_usd` on `hire` parsed cleanly and was then ignored, which is the same
 * silence the strict object closes, one layer in.
 */
function agentsFieldRefusal<T>(input: T): string | undefined {
  const parsed = v.safeParse(FieldNamesSchema, input);
  if (!parsed.success) return undefined;
  const declared = v.safeParse(v.picklist(AGENTS_TOOL_ACTIONS), parsed.output['action']);
  const action = declared.success ? declared.output : undefined;
  const problems: string[] = [];
  // Printed ONCE at the end rather than after every clause: four unknown fields
  // used to repeat the same ten-name list four times, which buries the one line
  // that says which field was wrong.
  let listFields = false;
  for (const field of Object.keys(parsed.output)) {
    if (field === 'action') continue;
    if (Object.hasOwn(AgentsInputEntries, field)) {
      if (action && !actionReads(action, field)) {
        const readers = AGENTS_TOOL_ACTIONS.filter((other) => actionReads(other, field));
        problems.push(`field "${field}" does not apply to action "${action}" — it is read by`
          + ` ${readers.join('/')}, and ${action} would ignore it.`);
        listFields = true;
      }
      continue;
    }
    const meant = nearestField(field, action ? fieldsOf(action) : AGENTS_INPUT_FIELDS);
    if (meant) {
      problems.push(`unknown field "${field}" — did you mean "${meant}"?`);
      continue;
    }
    const elsewhere = action ? nearestField(field, AGENTS_INPUT_FIELDS) : undefined;
    problems.push(elsewhere
      ? `unknown field "${field}" — "${elsewhere}" is read by`
        + ` ${AGENTS_TOOL_ACTIONS.filter((other) => actionReads(other, elsewhere)).join('/')},`
        + ` not ${action ?? 'this action'}.`
      : `unknown field "${field}".`);
    listFields = true;
  }
  if (problems.length === 0) return undefined;
  const fields = listFields
    ? action ? ` ${takesSentence(action)}` : ` Fields are: ${AGENTS_INPUT_FIELDS.join(', ')}.`
    : '';
  return `${problems.join(' ')}${fields} ${FIELD_RULE}`;
}

/**
 * The one parse, for both surfaces that can dispatch a delegation: the `agents`
 * tool's own execute and the `agents.*` codemode namespace. Throws a message the
 * caller can correct itself from.
 */
export function parseAgentsToolInput<T>(input: T): AgentsToolInput {
  const refusal = agentsFieldRefusal(input);
  if (refusal) throw new Error(refusal);
  return v.parse(AgentsToolInputSchema, input);
}

/** A durable job row, at the width the replay parse reads it. */
type StoredAgentsRow = v.InferOutput<typeof StoredAgentsInputSchema>;

/** The pre-unification tool's row, at the width the translation reads. Its other
 *  fields are deliberately not parsed: nothing on this surface can carry them, so
 *  they reach the drop line off the RAW row like every other uncarried field. */
const LegacyThinkRowSchema = v.object({ task: v.string() });

/** What a TRANSLATED row must not carry, because the translation decides it: the
 *  `preset` is fixed to `ideate` below, and an `objective` cannot ride a row that
 *  declared no metric, no unit, no direction and no verifier. */
const TRANSLATION_DECIDES = { preset: true, objective: true } satisfies Record<string, true>;

/** The `swarm` fields a stored row actually held — derived from the action's own
 *  field list rather than a second list beside it, so a field that joins `swarm`
 *  later carries on a re-drive without this function being touched. */
function swarmFieldsOf(row: StoredAgentsRow, skip: Record<string, true>): Partial<AgentsToolInput> {
  const carried: Partial<AgentsToolInput> = {};
  for (const field of AGENTS_ACTION_FIELDS.swarm) {
    if (Object.hasOwn(skip, field)) continue;
    const value = row[field];
    if (value !== undefined) Object.assign(carried, { [field]: value });
  }
  return carried;
}

/** Absent from the re-drive, and present in the record of why. Named rather than
 *  counted: a resumed search that lost a cap is only diagnosable if the line says
 *  which cap. `extra` is what no field name covers — the row's SETTLEMENT, which a
 *  swarm has no equivalent of, so a translated re-drive returns its candidates
 *  unranked and unsynthesised and says so. */
function recordDroppedFields<T>(
  kind: string,
  input: T,
  resumed: AgentsToolInput,
  extra: readonly string[],
): void {
  const carried = new Set(Object.keys(resumed));
  const dropped = fieldNames(input).filter((field) => !carried.has(field));
  if (dropped.length === 0 && extra.length === 0) return;
  diagnostics.event('agents.resume.fields_dropped', {
    kind,
    fields: [...dropped, ...extra].join(','),
    count: dropped.length + extra.length,
  });
}

/**
 * A stored row from a surface that no longer exists, re-driven as the one thing that
 * runs ephemeral nodes today.
 *
 * `preset:'ideate'` and not a measured preset, because the row has no `objective` and
 * none can be invented for it: `optimise` would need a metric, a unit, a direction and
 * a verifier the original call never supplied. `ideate` is the shape that needs none —
 * it writes its own competing approaches from `task` alone.
 *
 * The SETTLEMENT is the loss and it is a real one: the merge that reconciled a fork's
 * findings, and the judged ensemble that ordered a settle's, are both deliberately
 * unreachable from a swarm. So the re-drive hands back candidates nothing combined,
 * and the drop line says that rather than only counting fields — a resumed search that
 * quietly stopped settling is worse than one that refused.
 */
function searchReplay<T>(kind: string, input: T, task: string | undefined, carry: Partial<AgentsToolInput>): AgentsToolInput | null {
  if (task === undefined) return null;
  const resumed: AgentsToolInput = { ...carry, action: 'swarm', preset: 'ideate', task };
  recordDroppedFields(kind, input, resumed, ['settlement']);
  return resumed;
}

/**
 * Background-job resume filter, shared by both backends: durable job rows store the
 * tool KIND + input, and only exploration work is safely re-runnable. Returns the
 * input to re-execute, or null when the job is not resumable.
 *
 * It is ALSO the DETACH gate (orchestrator/background-tools.ts): the same narrowing
 * decides which live `agents` call may background in the first place, because a call
 * that could not be re-driven after an eviction must never be detached into a job.
 * One predicate at both ends — a detachable call with no resume is how work is lost.
 *
 * Rows are TRANSLATED rather than validated as a model call would be. A row was
 * recorded verbatim from whatever the model sent (jobs/runner.ts stores the raw
 * input), so a row written before today's surface can carry fields it now refuses
 * and can name an ACTION it no longer has — and a row is re-driven, not answered, so
 * a refusal there is work lost to a spelling nobody can correct any more. A stored
 * row is history, not a prompt.
 *
 * WHAT TRANSLATES, and every translation names what it could not carry:
 *
 *   `action:'fork'` — the removed ephemeral rung. Its caller supplied the angles
 *   itself and a merge model synthesised what came back. A search is what spawns
 *   ephemeral tool-using nodes now, so the row re-drives as one; the briefs and the
 *   merge are the loss, and the drop line names them.
 *
 *   `settle` — an older row still, from when a judged tree was reachable from inside
 *   that rung. Same translation: the field is not an entry any more, so it arrives as
 *   an unknown key and is named in the same line.
 *
 *   `kind:'think'` — rows written by the pre-unification tool, whose `heads` are the
 *   same briefs and whose `strategy` named the engine directly.
 */
export function resumableAgentsInput<T>(kind: string, input: T): AgentsToolInput | null {
  if (kind === 'agents') {
    const parsed = v.safeParse(StoredAgentsInputSchema, input);
    if (!parsed.success) return null;
    const row = parsed.output;
    if (row.action === 'fork') {
      return searchReplay(kind, input, row.task, swarmFieldsOf(row, TRANSLATION_DECIDES));
    }
    if (row.action !== 'swarm') return null;
    const resumed: AgentsToolInput = { action: 'swarm', ...swarmFieldsOf(row, {}) };
    recordDroppedFields(kind, input, resumed, []);
    return resumed;
  }
  if (kind !== 'think') return null;
  const parsed = v.safeParse(LegacyThinkRowSchema, input);
  if (!parsed.success) return null;
  return searchReplay(kind, input, parsed.output.task, {});
}

interface AgentsToolCallOptions {
  abortSignal?: AbortSignal;
}

function readAbortSignal(options: AgentsToolCallOptions | undefined): AbortSignal | undefined {
  return options?.abortSignal;
}

// ── Dispatch helpers ────────────────────────────────────────────────────────

/**
 * A delegation refusal, reason FIRST — the shape and the vocabulary the `file`
 * tool's refusals already carry (tools/file-tool.ts). `bad_input` is that
 * vocabulary's "the arguments do not describe an operation", which is exactly what
 * a call with the wrong argument shape is, and it is what makes the refusal land in
 * `refused` rather than indicting the tool in `broke` when the ledger is read
 * back (read-models/tool-failures.ts). A bare `{error}` envelope classified as
 * `returned_error`: a correct refusal counted as a defect.
 */
interface BadInputRefusal {
  reason: 'bad_input';
  error: string;
}

function badInput(error: string): BadInputRefusal {
  return { reason: 'bad_input', error };
}


/**
 * The mission scope this call runs under: the caller's, narrowed to a fresh child
 * label when the call declared its own cap. Returns null when there is no governor
 * or no scope at all — the uncapped default, where nothing below this point does
 * any budget work.
 *
 * The PORT comes back with the governor rather than being assembled at each use,
 * because that is what the search charges through: an in-process port is the
 * governor, and building one per call site is how two call sites come to charge
 * different labels.
 */
function missionScope(
  budget: MissionGovernor | undefined,
  input: AgentsToolInput,
): { governor: MissionGovernor; scope: MissionScope } | null {
  if (!budget) return null;
  const limits = readMissionLimits(input);
  /** The caller's own scope, or the fresh child label this call declared a cap on. */
  let labels: readonly string[] = budget.scope;
  if (limits) {
    const label = input.budget_label?.trim() || `swarm-${nanoid()}`;
    budget.declare(label, limits);
    labels = [label];
  }
  const scope = localMissionScope(budget, labels);
  return scope ? { governor: budget, scope } : null;
}


/**
 * One `agents.swarm` call: resolve it, check it, run it — in that order, because each
 * step is the input to the next and the last one is the only one that spends anything.
 *
 * The three refusals are three DIFFERENT things and the vocabulary keeps them apart:
 * `bad_input` is a call that does not describe a legal search, `unsupported` is a legal
 * search this tree has no engine for, and `unavailable` is a legal search whose
 * instrument is missing from this actor. Collapsing them would put "you asked wrongly"
 * and "we cannot do that yet" in one bucket, which is the distinction a caller needs
 * most: only one of the three is worth correcting.
 *
 * WHY THIS READS THE CAPS. Under *Presets* the mission caps live on this input
 * rather than being duplicated onto `SwarmInput`, so a search nests under the
 * caller's mission scope through the seam every spawn uses — `missionScope` reads
 * `budget_usd` / `budget_tokens` / `budget_label`.
 *
 * WHAT CHARGES WHAT, because two paths reach one ledger and the pair has to be read
 * together. The governed `LLM` charges what THIS process sends through the `LLM`
 * primitive: a judged run's ensemble, estimated from characters. The PORT charges the
 * run's own model calls, per call, from the provider's own report — every swarm node's
 * every step, and a toolless node's one generation. The two sets are disjoint by
 * construction, and `report.tokens` is the second of them, which is why this seam
 * records the spawn and charges no tokens of its own.
 */
/**
 * Role / tier precedence for one delegation, through the ONE resolver.
 *
 *   role:   explicit input -> the caller's own active role.
 *   tier:   explicit input -> the role's default -> `default` (resolver).
 *   preset: explicit input -> the role's default preset (the swarm arm).
 *
 * An explicit role must be one the caller's own role may spawn (`spawns`:
 * absent inherits everything, exactly as an absent `allowedTools` does;
 * a list allows exactly those roles).
 * The resolver then produces the frozen profile the delegation runs under,
 * and its tier source is carried through as provenance verbatim.
 *
 * Returns `{ error }` — a refusal VALUE in bad_input's vocabulary, never a
 * throw — because every caller here answers the model.
 */
function resolveDelegatedProfile(
  ctx: AgentsProfileContext,
  role: RoleId | undefined,
  tier: TierId | undefined,
  presetSource: ProfileProvenance['presetSource'] = 'role_default',
): DelegatedProfile | { error: string } {
  const roles = effectiveRoleCatalog(ctx.envelope.catalog);
  const callerRole = roles[ctx.roleId];
  if (!callerRole) {
    return { error: `unknown active role ${JSON.stringify(ctx.roleId)} — it is not in this `
      + 'account\'s catalog; ask the owner to fix the catalog or pick an explicit role.' };
  }

  const spawns = callerRole.spawns;
  // Absent inherits EVERYTHING, the same narrowing rule as allowedTools.
  // A list allows exactly those roles; '*' is the explicit wildcard. A caller
  // may always delegate under its own role.
  if (role !== undefined && role !== ctx.roleId
    && spawns !== undefined && spawns !== '*'
    && !spawns.includes(role)) {
    return { error: `role ${JSON.stringify(role)} is not one your role may delegate to — `
      + `allowed: ${spawns.length > 0 ? spawns.join(', ') : '(none)'}.` };
  }


  try {
    const resolved = resolveTurnProfile({
      envelope: ctx.envelope,
      provider: ctx.provider,
      roleId: role ?? ctx.roleId,
      explicitTier: tier,
      workMode: 'build',
      availableTools: ctx.availableTools,
      activeSkills: [],
    });
    return {
      resolved,
      sources: {
        roleSource: role !== undefined ? 'explicit' : 'caller',
        tierSource: resolved.tier.source,
        presetSource,
      },
    };
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

async function runSwarmAction(
  deps: AgentsToolDeps,
  input: AgentsToolInput,
  mode: WorkMode,
  toolOptions: AgentsToolCallOptions | undefined,
  budget?: MissionGovernor,
): Promise<object> {
  const fork = deps.fork!;
  // THIS CALL IS A RE-DRIVE, or it is not — and the distinction decides where
  // the profile comes from BEFORE anything resolves: a re-drive replays a
  // stored snapshot verbatim and never consults today's catalog, so a catalog
  // edit cannot reach an in-flight tree mid-flight. Read off the options bag
  // for the reason `RESUME_REDRIVE_OPTION` states: the input IS the durable
  // row, and nothing in it could distinguish the two.
  const redrive = readResumeRedrive(toolOptions);
  if (!redrive && !input.preset && !deps.profile) {
    return badInput(`swarm needs \`preset\` — the shape of the search${deps.profile ? '' : ' (no role catalog is wired here to take its default from)'}. ${SWARM_PRESET_DOCTRINE.join(' ')}`);
  }
  if (!input.task) {
    return badInput('swarm needs `task` — what the search is for, in prose. The measured '
      + 'quantity goes in `objective`, never here.');
  }

  // ROLE / TIER / PRESET PRECEDENCE, resolved through the one resolver. A
  // re-drive skips this entirely — its snapshot comes back off the claimed
  // ledger row inside runSwarm — so the provenance below describes a FIRST
  // attempt only.
  let delegated: DelegatedProfile | undefined;
  if (!redrive) {
    const ctx = deps.profile?.();
    if (ctx) {
      const resolution = resolveDelegatedProfile(
        ctx,
        input.role,
        input.tier,
        input.preset === undefined ? 'role_default' : 'explicit',
      );
      if ('error' in resolution) return badInput(resolution.error);
      delegated = resolution;
    } else if (input.role !== undefined || input.tier !== undefined) {
      return badInput('role and tier need a profile catalog, which this actor does not have — '
        + 'call again without them.');
    }
    // Explicit preset wins; a wired catalog fills the gap from the role's own
    // default; neither means the refusal above already fired.
  }
  // A RE-DRIVE WITH NO PRESET IS NOT AN `ideate`. The durable row holds the raw
  // tool input, so a first attempt that took its preset from its role's default
  // stored none — and the fallback at the end of this expression would re-enter
  // an audit's own tree, at its own root id and claimed epoch, under a
  // different search's branches, depth, carry and settle. So the preset comes
  // off the SAME record the role, tier and model do: read here, before the axes
  // resolve, because `resolveSwarm` needs it and the claim happens later.
  const started = redrive && input.preset === undefined
    ? readStartedSwarmProfile(fork.rt.storage, input.task)
    : null;
  const preset: SwarmPreset = input.preset
    ?? delegated?.resolved.defaultPreset
    ?? started?.profile.defaultPreset
    ?? 'ideate';

  // One typed literal, not an Object.assign chain: every field is checked
  // against SwarmInput where the assign form checked nothing, and every
  // field is SUPPLIED where a conditional spread reads as absent.
  const call: SwarmInput = {
    preset,
    task: input.task,
    objective: input.objective,
    key: input.key,
    config: input.config,
    from: input.from,
    label: input.label,
    branches: input.branches,
    depth: input.depth,
    name: input.name,
    nodes: input.nodes,
  };

  // Resolution first, per *Presets* — *Validity over the resolved configuration* is
  // stated over the resolved tuple and has no input without it.
  const resolved = resolveSwarm(call);
  if ('reason' in resolved) return resolved;
  // Legality, per *Validity over the resolved configuration*: over the resolved
  // tuple and never over the preset name.
  const illegal = swarmValidity(resolved);
  if (illegal) return illegal;

  // The mission scope, and with it both enforcement seams: the governed `LLM` for the
  // measurement calls this process makes, and the PORT the run charges its own model
  // calls through as it makes them.
  const mission = missionScope(budget, input);
  let rt: AgentRuntime = fork.rt;
  if (mission) {
    rt = { ...fork.rt, llm: mission.governor.govern(fork.rt.llm, mission.scope.labels) };
  }
  const runDeps: SwarmRunDeps = { rt, model: fork.model, mode };
  const origin = fork.originContext?.();
  if (origin !== undefined) {
    Object.assign(runDeps, {
      originContext: Object.freeze(structuredClone([...origin])),
    });
  }
  // THE TIER'S OWN MODEL. Forwarded, never pre-resolved here: a re-drive's
  // profile comes off the claimed ledger row INSIDE the runner, so the runner
  // is the only place that can see both cases, and resolving one of them here
  // would leave the other running today's model under yesterday's record.
  if (fork.resolveModel) Object.assign(runDeps, { resolveModel: fork.resolveModel });
  // THE SNAPSHOT. A first attempt carries the resolved precedence record down
  // to the runner, which writes it into the run's own ledger row BEFORE any
  // node expands — the moment a durable detach could happen — so a re-drive
  // re-enters under the profile it started under rather than today's catalog.
  if (delegated) Object.assign(runDeps, {
    profile: { profile: delegated.resolved, sources: delegated.sources },
  });
  // THE SEARCH CHARGES ITS OWN CALLS. Wired here, an exhausted label stops the next
  // level from opening and stops an agent swarm node between its steps, so a cap the
  // caller set is enforced while the money is still there to save.
  if (mission) Object.assign(runDeps, { mission: mission.scope });
  const signal = readAbortSignal(toolOptions);
  if (signal) Object.assign(runDeps, { signal });
  // Resolved here rather than at wiring time, so a backend that cannot build a
  // host yet refuses where the refusal is reportable. Assigned only when there is
  // one: an absent key is what runs the loop in this isolate.
  const host = fork.nodeHost?.();
  if (host) Object.assign(runDeps, { host });
  // The transient frames an IN-ISOLATE node publishes. Only wired when this
  // isolate is also the one holding the socket, which is exactly the case a
  // hosted node's own facet-to-parent RPC covers instead.
  const reportNodeDelta = host ? undefined : fork.reportNodeDelta?.();
  if (reportNodeDelta) Object.assign(runDeps, { publishHeadStream: reportNodeDelta });
  // A host constructs the provisioner around its authoritative filesystem. It
  // may be an in-isolate SqliteVFS or the hosted Nimbus session; the node loop
  // sees the same async contract either way.
  const provisionNodeHome = fork.provisionNodeHome?.();
  if (provisionNodeHome) Object.assign(runDeps, { provisionHome: provisionNodeHome });
  // And the runtime the node's loop uses once it has that home. Wired only
  // beside the provisioner, because re-credentialing a runtime with no
  // credential to use is nothing.
  const runtimeForNodeWorkspace = provisionNodeHome ? fork.runtimeForNodeWorkspace?.() : undefined;
  if (runtimeForNodeWorkspace) Object.assign(runDeps, { runtimeForWorkspace: runtimeForNodeWorkspace });
  // The *Inherited context* barrier: the backend's real compaction ladder, handed to the
  // run so a fork parent past the threshold is rewritten once instead of inherited
  // verbatim until the provider refuses. Absent stays absent — the seam's documented
  // loud failure rather than a silent stub.
  if (fork.compactShared) Object.assign(runDeps, { compactShared: fork.compactShared });
  readSpawnStarted(toolOptions)?.();
  // Only a re-drive re-enters an interrupted search; the flag was read at the
  // top of this action, where it also decides where the profile comes from.
  if (redrive) Object.assign(runDeps, { redrive: true });
  const result = await runSwarm(runDeps, resolved);
  if ('reason' in result) return result;
  // THE SPAWN, AND ONLY THE SPAWN. The tokens are already on the ledger: every model
  // call the run made debited as it happened, through `SwarmRunDeps.mission` above, and
  // `report.tokens` is the sum of exactly those calls. Charging it again here would
  // bill the caller twice for one search — and a silent double bill looks exactly like
  // the cap working, which is why it has to be structurally impossible rather than
  // merely fixed. `debit` writes the row for a spawn with no tokens, so this records
  // the search happened without claiming it was free.
  mission?.governor.debit(0, { labels: mission.scope.labels, spawns: 1 });
  const output: JsonObject = parseJsonObject(JSON.stringify(result));
  if (mission) {
    const label = mission.scope.labels[0];
    const snapshot = label !== undefined ? mission.governor.snapshot(label)[0] : undefined;
    if (snapshot) {
      Object.assign(output, { mission_budget: parseJsonObject(JSON.stringify(snapshot)) });
    }
  }
  return output;
}

// ── Schema assembly ─────────────────────────────────────────────────────────

/** The JSON-Schema properties an action's fields may be advertised under,
 *  DERIVED from AGENTS_ACTION_FIELDS rather than restated beside it: a property
 *  shown to the model that no action's handler reads does not compile. That is
 *  the advertised-vs-parsed half of the same relation `gate:agents-fields`
 *  checks from the declaration side. */
type SchemaPropertiesFor<Action extends AgentsToolAction> =
  { [Field in (typeof AGENTS_ACTION_FIELDS)[Action][number]]?: JsonObject };

/**
 * What a swarm call is advertised as taking.
 *
 * Gated on the exploration substrate, because the action is in the enum exactly when
 * that substrate is wired, so a property described here cannot be shown for an action
 * that is not offered.
 *
 * The descriptions carry the SHAPE and not only the meaning — `objective` is nested
 * three deep and `verify` is the field a model reaches for with a script path, twice
 * measured, unprompted — because a field description is read at the moment the field
 * is filled, which is where a schema beats an example.
 */
type SwarmSchemaProperties = SchemaPropertiesFor<'swarm'>;

/**
 * The catalog's roles, projected as one bounded line each — the discovery half
 * of "hire/swarm with a role": a model cannot pick a role it was never shown.
 * Rendered into the `role` field descriptions of both the native schema and
 * the codemode declaration, from the same context, so neither can list a role
 * the resolver would refuse. Absent (no catalog wired) is an empty string —
 * the legacy freeform wording covers that actor.
 */
function roleSummaries(deps: AgentsToolDeps): string {
  const ctx = deps.profile?.();
  if (!ctx) return '';
  const roles = effectiveRoleCatalog(ctx.envelope.catalog);
  const callerSpawns = roles[ctx.roleId]?.spawns;
  const allowed = (id: string): boolean => {
    if (ctx.roleId === id) return true;
    if (callerSpawns === undefined || callerSpawns === '*') return true;
    return callerSpawns.includes(id);
  };
  return Object.entries(roles)
    .filter(([id]) => allowed(id))
    .map(([id, role]) => {
      const label = role.label ?? deriveRoleLabel(id);
      return `${id} (${label}, preset ${role.preset}): ${role.description}`;
    })
    .join('; ');
}

function roleSummaryText(deps: AgentsToolDeps): string {
  const summaries = roleSummaries(deps);
  return summaries ? ` Available roles: ${summaries}.` : '';
}

/**
 * The registered instruments, each with what it measures and every key its `spec`
 * needs — rendered from `VERIFIER_KIND_DOC` so the schema cannot advertise a shape
 * `swarmValidity` would refuse, and cannot omit a field the caller then discovers one
 * round trip at a time.
 *
 * Printing the field list HERE is the cheaper half of the same fix the refusals carry:
 * a field description is read at the moment the field is filled, so a caller that sees
 * the whole spec while typing it never reaches the refusal at all.
 */
function verifierKindSummary(): string {
  return VERIFIER_KINDS
    .map((kind) => {
      const doc = VERIFIER_KIND_DOC[kind];
      return `${kind} — ${doc.summary}; its spec needs {${doc.specFields.join(', ')}}`;
    })
    .join('. ');
}

function swarmProperties(deps: AgentsToolDeps): SwarmSchemaProperties {
  if (!deps.fork) return {};
  return {
    // Carries the batch-level role the `context` slot of oh-my-pi (can1357/oh-my-pi,
    // the hard fork — upstream pi has no sub-agents at all) has: the shared background
    // every candidate is read against, stated ONCE rather than copied per candidate.
    // The wording has to carry both that and the goal, which is why the inheritance
    // sentence rides it from DELEGATION_INHERITANCE.swarm.brief — the same per-action
    // source the rung composes, so the field and the rung cannot come to disagree
    // about what a node can see.
    task: { type: 'string', description: `For action=swarm: what the search is for, in prose — never the measured quantity, which belongs in \`objective\`. ${DELEGATION_INHERITANCE.swarm.brief}` },
    preset: {
      type: 'string',
      enum: [...SWARM_PRESETS],
      description: `For action=swarm: the shape of the search. ${SWARM_PRESET_DOCTRINE.join(' ')}`,
    },
    objective: {
      type: 'object',
      description: 'For action=swarm: OPTIONAL, and the upgrade from a judged sweep to a MEASURED search — omit it and the preset runs its own judged sweep, which is already a complete call. Supply it as {kind:"scalar", metric, unit, direction:"minimise"|"maximise", scale:"linear"|"log", target, verify:{kind, spec}} with an optional floor:{value, kind:"certificate", proof, best_known_honest}. verify names a REGISTERED instrument and hands it its WHOLE spec in ONE call — the fields are checked together, so sending them one at a time costs a round trip each. '
        + `Registered: ${verifierKindSummary()}. `
        + 'A metric nothing can execute is not an objective, and a script path invented here is refused rather than run — if the thing you want cannot be measured by running code, leave this out. kind:"witness" is a checkable certificate and needs a scalar `proxy` to be searchable. kind:"instanced" and kind:"vector" declare a FRONT and run only with advance:"pareto": instanced measures ONE metric on every declared instance (at least two, {kind:"instanced", metric, unit, direction, scale, target, instances}); vector measures at least two scalar components that each keep their own metric/unit/direction ({kind:"vector", components:[...]}). Every declared axis must come back finite from the verifier or the run refuses, and expand:"aggregate" is refused with pareto because a merged node has no scalar re-grade. Field names are snake_case, like every field on this tool.',
    },
    key: { type: 'string', description: 'For action=swarm with advance:"archive": the coverage descriptor elites are binned into, required there and refused under every other advance. It must name a quantity the objective\'s own verifier REPORTS beside its value, because the cell a candidate lands in is witnessed by the measurement rather than claimed by the candidate — a key naming nothing that instrument reports is refused before any candidate is expanded, and a key that can only say "distinct idea" means the task wants preset:"ideate".' },
    config: { type: 'object', description: 'For action=swarm with preset:"custom" only: the axes — unit, context, expand, score, advance, carry — as the OVERRIDE on `from`\'s shape, or all six when there is no `from`. Prohibited on a named preset, which is a tested path and cannot be refused.' },
    from: {
      type: 'string',
      enum: [...NAMED_SWARM_PRESETS],
      description: 'For action=swarm with preset:"custom": a named preset to start from, so you state only what differs. It does NOT make this a preset run — the record still says custom, which is the point of having both fields.',
    },
    label: { type: 'string', maxLength: 120, description: 'For action=swarm with preset:"custom": required provenance. A composed shape recorded repeatedly under one label is the evidence for a new preset.' },
    name: { type: 'string', maxLength: 60, description: 'For action=swarm: a SHORT name for this search — two to four words, what you would call it in a sentence ("repo audit", "coupon 500 hunt"). It is what the exploration surface labels the tree and its row with, so a reader tells two searches apart without reading either task. Omit and the surface derives one from `task`, which is a paragraph and reads like one.' },
    branches: { type: 'integer', minimum: 1, description: 'For action=swarm: candidates per expansion, when you want the engine to vary the angle for you. Omit to take the preset\'s own width. Mutually exclusive with `nodes`.' },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', minLength: 1, description: 'What THIS node is asked — its own question, distinct from every other node\'s.' },
          prompt: { type: 'string', minLength: 1, description: 'The brief THIS node works under: the angle, the constraint, what to start from.' },
        },
        required: ['task', 'prompt'],
      },
      description: 'For action=swarm: assign the first level node by node instead of giving a count. Its length IS the branch count, so do not send `branches` as well. Every `task` must be distinct — two nodes asked the same question pay twice for one answer. Use this when you know what each node should do; use `branches` when you want N takes on one task and will let the engine hand out distinct angles.',
    },
    depth: { type: 'integer', minimum: 1, description: 'For action=swarm: how deep the search may go. Omit to take the preset\'s own depth. depth:1 is one measured expansion; deeper selects down a tree with `advance`, scoring each node against your own `objective`. The literature runs 3-7 (ToT <=3, LATS 7, Koh 5). advance:"none" has no selection step, so it fixes depth at 1 and a deeper cap is refused rather than silently flattened.' },
    role: { type: 'string', description: `For action=swarm: the role every node runs under. Omit and the nodes ride your own active role. One swarm is role-homogeneous — there is no per-node role.${roleSummaryText(deps)}` },
    tier: { type: 'string', enum: [...TIER_IDS], description: 'For action=swarm: the inference tier the nodes run at — tiny|fast|default|slow|deep. Omit to take the role\'s default tier.' },
    budget_usd: { type: 'number', minimum: 0, description: 'For action=swarm: cumulative USD cap for the whole search, including its measurements. Omit for no cap.' },
    budget_tokens: { type: 'integer', minimum: 1, description: 'For action=swarm: cumulative token cap, same scope as budget_usd.' },
    budget_label: { type: 'string', maxLength: 120, description: 'For action=swarm: name the sub-ledger so several calls share one cumulative budget.' },
  };
}

type ConverseSchemaProperties = SchemaPropertiesFor<Exclude<AgentsToolAction, 'swarm'>>;

function converseProperties(deps: AgentsToolDeps): ConverseSchemaProperties {
  if (!deps.team && !deps.peers) return {};
  const askTargets = deps.team && deps.peers
    ? 'a subordinate here or a peer workspace agent (subordinate names win a collision)'
    : deps.team ? 'a subordinate' : 'a peer workspace agent';
  const properties: ConverseSchemaProperties = {
    agent: {
      type: 'string',
      description: `Agent name: ${askTargets}. Target for ask/send/dismiss; optional name for hire (auto-generated from the role when omitted) and detail filter for list.`
        + (deps.team?.temporary ? ' On ask it is EXCLUSIVE with `role`: name one or the other.' : ''),
    },
    // Says what a mission is FOR, because the hire rung's context fact makes it
    // load-bearing: this text plus a bounded digest of the caller's recent
    // messages is the subordinate's whole starting knowledge. The sentence is
    // DELEGATION_INHERITANCE.hire.brief — the fork brief's opposite, from the
    // same per-action source, so neither field can be handed the other's rule.
    mission: { type: 'string', maxLength: 20000, description: `For action=hire: the helper's mission — it seeds its identity and runs as its first turn. ${DELEGATION_INHERITANCE.hire.brief}` },
    message: {
      type: 'string', maxLength: 20000,
      description: 'The work or note for ask/send, the answer for reply, or the first delegated task for hire scope=workspace.',
    },
  };
  if (deps.peers) {
    Object.assign(properties, {
      scope: {
        type: 'string',
        enum: ['subordinate', 'workspace'],
        description: 'For action=hire: subordinate (default) hires into THIS workspace; workspace creates (or reuses by name) a specialist workspace of its own, sends `message` to it, and awaits the result.',
      },
      topic: { type: 'string', maxLength: 80, description: 'Optional short label for a peer ask/send (default "message").' },
      event_id: { type: 'string', description: 'For action=reply: the agent message event id you were given.' },
    });
  }
  if (deps.team) {
    const temporary = deps.team.temporary !== undefined;
    Object.assign(properties, {
      role: {
        type: 'string', maxLength: 64,
        description: (temporary
          ? 'The catalog role — for action=hire the role to hire, and for action=ask the role of a TEMPORARY agent created for that one question (exclusive with `agent`; it answers here, then is released). One of the ids listed below.'
          : 'For action=hire: the catalog role to hire — one of the ids listed below.')
          + roleSummaryText(deps),
      },
      tier: { type: 'string', enum: [...TIER_IDS], description: 'For action=hire: optional inference tier override — tiny|fast|default|slow|deep. Omit to take the role\'s default tier.' },
      deliverable: { type: 'string', maxLength: 2000, description: 'For ask to a subordinate: what the finished result should be (optional).' },
      deadline_hint: { type: 'string', maxLength: 200, description: 'For ask to a subordinate: optional urgency/deadline hint.' },
      keep_history: { type: 'boolean', description: 'For action=dismiss: keep the subordinate archived with its context (default true). Set false ONLY to permanently wipe its storage.' },
    });
    if (temporary) {
      Object.assign(properties, {
        context_ref: {
          type: 'array',
          items: { type: 'string' },
          description: 'For a role-targeted ask: workspace paths the temporary agent reads ITSELF. '
            + 'The bytes never enter your own window — name a spill file here instead of pasting it '
            + 'into `message`. An unresolvable path is refused by name.',
        },
      });
    }
  }
  return properties;
}

function agentsInputProperties(deps: AgentsToolDeps) {
  return {
    ...swarmProperties(deps),
    ...converseProperties(deps),
  };
}

/**
 * The peer topic an ask/send rides, or the refusal when the caller claimed the
 * transport's reserved one.
 *
 * Read inside the two arms that use it rather than once for all seven actions:
 * `topic` is a field of ask and send, and reading it for every action made it
 * read like a field of every action — the exact shape that lets a field be
 * accepted where nothing acts on it.
 */
function requestedTopic(input: AgentsToolInput): { topic: string } | BadInputRefusal {
  const topic = input.topic?.trim() || 'message';
  return topic === PEER_REPLY_TOPIC
    ? badInput(`topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes`)
    : { topic };
}

/**
 * The one delegation dispatch. Both surfaces that can delegate — the `agents`
 * tool the model calls directly, and the `agents.*` namespace its codemode
 * script calls — run this exact function over the exact same deps, so there is
 * no second spawn/join implementation to drift.
 *
 * The codemode caller hands over an object the sandbox built, with none of the
 * AI SDK's schema validation behind it, so every read of `input` happens inside
 * the try: a malformed field comes back as an inspectable error rather than
 * throwing into the model's script.
 *
 * `toolOptions` is the AI SDK tool-call options bag; only `abortSignal` is
 * read, for search cancellation and timer-less peer-wait cancellation.
 */
export async function dispatchAgentsAction(
  deps: AgentsToolDeps,
  input: AgentsToolInput,
  toolOptions?: AgentsToolCallOptions,
): Promise<object> {
  const actions = agentsActionsFor(deps);
  const mode = deps.mode;
  const team = deps.team;
  const peers = deps.peers;
  // No catch: a roster this cannot read is not a roster without this name. The
  // dispatch below already turns a throw into an inspectable `{ error }`, so the
  // failure reaches the caller instead of silently routing an assignment meant
  // for a subordinate down the peer path.
  const isSubordinate = async (name: string): Promise<boolean> => {
    if (!team) return false;
    return (await team.list()).some((entry) => entry.name === name);
  };

  // Structural absence answering for itself. An action this actor does not wire
  // is not in the enum, so reaching here means the model called for it anyway —
  // and `unsupported` is what that is: a well-formed call for a capability this
  // actor does not have (obs/error.ts). Classified rather than bare, because a
  // correct "not here, here is what is" counted as a tool DEFECT in the ledger
  // (read-models/tool-failures.ts), and this is the response an actor at the
  // delegation depth cap gets — the one place absence would otherwise be silent.
  if (!actions.includes(input.action)) {
    return {
      reason: 'unsupported',
      error: `action "${input.action}" is not available here. Available: ${actions.join(', ')}`,
    };
  }
  // The spawn seam. Launching a helper is what turns one exhausted run into
  // many, so the cap is checked before the launch — for every action that
  // creates or wakes an agent. `list`, `dismiss` and `reply` spend nothing and
  // stay available so a stopped run can still wind itself up.
  if (input.action === 'swarm' || input.action === 'hire'
    || input.action === 'ask' || input.action === 'send') {
    const refusal = deps.budget?.guard('spawn');
    if (refusal) return refusal;
  }
  // The DEPTH seam, and the second half of a containment that is already
  // structural: an actor at the cap is not wired `team` deps at all, so `hire`
  // is absent from its enum. This covers the one window build-time gating
  // cannot — a toolset is cached across turns and a subordinate's identity is
  // seeded after its facet is built, so a build that ran before the seed could
  // not have known the depth. Depth is fixed for an actor's whole life, so
  // reaching this is a stale build rather than a budget that ran out mid-turn.
  //
  // BOTH SPAWNING RUNGS, not just `hire`. A role-targeted `ask` births a child
  // through the identical substrate and therefore adds a level exactly as a hire
  // does — so a cap that covered only `hire` was a cap the other rung walked
  // straight past, one call per level, each spending real money. `ask` by NAME
  // is not a spawn and stays available: talking to an agent that already exists
  // adds no depth, and an actor at the cap still has to be able to use its team.
  // The guard lives INSIDE each spawning arm, on the same read that arm routes
  // on — the ask arm's `if (input.role)` IS its spawn predicate, so the seam
  // and the dispatcher can no longer disagree about what a spawn is (they once
  // did, on exactly `role: ''`, which the schema permits).
  const spawnDepthRefusal = () =>
    team && delegationExhausted(team.delegation) ? delegationDepthRefusal(team.delegation) : null;
  try {
    switch (input.action) {
      case 'swarm':
        return await runSwarmAction(deps, input, mode, toolOptions, deps.budget);

      case 'hire': {
        const hireDepth = spawnDepthRefusal();
        if (hireDepth) return hireDepth;
        if ((input.scope ?? 'subordinate') === 'workspace') {
          // Classified, not a bare `{error}`: this is the escape route the depth
          // cap closes — a fresh workspace is the root of its own tree with the
          // whole cap below it — so the one refusal that has to hold must land
          // in `refused` and not indict the tool in `broke`.
          if (!peers) {
            return {
              reason: 'denied',
              error: 'hire scope=workspace creates a whole workspace, which only the workspace orchestrator may do — '
                + 'hire a subordinate here instead (omit scope), or run a search.',
            } satisfies DelegationDepthRefusal;
          }
          if (input.role !== undefined) {
            return badInput('field "role" is not available for action "hire" on this actor');
          }
          if (input.tier !== undefined) {
            return badInput('field "tier" is not available for action "hire" on this actor');
          }
          if (!input.mission || !input.message) return badInput('hire scope=workspace requires mission and message');
          const request: Parameters<PeersToolDeps['spawnWorkspace']>[0] = {
            purpose: input.mission,
            message: input.message,
            mode,
          };
          if (input.agent) Object.assign(request, { name: input.agent });
          if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });
          return await peers.spawnWorkspace(request);
        }
        if (!team) {
          // Capability absence, and `denied` is what that is: the call is
          // well-formed and this actor does not wire the surface it needs.
          return {
            reason: 'denied',
            error: 'hiring subordinates is not available on this actor',
          } satisfies DelegationDepthRefusal;
        }
        if (!peers && input.scope !== undefined) {
          return badInput('field "scope" is not available for action "hire" on this actor');
        }
        if (input.message !== undefined) {
          return badInput('field "message" is not available for action "hire" on this actor');
        }
        if (!input.role || !input.mission) return badInput('hire requires role and mission');
        // The role is a CATALOG id here — validated, spawn-checked and carried
        // onto the subordinate's durable identity with its tier override.
        // Without a catalog the freeform text still hires (the legacy path),
        // so an actor that never wired a profile keeps working; one that has
        // one refuses an unresolvable role rather than seeding an identity the
        // child's next turn cannot resolve.
        let request: Parameters<TeamToolDeps['spawn']>[0];
        const ctx = deps.profile?.();
        if (ctx) {
          const delegated = resolveDelegatedProfile(ctx, input.role, input.tier);
          if ('error' in delegated) return badInput(delegated.error);
          // Only an EXPLICIT override rides along: a role's own default tier
          // is re-derived by the child at its next turn boundary from its
          // roleId, so storing it twice would be a second source of truth.
          const resolvedTier = input.tier !== undefined ? delegated.resolved.tier : undefined;
          request = {
            role: { kind: 'catalog', roleId: delegated.resolved.role.id },
            mission: input.mission,
            mode,
          };
          if (resolvedTier !== undefined) Object.assign(request, { tier: resolvedTier.id });
        } else {
          // No catalog wired: the freeform line hires as the labelled legacy
          // block, exactly as it did before roles existed.
          request = {
            role: { kind: 'legacy', text: input.role },
            mission: input.mission,
            mode,
          };
        }
        if (input.agent) Object.assign(request, { name: input.agent });
        return await team.spawn(request);
      }

      case 'ask': {
        // A role-targeted ask SPAWNS (see the rung note above the dispatch);
        // ask by name talks to an agent that exists and stays available at the cap.
        if (input.role) {
          const askDepth = spawnDepthRefusal();
          if (askDepth) return askDepth;
        }
        // The XOR, enforced where a caller can be told about it. The schema
        // states the two targets are exclusive (`AgentsActionInputVariant.excludes`);
        // the sandbox namespace has no schema at all, so this is the one place
        // both surfaces meet the rule.
        const temporary = team?.temporary;
        if (input.agent && input.role) {
          return badInput(
            'ask takes ONE target: `agent` to hand work to an agent that exists, or `role` to get a '
            + 'temporary agent for this question. Naming both leaves it undecided which lifetime you '
            + 'asked for, and they answer differently — an existing agent reports back later, a '
            + 'temporary one answers here.',
          );
        }
        if (input.role) {
          if (!input.message) return badInput('ask requires role and message');
          if (!temporary) {
            return {
              reason: 'denied',
              error: 'ask by `role` creates a temporary agent, which this actor has no substrate for — '
                + 'name an existing agent with `agent` instead (action:"list" shows the roster).',
            } satisfies DelegationDepthRefusal;
          }
          const ctx = deps.profile?.();
          // Same resolver, same precedence, same refusal as a hire: a role this
          // catalog cannot resolve is refused rather than seeded onto a child
          // whose first turn could not read it.
          let role: RoleSelection;
          if (ctx) {
            const delegated = resolveDelegatedProfile(ctx, input.role, undefined);
            if ('error' in delegated) return badInput(delegated.error);
            role = { kind: 'catalog', roleId: delegated.resolved.role.id };
          } else {
            role = { kind: 'legacy', text: input.role };
          }
          const request: TemporaryRunRequest = {
            role,
            roleLabel: input.role,
            task: input.message,
            mode,
          };
          if (input.context_ref && input.context_ref.length > 0) {
            Object.assign(request, { contextRefs: input.context_ref });
          }
          if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });
          return await temporary.run(request);
        }
        // The existing-agent target's refusal is UNCHANGED — same words, same
        // classification — because nothing about it changed. Only a caller that
        // named no target at all reads the two-target sentence.
        if (!input.agent || !input.message) {
          return badInput(temporary && !input.agent && !input.message
            ? 'ask requires a target and a message: `agent` for an agent that exists, or `role` for a temporary one.'
            : 'ask requires agent and message');
        }
        const asked = requestedTopic(input);
        if ('error' in asked) return asked;
        if (team && await isSubordinate(input.agent)) {
          const assignment: Parameters<TeamToolDeps['assign']>[0] = {
            name: input.agent,
            task: input.message,
            mode,
          };
          if (input.deliverable) Object.assign(assignment, { deliverable: input.deliverable });
          if (input.deadline_hint) Object.assign(assignment, { deadlineHint: input.deadline_hint });
          const handoff = await team.assign(assignment);
          return {
            status: 'working',
            agent: input.agent,
            ...renderHandoff(handoff),
            note: `${ASSIGN_NOTES[handoff.delivery]} The subordinate's report arrives as an event that wakes you, citing ${handoff.eventId}.`,
          };
        }
        if (peers) {
          const request: Parameters<PeersToolDeps['ask']>[0] = {
            agent: input.agent, topic: asked.topic, message: input.message, mode,
          };
          if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });
          return await peers.ask(request);
        }
        return badInput(`unknown agent "${input.agent}" — check the roster with action:"list"`);
      }

      case 'send': {
        if (!input.agent || !input.message) return badInput('send requires agent and message');
        const sent = requestedTopic(input);
        if ('error' in sent) return sent;
        if (team && await isSubordinate(input.agent)) {
          const handoff = await team.message({ name: input.agent, content: input.message, mode });
          // Same delivered/queued vocabulary the peer transport already uses:
          // delivered = it reached the target's context, queued = it waits
          // behind work already admitted.
          return {
            status: handoff.delivery === 'queued' ? 'queued' : 'delivered',
            agent: input.agent,
            ...renderHandoff(handoff),
          };
        }
        if (peers) {
          return await peers.send({ agent: input.agent, topic: sent.topic, message: input.message, mode });
        }
        return badInput(`unknown agent "${input.agent}" — check the roster with action:"list"`);
      }

      case 'reply':
        if (!peers) {
          return {
            reason: 'denied',
            error: 'reply needs the peer transport, which this actor does not have',
          } satisfies DelegationDepthRefusal;
        }
        if (!input.event_id || !input.message) return badInput('reply requires event_id and message');
        return await peers.reply({ eventId: input.event_id, message: input.message });

      case 'list': {
        // PROVENANCE, not addressing: `knows` includes archived rows, so the name
        // a released temporary agent reported still resolves to its record. The
        // ask/send arms keep routing on the ACTIVE roster (`isSubordinate`), so
        // nothing dismissed can be handed work.
        if (input.agent && team && await team.knows(input.agent)) {
          return await team.status({ name: input.agent });
        }
        // ONE roster read. A temporary agent appears here while it works,
        // under `lifetime:'task'` — an agent spending the owner's money right
        // now is a helper, and a roster that called itself empty while one ran
        // was the defect this rung had to not repeat.
        const subordinates = team ? await team.list() : undefined;
        const peerRoster = peers ? await peers.listPeers() : undefined;
        const empty = (subordinates?.length ?? 0) === 0 && (peerRoster?.length ?? 0) === 0;
        const roster: UnifiedRosterResult = {};
        if (subordinates) Object.assign(roster, { subordinates });
        if (peerRoster) Object.assign(roster, { peers: peerRoster });
        if (empty) Object.assign(roster, { note: 'No helper agents yet — create one with action:"hire".' });
        return roster;
      }

      case 'dismiss':
        if (!team) {
          return {
            reason: 'denied',
            error: 'dismiss applies to subordinates, which this actor does not have',
          } satisfies DelegationDepthRefusal;
        }
        if (!input.agent) return badInput('dismiss requires agent');
        return await team.dismiss({
          name: input.agent,
          keepHistory: input.keep_history ?? true,
        });
    }
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}

/** Build the `agents` tool for whatever deps this actor wires. At least one
 *  deps group must be present — callers gate on that, not this function. */
export function createAgentsTool(deps: AgentsToolDeps): ToolSet[string] {
  const actions = agentsActionsFor(deps);
  const team = deps.team;
  const peers = deps.peers;

  return tool({
    description: renderAgentsToolDescription(deps),
    inputSchema: jsonSchema<AgentsToolInput>({
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: [
            ...(deps.fork ? [
              // The line that says what this rung IS, on the field a model reads
              // FIRST. "Spawn several and pick the best" describes plenty of things;
              // the difference that matters is who decides, so it says so here.
              'swarm = run a configured search over ephemeral nodes of yourself — `preset` and `task` are the whole call, and naming an `objective` upgrades its judged sweep to a search measured by your own verifier.',
            ] : []),
            ...(team || peers ? [
              'hire = create a persistent named helper. ask = hand work to an agent and get the answer back'
              + (team?.temporary
                ? ' — `agent` for one that exists (it reports back later), or `role` for a temporary agent created for that one question, whose finished answer comes straight back here.'
                : '.')
              + ' send = fire-and-forget message. list = the unified roster.'
              // How much tree is left, stated the way head-tools states nesting
              // room ("You may nest N more level(s)") — the same fact from the
              // same kind of derived budget, so a caller near the cap can plan
              // around it instead of discovering it at a refusal. `maxDepth` is
              // the room below THIS actor, and the hire itself spends one of it.
              + (team
                ? team.delegation.maxDepth > 1
                  ? ` A subordinate you hire can hire its own, ${team.delegation.maxDepth - 1} level(s) further.`
                  : ' A subordinate you hire lands on the depth cap and cannot hire its own.'
                : ''),
            ] : []),
            ...(peers ? ['reply = answer an incoming agent message event.'] : []),
            ...(team ? ['dismiss = retire a subordinate (archived by default — its context is kept).'] : []),
          ].join(' '),
        },
        ...agentsInputProperties(deps),
      },
      oneOf: agentsJsonSchemaVariants(deps, actions),
      // No `additionalProperties: false` here, deliberately. The AI SDK
      // validates a tool call against this schema BEFORE `execute`, so the
      // declaration refusing unknown properties would replace the message below
      // with the SDK's generic "must NOT have additional properties" — a
      // refusal the model cannot correct itself from, which is most of what
      // this change is for. The parse in `execute` is the enforcement; this
      // schema is what the model is TOLD.
    }),
    execute: async (input: AgentsToolInput, toolOptions?: AgentsToolCallOptions) => {
      // The native surface parses too. Its inputs arrive schema-checked for
      // TYPES and never for names, which is how `budgetUsd` reached the
      // dispatcher and was read by nothing at all.
      let parsed: AgentsToolInput;
      try {
        parsed = parseAgentsToolInput(input);
      } catch (error) {
        // Reason FIRST, the vocabulary every refusal on this surface uses: a call
        // the parse refused is bad input, not a tool that broke.
        return { reason: 'bad_input', error: renderThrownChain({ cause: error }) };
      }
      return dispatchAgentsAction(deps, parsed, toolOptions);
    },
  });
}
