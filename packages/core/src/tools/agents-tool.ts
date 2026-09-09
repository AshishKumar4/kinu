/**
 * `agents` — the ONE delegation tool. Every helper an actor can spawn or talk
 * to lives behind a single surface where the KIND of helper is a parameter:
 *
 *   swarm   — a configured search over ephemeral nodes of the calling agent,
 *             each a full multi-step tool loop on the same workspace, whose
 *             candidates are MEASURED against the caller's own objective.
 *   hire    — ONE agent engaged on ONE workstream, and `lifetime` is the whole
 *             choice inside it. `durable` (the default) keeps its own context
 *             across turns and stays in the roster until dismissed; `task`
 *             creates a full agent for one question, waits for its single
 *             answer, returns it here, and archives the row — its transcript is
 *             kept. Naming an `agent` that already exists hands that agent the
 *             workstream instead of creating one, and its report arrives as an
 *             event that wakes you. scope=workspace creates a specialist peer
 *             workspace instead.
 *   msg     — say something to an agent WITHOUT handing it a workstream:
 *             `agent` names one, `event_id` answers an inbound agent message
 *             event. One or the other, never both.
 *   list    — the unified roster: subordinates, peer workspaces, and the
 *             task-lifetime agents running right now.
 *   dismiss — retire a subordinate (archived by default; context kept).
 *
 * The machinery underneath: swarm dispatches through `strategy/swarm-run.ts`,
 * whose nodes are real tool-using agents on the heads runtime; hire and msg
 * ride TeamToolDeps' facet substrate — a `lifetime:'task'` hire through the
 * very same `SubordinateRuntime`, which is why it is a REAL agent and not a
 * bare model call — and peer messaging rides PeersToolDeps' EventsHub
 * transport. Which actions exist is decided structurally by which deps the
 * backend wires — see agentsActionsFor.
 *
 * The swarm action's call contract is specified by docs/EXPLORATION.md — "Presets",
 * "Validity over the resolved configuration" and "Accepted and ignored".
 */
import { tool, jsonSchema } from 'ai';
import { currentWorkMode, inWorkMode, permitInPlan, workModeRefusal } from '../execution/work-mode';
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
import { SwarmConfigSchema, SwarmModelsSchema, SwarmNodeAssignmentsSchema, SwarmObjectiveSchema } from './swarm-input';
import { runSwarm, type SwarmRunDeps } from '../strategy/swarm-run';
import type { ActorReference } from '../state/actor-handle';
import type { SubordinateBirth } from '../subordinates/birth';
import type { PublishHeadStream } from '../heads/head-stream';
import type { AnnounceHeadActivity } from '../heads/live-journal';
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
  localMissionScope, readMissionLimits, MissionBudgetExhausted,
  type MissionGovernor, type MissionScope,
} from '../mission-budget';
import type { NodeIdentity, NodeWorkspace, NodeWorkspaceProvisioner } from '../strategy/node-workspace';
import type { HostedNodeSeat } from '../strategy/node-agent';
import type { AgentRuntime } from '../types/agent-runtime';
import type { CostModel } from '../mcts/cost';
import type { WorkMode } from '../prompting/surface';
import { nanoid } from '../utils/nanoid';
import { diagnostics, KinuError, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import {
  delegationDepthRefusal,
  delegationExhausted,
  type DelegationBudget,
} from '../subordinates/depth';
import {
  SUBORDINATE_LIFETIMES,
  type SubordinateLifetime,
  type TemporaryAgentPort,
  type TemporaryRunRequest,
} from '../subordinates/temporary';
import {
  parseJsonObject,
  type JsonObject,
  type JsonValue,
} from '../utils/json';

// ── Team (subordinate agents) deps contract ─────────────────────────────────
// The deps implementation rides the workspace's ONE actor host: spawn =
// `ActorHost.acquire` over a `workspace_actors` row + roster row, which binds
// the child's session and stores over the SAME workspace database rather than
// giving it one of its own; assign and message publish `subordinate_task` events
// into the subordinate's own actor-scoped EventLog (drained as its programmatic
// turn); reports come back as `subordinate_report` events on the parent.

export type SubordinateStatus = 'idle' | 'working' | 'awaiting_input' | 'dismissed';

/** One row of the actor_subordinates roster: lifecycle and task facts
 *  ONLY. The title and role a subordinate presents live in its own
 *  actor_config (subordinates/support.ts SubordinateDescriptorSource) — the
 *  parent never mirrors them. */
export interface SubordinateRosterEntry {
  name: string;
  actorReference: ActorReference | null;
  birth: SubordinateBirth | null;
  deleteRequested: boolean;
  createdBy: 'orchestrator' | 'user';
  status: SubordinateStatus;
  currentTask: string | null;
  createdAt: number;
  dismissedAt: number | null;
  /**
   * How long this helper is MEANT to live — the one fact a `lifetime:'task'` hire
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
  *  `role` is the catalog id, written to the child's own config store at seed time. */
  create(input: {
    name?: string;
    /** A title the owner typed. Given, the name is THEIRS: origin `user`,
     *  never auto-retitled. */
    displayName?: string;
    role?: RoleId;
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
    role: RoleId;
    mission: string;
    tier?: TierId;
    mode: WorkMode;
  }): Promise<{
    name: string; displayName: string;
  }>;
  /** Enqueue a task on the subordinate (drained as its next turn). */
  assign(input: { name: string; task: string; deliverable?: string; mode: WorkMode }): Promise<
    { ok: true; name: string } & SubordinateHandoff
  >;
  /**
   * Does this roster hold `name` AT ALL — including a row it has archived?
   *
   * Separate from {@link list} because the two questions differ on exactly the
   * rows that matter here. `list` is the WORKING SET, and hire/msg route on it:
   * a dismissed agent must not be handed new work. This is PROVENANCE, and
   * `list`'s answer was wrong for it — a released task-lifetime agent's own
   * result names it, and a `list` detail lookup on that name fell through to the
   * peer path and dead-ended. Archived rows are readable, never addressable.
   */
  knows(name: string): Promise<boolean>;
  /** Roster row and live state. Archived rows have no live state; retained
   * history is available through the separate owner inspection path. */
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
   * The `lifetime:'task'` half of `hire`: one full child agent, run to
   * completion inside the call, its single answer returned as the tool result,
   * and ARCHIVED in the roster above the moment it answers. It is a row in that
   * one roster while it works — the lifetime is a field on the row, never a
   * register of its own.
   *
   * OPTIONAL IN THE TYPE, REQUIRED IN EFFECT wherever a backend wires a child
   * substrate at all — the same shape {@link AgentsForkDeps.resolveModel}
   * carries. It is a port and not a deps GROUP because it is not a capability
   * an actor can hold independently: it rides this roster's own
   * `SubordinateRuntime`, so an actor with a roster has the substrate for it by
   * construction and one without has nothing to build it from. Unwired, `hire`
   * has no `lifetime` field at all — structurally, in the schema, in the sandbox
   * declaration and in the prompt — and every hire is durable.
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
 * `runSwarmAction` reads `rt`, `model`, `provisionNodeHome`,
 * `reportNodeDelta` and `compactShared`. The members exist because the
 * backends' one builder produces the whole bag, not because this module
 * dispatches a strategy.
 */
export interface AgentsForkDeps {
  /** The CALLER's runtime — the actor that invoked the fork. Not any node's. */
  rt: AgentRuntime;
  /**
   * Acquire the hosted logical actor ONE swarm node runs as, by that node's
   * identity. One call per node: each node is its own actor of this workspace,
   * over the one workspace database.
   */
  hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
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
  runtimeForNodeWorkspace?: () => (workspace: NodeWorkspace, identity: NodeIdentity) => Promise<AgentRuntime>;
  /**
   * Where a node's transient output frames go while a step is still being
   * produced — the backend's own broadcast channel, resolved per call for the
   * same reason {@link costModel} is.
   *
   * A node's loop runs in the isolate that ran the search, beside the socket,
   * so this is the whole of the channel rather than one transport's half.
   * Absent is a backend with nothing watching, and costs a node nothing — the
   * frames are superseded by its steps.
   */
  reportNodeDelta?: () => PublishHeadStream;
  /**
   * Where the run's DURABLE journal writes are announced — a node appearing, a
   * step landing, a report filing.
   *
   * The twin of {@link reportNodeDelta}: a node's journal rows are the PARENT's,
   * so the announcement belongs to the parent — and until it existed a live
   * search's own surface learned about a node on a poll clock.
   *
   * A factory for {@link costModel}'s reason. Absent is a backend with nothing
   * watching, and then the journal writes in silence.
   *
   * WIRED ON CF ONLY, beside {@link reportNodeDelta}, which is cf-only for the
   * same reason and is recorded in `scripts/capability-parity.lock.json` next to
   * this one: head liveness is a channel a surface has to CONSUME, and only the
   * browser client reads `head_activity`. The CLI has no reader, so wiring it
   * there would fan a channel out to nobody — a dead broadcast is the defect
   * `unit-broadcast-wiring.test.ts` exists to refuse, not parity.
   */
  announceHeadActivity?: () => AnnounceHeadActivity;
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
 * Absent means a role-targeted hire refuses and swarm needs an explicit preset.
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
   *  local catalog) after the toolset was built. Absent means a role-targeted
   *  hire refuses and swarm needs an explicit preset. */
  profile?: () => AgentsProfileContext | null;
}

interface UnifiedRosterResult {
  /** ONE roster. A `lifetime:'task'` hire is a row in it while it works; a
   *  released one is the archived row this same roster keeps, readable through
   *  `list` with an `agent` name. */
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
    msg: converse,
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
    ...(deps.team || deps.peers ? [DELEGATION_RUNGS.hire] : []),
    ...(deps.peers
      ? [DELEGATION_CONVERSE]
      : deps.team
        ? ['msg says something to a subordinate by name without handing it a workstream; list shows the roster.']
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
  /**
   * Per-node model routing: one spec per expansion child, round-robin by slot.
   * Omit and every node runs the one model the call resolved to (the tier's,
   * where a tier was named). Mutually exclusive with `tier` — see
   * {@link SwarmInput.models} for the assignment rule and the routing seam.
   */
  models?: readonly string[];
  /** The role a delegation runs under — the swarm's nodes, or the agent a hire
   *  creates at either lifetime. Explicit wins; omitted, a swarm rides the
   *  caller's own active role. One swarm is ROLE-HOMOGENEOUS — mixed-role
   *  candidates confound comparison, so there is one role per call, never a
   *  list. On `hire` it is the DISCRIMINANT: naming it is what asks for an agent
   *  that does not exist yet, and omitting it hands the workstream to `agent`. */
  role?: RoleId;
  /** The inference tier the delegation runs at: `tiny|fast|default|slow|deep`.
   *  Explicit wins; omitted resolves through the role's default tier, then
   *  `default`. The one RUN-LEVEL routing input: it names ONE model for the whole
   *  search, and `models` — per-node routing — is mutually exclusive with it. */
  tier?: TierId;
  // hire / converse
  agent?: string;
  mission?: string;
  scope?: 'subordinate' | 'workspace';
  message?: string;
  topic?: string;
  deliverable?: string;
  event_id?: string;
  keep_history?: boolean;
  /**
   * How long the hire lives — the whole difference between the two helpers this
   * action used to be two actions for.
   *
   * `durable` (the default) stays in the roster across turns and is dismissed
   * when its role is over. `task` is created for one question: the call waits
   * for its single answer, returns it here, and the row is archived. Both are
   * rows in the ONE roster, under the lifetime the row already carries.
   */
  lifetime?: SubordinateLifetime;
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
    'nodes', 'models',
    'role', 'tier',
    'budget_usd', 'budget_tokens', 'budget_label',
  ],
  // Two TARGETS, one action, and the lifetime is a FIELD rather than a second
  // verb. `role` asks for an agent that does not exist yet and `lifetime` says
  // how long it lives; `agent` names one that already does and hands it the
  // workstream. `lifetime` and `tier` belong to the first only — an agent that
  // exists already has both — and `deliverable`/`topic` to the second.
  // Ordered by VARIANT, created target first: the codemode declaration renders
  // one object per variant and the union of those objects is held to this list,
  // so the order here is the order a reader meets the fields in.
  hire: ['role', 'mission', 'agent', 'tier', 'lifetime', 'scope', 'message', 'deliverable', 'topic'],
  // ONE addressing action. `agent` names an agent, `event_id` names an inbound
  // question — the only thing `send` and `reply` ever differed on.
  msg: ['agent', 'event_id', 'message', 'topic'],
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
  models: v.optional(SwarmModelsSchema),
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
  event_id: v.optional(v.string()),
  keep_history: v.optional(v.boolean()),
  // A picklist for the same reason `tier` is one: an unrecognised lifetime is a
  // caller error worth naming the two slots over, never a value to guess at.
  lifetime: v.optional(v.picklist(SUBORDINATE_LIFETIMES)),
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
  models: 'string[]',
  role: 'string',
  tier: `"${TIER_IDS.join('" | "')}"`,
  agent: 'string',
  mission: 'string',
  scope: '"subordinate" | "workspace"',
  message: 'string',
  topic: 'string',
  deliverable: 'string',
  event_id: 'string',
  keep_history: 'boolean',
  lifetime: `"${SUBORDINATE_LIFETIMES.join('" | "')}"`,
} as const satisfies Record<AgentsToolInputField, string>;

/**
 * The fields each action's caller MUST supply — the `?`-less half of the same
 * relation {@link AGENTS_ACTION_FIELDS} states. The codemode declaration
 * renders optionality from it; the dispatch arms re-check it at runtime
 * because the sandbox parse cannot see which action is coming.
 */
export const AGENTS_ACTION_REQUIRED_FIELDS = {
  swarm: ['task'],
  // The CREATE variant's, which is the one a bare `hire` means. The other two
  // (an agent that exists, a workspace) state their own below; this entry is
  // read only by the single-variant path.
  hire: ['role', 'mission'],
  msg: ['message'],
  list: [],
  dismiss: ['agent'],
} as const satisfies Record<AgentsToolAction, readonly AgentsToolInputField[]>;
/** Creating a helper. `lifetime` joins only where the port that runs a
 *  `task` one is wired, and `scope` only beside `peers`. */
const HIRE_CREATE_FIELDS = [
  'role', 'mission', 'agent', 'tier',
] as const satisfies readonly AgentsToolInputField[];
const HIRE_WORKSPACE_FIELDS = [
  'agent', 'mission', 'scope', 'message',
] as const satisfies readonly AgentsToolInputField[];
/** Handing the workstream to an agent that already exists — the target `ask`
 *  used to be a separate action for. No `lifetime` and no `tier`: an agent that
 *  exists already has both, and offering them here would be two knobs that
 *  cannot move. Selected by the ABSENCE of `role`. */
const HIRE_EXISTING_FIELDS = [
  'agent', 'message',
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
   * `hire`'s workspace branch needs none: `scope` is a literal, so that branch
   * separates itself. Its other two targets are two different FIELDS (`role`
   * asks for an agent that does not exist, `agent` names one that does), and
   * `msg`'s are as well (`agent` against `event_id`), so without this the
   * branches overlap and a call naming both would satisfy each of them. Stated
   * here, the schema TELLS the model the targets are exclusive; the dispatch
   * below is what enforces it, with a message a caller can correct itself from.
   */
  readonly excludes?: readonly AgentsToolInputField[];
}

/** The accepted input variants for one action on this actor. Native JSON
 * Schema and codemode declarations both project this table. */
export function agentsActionInputVariantsFor(
  deps: AgentsToolDeps,
  action: AgentsToolAction,
): readonly AgentsActionInputVariant[] {
  if (action === 'hire') return hireInputVariants(deps);
  if (action === 'msg') return msgInputVariants(deps);
  return [{
    fields: agentsActionFieldsFor(deps, action),
    required: AGENTS_ACTION_REQUIRED_FIELDS[action],
  }];
}

/** `hire`'s targets: a helper to CREATE (whose `lifetime` says how long it
 *  lives), an agent that already EXISTS, and a whole workspace. */
function hireInputVariants(deps: AgentsToolDeps): readonly AgentsActionInputVariant[] {
  const variants: AgentsActionInputVariant[] = [];
  if (deps.team) {
    const fields: AgentsToolInputField[] = [...HIRE_CREATE_FIELDS];
    // Deps-gated exactly as the rung is: with no port to run a `task` hire on,
    // the field that would ask for one is in neither the schema nor the sandbox
    // declaration, so absence is structural rather than a runtime refusal.
    if (deps.team.temporary) fields.push('lifetime');
    if (deps.peers) fields.push('scope');
    variants.push({
      fields,
      required: ['role', 'mission'],
      scope: 'subordinate',
      scopeOptional: true,
    });
  }
  const existing: AgentsToolInputField[] = [...HIRE_EXISTING_FIELDS];
  if (deps.team) existing.push('deliverable');
  if (deps.peers) existing.push('topic');
  variants.push({
    fields: existing,
    required: ['agent', 'message'],
    // The XOR the schema states and the dispatch enforces: `role` asks for an
    // agent that does not exist, and this variant is the one that does.
    excludes: deps.team?.temporary ? ['role', 'lifetime'] : ['role'],
  });
  if (deps.peers) {
    variants.push({
      fields: HIRE_WORKSPACE_FIELDS,
      required: ['mission', 'scope', 'message'],
      scope: 'workspace',
    });
  }
  return variants;
}

/** `msg`'s two ways to say WHO: an agent by name, or the inbound event being
 *  answered. Exactly one — the second exists only beside the peer transport
 *  that issues the events it cites. */
function msgInputVariants(deps: AgentsToolDeps): readonly AgentsActionInputVariant[] {
  const named: AgentsToolInputField[] = ['agent', 'message'];
  if (deps.peers) named.push('topic');
  const byName: AgentsActionInputVariant = {
    fields: named,
    required: ['agent', 'message'],
  };
  // The exclusion only exists when the other target does: with no peer
  // transport there is no `event_id` on this action to be exclusive WITH.
  if (deps.peers) Object.assign(byName, { excludes: ['event_id'] });
  const variants: AgentsActionInputVariant[] = [byName];
  if (deps.peers) {
    variants.push({
      fields: ['event_id', 'message'],
      required: ['event_id', 'message'],
      excludes: ['agent'],
    });
  }
  return variants;
}

/**
 * Fields one action actually reads under the transports this actor wires.
 *
 * `hire` and `msg` are the two multi-variant actions, and theirs are DERIVED
 * from their own variant tables rather than filtered a second time here. Which
 * fields those two carry depends on which transports are wired — `scope` and
 * `topic` only beside `peers`, `lifetime` only beside the port that runs a
 * `task` hire, a subordinate's `deliverable` only beside a roster — and that
 * dependency was stated TWICE: once in the variants the JSON Schema and the
 * codemode declaration project, and once as a filter here. Two spellings of one
 * transport policy is how a field comes to be advertised in a variant whose
 * handler cannot read it. The union of an action's variants IS what it reads.
 */
export function agentsActionFieldsFor(
  deps: AgentsToolDeps,
  action: AgentsToolAction,
): readonly AgentsToolInputField[] {
  const fields = AGENTS_ACTION_FIELDS[action];
  switch (action) {
    case 'swarm':
      return deps.fork ? fields : [];
    case 'hire':
    case 'msg':
      // Each field once, in variant order — which is the order
      // AGENTS_ACTION_FIELDS itself lists them in, created target before
      // existing target, so the sentence a refusal prints is unchanged.
      return [...new Set(
        agentsActionInputVariantsFor(deps, action).flatMap((variant) => variant.fields),
      )];
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
      // the two `hire` targets (and the two `msg` ones) overlap and a call
      // naming both matches each, so `oneOf` would be decorative on exactly the
      // mistake it is here for.
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
 * that difference is the whole point: a row can name an action this surface does
 * not hold, and translating it is exactly the job. Refusing it at the parse
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
  // would otherwise repeat the same ten-name list four times, burying the one
  // line that says which field was wrong.
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
 * Background-job resume filter, shared by both backends: durable job rows store the
 * tool KIND + input, and only exploration work is safely re-runnable. Returns the
 * input to re-execute, or null when the job is not resumable.
 *
 * It is ALSO the DETACH gate (orchestrator/background-tools.ts): the same narrowing
 * decides which live `agents` call may background in the first place, because a call
 * that could not be re-driven after an eviction must never be detached into a job.
 * One predicate at both ends — a detachable call with no resume is how work is lost.
 *
 * Rows are TRANSLATED rather than validated as a model call would be. Durable
 * job input can outlive the tool vocabulary that accepted it
 * (jobs/runner.ts stores the raw input), so a stored row's verbatim input may
 * carry fields this surface refuses and name an ACTION the enum does not hold
 * — and a row is re-driven, not answered, so a refusal there is work lost to
 * a spelling nobody can correct any more. Replay translates that stored
 * contract because no caller is present to correct a refusal. A stored row is
 * history, not a prompt.
 *
 * WHAT TRANSLATES, and every translation names what it could not carry:
 *
 *   `action:'fork'` — an ephemeral rung this enum does not hold. Its caller supplied
 *   the angles itself and a merge model synthesised what came back. A search is what
 *   spawns ephemeral tool-using nodes, so the row re-drives as one; the briefs and
 *   the merge are the loss, and the drop line names them. `preset:'ideate'` runs
 *   without an invented objective, and the settlement loss rides the drop line.
 *
 *   `settle` — a stored field identifying a judged-tree request within the
 *   stored fork shape. Same translation: the field is not an entry here, so
 *   it arrives as an unknown key and is reported as an unsupported field.
 */
export function resumableAgentsInput<T>(kind: string, input: T): AgentsToolInput | null {
  if (kind !== 'agents') return null;
  const parsed = v.safeParse(StoredAgentsInputSchema, input);
  if (!parsed.success) return null;
  const row = parsed.output;
  if (row.action === 'fork') {
    if (row.task === undefined) return null;
    const resumed: AgentsToolInput = { ...swarmFieldsOf(row, TRANSLATION_DECIDES), action: 'swarm', preset: 'ideate', task: row.task };
    recordDroppedFields(kind, input, resumed, ['settlement']);
    return resumed;
  }
  if (row.action !== 'swarm') return null;
  const resumed: AgentsToolInput = { action: 'swarm', ...swarmFieldsOf(row, {}) };
  recordDroppedFields(kind, input, resumed, []);
  return resumed;
}

interface AgentsToolCallOptions {
  abortSignal?: AbortSignal;
}

// ── Dispatch helpers ────────────────────────────────────────────────────────

/** Invalid operation inputs fail before delegation; namespace adapters preserve branchable refusals. */
function badInput(error: string): never {
  throw new KinuError('bad_input', error);
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
    ? readStartedSwarmProfile(fork.rt.storage, fork.rt.actor, input.task)
    : null;
  const preset: SwarmPreset = input.preset
    ?? delegated?.resolved.defaultPreset
    ?? started?.profile.defaultPreset
    ?? 'ideate';

  // THE TWO ROUTING INPUTS ARE EXCLUSIVE, refused here where both live: `tier`
  // resolves ONE model for the whole run and `models` routes each node to its
  // own. A call naming both has stated two different routing decisions for one
  // search and one of the two would be ignored — the same drift the two width
  // modes are refused over, restated by the caller.
  if (input.models !== undefined && input.tier !== undefined) {
    return badInput('`models` routes each node to the model its slot is assigned, and `tier` '
      + `resolves one model for the whole run — you named both (tier "${String(input.tier)}" and `
      + `${String(input.models.length)} model spec(s)), and one of the two routing decisions would `
      + 'be ignored. Route through `tier` for one model across the search, or through `models` '
      + 'for per-node routing.');
  }

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
    models: input.models,
  };

  // Resolution first, per *Presets* — *Validity over the resolved configuration* is
  // stated over the resolved tuple and has no input without it.
  const resolved = resolveSwarm(call);
  if ('reason' in resolved) throw new KinuError(resolved.reason, resolved.error);
  // Legality, per *Validity over the resolved configuration*: over the resolved
  // tuple and never over the preset name.
  const illegal = swarmValidity(resolved);
  if (illegal) throw new KinuError(illegal.reason, illegal.error);

  // The mission scope, and with it both enforcement seams: the governed `LLM` for the
  // measurement calls this process makes, and the PORT the run charges its own model
  // calls through as it makes them.
  const mission = missionScope(budget, input);
  let rt: AgentRuntime = fork.rt;
  if (mission) {
    rt = { ...fork.rt, llm: mission.governor.govern(fork.rt.llm, mission.scope.labels) };
  }
  // Resolved BEFORE the bag, in this order, because each of these is a backend
  // factory whose CALL is a real event — a host is built, a broadcast channel is
  // looked up, a home provisioner is constructed — and the bag below then holds
  // what they returned rather than deciding anything itself.
  const origin = fork.originContext?.();
  const signal = toolOptions?.abortSignal;
  // The transient frames a node publishes while a step is still being produced.
  // Wired wherever the backend holds the socket, which is every backend now that
  // a node's loop runs in the isolate that ran the search.
  const publishHeadStream = fork.reportNodeDelta?.();
  // The durable announcement: the journal a node's rows land in is the parent's,
  // so this is the parent's own channel rather than the node's.
  const announceHeadActivity = fork.announceHeadActivity?.();
  // A host constructs the provisioner around its authoritative filesystem. It
  // may be an in-isolate SqliteVFS or the hosted Nimbus session; the node loop
  // sees the same async contract either way.
  const provisionHome = fork.provisionNodeHome?.();
  // And the runtime the node's loop uses once it has that home. Wired only
  // beside the provisioner, because re-credentialing a runtime with no
  // credential to use is nothing.
  const runtimeForWorkspace = fork.runtimeForNodeWorkspace?.();
  /**
   * ONE TYPED LITERAL, for the reason `call` above gives about itself, and it
   * applies harder here: every field is checked against `SwarmRunDeps`, where
   * the thirteen `Object.assign` calls this replaces checked NOTHING — `assign`
   * widens its target, so a misspelled key or a wrongly-typed value compiled
   * clean and wired nothing at all, on the one bag whose absent keys decide
   * where a node's loop runs, what watches it, and whether it is fenced.
   *
   * An `undefined` field IS an absent one on this bag: `exactOptionalPropertyTypes`
   * is off, and every reader asks with `?.` or a truthiness test. So the thirteen
   * presence branches become the values themselves.
   */
  const runDeps: SwarmRunDeps = {
    rt,
    // Per-node actor acquisition, forwarded not derived: the backend owns what a
    // hosted node's runtime and role are, and every node of this search gets its
    // own actor over the one workspace database.
    hostNode: fork.hostNode,
    model: fork.model,
    mode,
    // Frozen at dispatch so `context:'fork'` survives a background re-drive and a
    // DO eviction carrying the conversation the caller actually had.
    originContext: origin === undefined
      ? undefined
      : Object.freeze(structuredClone([...origin])),
    // THE TIER'S OWN MODEL. Forwarded, never pre-resolved here: a re-drive's
    // profile comes off the claimed ledger row INSIDE the runner, so the runner
    // is the only place that can see both cases, and resolving one of them here
    // would leave the other running today's model under yesterday's record.
    resolveModel: fork.resolveModel,
    // THE SNAPSHOT. A first attempt carries the resolved precedence record down
    // to the runner, which writes it into the run's own ledger row BEFORE any
    // node expands — the moment a durable detach could happen — so a re-drive
    // re-enters under the profile it started under rather than today's catalog.
    profile: delegated === undefined
      ? undefined
      : { profile: delegated.resolved, sources: delegated.sources },
    // THE SEARCH CHARGES ITS OWN CALLS: an exhausted label stops the next level
    // from opening and stops an agent swarm node between its steps, so a cap the
    // caller set is enforced while the money is still there to save.
    mission: mission?.scope,
    signal,
    publishHeadStream,
    announceHeadActivity,
    provisionHome,
    runtimeForWorkspace,
    // The *Inherited context* barrier: the backend's real compaction ladder, handed
    // to the run so a fork parent past the threshold is rewritten once instead of
    // inherited verbatim until the provider refuses. Absent stays absent — the
    // seam's documented loud failure rather than a silent stub.
    compactShared: fork.compactShared,
    // Only a re-drive re-enters an interrupted search; the flag was read at the top
    // of this action, where it also decides where the profile comes from.
    redrive,
  };
  readSpawnStarted(toolOptions)?.();
  const result = await inWorkMode(mode, () => runSwarm(runDeps, resolved));
  if ('reason' in result) throw new KinuError(result.reason, result.error);
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
 * the resolver would refuse. Absent (no catalog wired) is an empty string.
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
    models: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      description: 'For action=swarm: per-node model routing, for capability and cost — a cheap model for recon, a strong one for synthesis. Each expansion child runs models[i % models.length] by its slot in the wave, deterministically, so a re-drive routes the same nodes the same way. NOT for diversity: a mixed model ensemble measured WORSE than repeated sampling from one good model when the purpose is variety (Self-MoA, 65.7 vs 59.1) — reach for it when different nodes need different capability or cost, never to vary answers to one question. Omit and every node runs the one model this call resolved to. Mutually exclusive with `tier`. Each spec resolves through the same resolver as a tier\'s model, and one this session cannot build is refused naming it before any node runs.',
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
  const targets = deps.team && deps.peers
    ? 'a subordinate here or a peer workspace agent (subordinate names win a collision)'
    : deps.team ? 'a subordinate' : 'a peer workspace agent';
  const properties: ConverseSchemaProperties = {
    agent: {
      type: 'string',
      description: `Agent name: ${targets}. On hire, WITHOUT \`role\` it names an agent that already exists and hands it the workstream; WITH \`role\` it is the optional name to create the helper under (auto-generated from the role when omitted). Also the target for msg/dismiss and the detail filter for list.`,
    },
    // Says what a mission is FOR, because the hire rung's context fact makes it
    // load-bearing: this text plus a bounded digest of the caller's recent
    // messages is the subordinate's whole starting knowledge. The sentence is
    // DELEGATION_INHERITANCE.hire.brief — the fork brief's opposite, from the
    // same per-action source, so neither field can be handed the other's rule.
    mission: { type: 'string', maxLength: 20000, description: `For action=hire with \`role\`: the helper's mission — it seeds its identity and runs as its first turn, and at lifetime:"task" it IS the question. ${DELEGATION_INHERITANCE.hire.brief}` },
    message: {
      type: 'string', maxLength: 20000,
      description: 'The workstream for a hire naming an `agent` that already exists, the note or answer for msg, or the first delegated task for hire scope=workspace.',
    },
  };
  if (deps.peers) {
    Object.assign(properties, {
      scope: {
        type: 'string',
        enum: ['subordinate', 'workspace'],
        description: 'For action=hire: subordinate (default) hires into THIS workspace; workspace creates (or reuses by name) a specialist workspace of its own, sends `message` to it, and awaits the result.',
      },
      topic: { type: 'string', maxLength: 80, description: 'Optional short label for a message to a peer workspace agent (default "message").' },
      event_id: { type: 'string', description: 'For action=msg: the agent message event id you were given, to answer that question instead of naming an `agent`. Exclusive with `agent`.' },
    });
  }
  if (deps.team) {
    const temporary = deps.team.temporary !== undefined;
    Object.assign(properties, {
      role: {
        type: 'string', maxLength: 64,
        description: 'For action=hire: the catalog role to create the helper under, exclusive with `agent`. One of the ids listed below.'
          + roleSummaryText(deps),
      },
      tier: { type: 'string', enum: [...TIER_IDS], description: 'For action=hire with `role`: optional inference tier override — tiny|fast|default|slow|deep. Omit to take the role\'s default tier.' },
      deliverable: { type: 'string', maxLength: 2000, description: 'For a hire handing work to a subordinate that already exists: what the finished result should be (optional).' },
      keep_history: { type: 'boolean', description: 'For action=dismiss: keep the subordinate archived with its context (default true). Set false ONLY to permanently wipe its storage.' },
    });
    if (temporary) {
      Object.assign(properties, {
        lifetime: {
          type: 'string',
          enum: [...SUBORDINATE_LIFETIMES],
          description: 'For action=hire with `role`: how long the helper lives. '
            + '"durable" (the default) stays in your roster across turns. '
            + '"task" is created for this one question — the call waits for its answer, returns it '
            + 'here and archives the row, and there is no follow-up, so put the whole question in '
            + '`mission` and name any bulk material by workspace path so that agent reads it itself.',
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
 * The peer topic a hire or a msg rides, or the refusal when the caller claimed the
 * transport's reserved one.
 *
 * Read inside the two arms that use it rather than once for all five actions:
 * `topic` is a field of hire and msg, and reading it for every action made it
 * read like a field of every action — the exact shape that lets a field be
 * accepted where nothing acts on it.
 */
function requestedTopic(input: AgentsToolInput): { topic: string } {
  const topic = input.topic?.trim() || 'message';
  return topic === PEER_REPLY_TOPIC
    ? badInput(`topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes`)
    : { topic };
}
/**
 * Whether this actor may run the requested action now: absent from its wiring is
 * `unsupported`, and a durable roster change under Plan is `denied`.
 *
 * `hire` is NOT decided here, because under Plan the answer depends on its
 * `lifetime`: a `task` hire is a research rung a Plan turn keeps, and a durable
 * one is a roster change it does not. That read belongs in the arm that routes
 * on the same field, so the bar and the dispatch cannot come to disagree about
 * which hire is durable.
 */
function actionAdmission(actions: readonly AgentsToolInput['action'][], mode: WorkMode, action: AgentsToolInput['action']): Refusal | null {
  if (!actions.includes(action)) {
    return { reason: 'unsupported', error: `action "${action}" is not available here. Available: ${actions.join(', ')}` };
  }
  return action === 'hire' ? null : workModeRefusal(mode, action !== 'dismiss', 'agents.' + action);
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
  const mode = inWorkMode(deps.mode, currentWorkMode);
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
  const admission = actionAdmission(actions, mode, input.action);
  if (admission) throw new KinuError(admission.reason, admission.error);
  // The spawn seam. Launching a helper is what turns one exhausted run into
  // many, so the cap is checked before the launch — for every action that
  // creates or wakes an agent. `list` and `dismiss` spend nothing and stay
  // available so a stopped run can still wind itself up, and so does the
  // `event_id` half of `msg`, which answers a question already asked (that
  // half is guarded inside the arm, on the same read it routes on).
  const spawnGuard = () => {
    const refusal = deps.budget?.guard('spawn');
    if (refusal) throw new MissionBudgetExhausted(refusal);
  };
  if (input.action === 'swarm' || input.action === 'hire') spawnGuard();
  // The DEPTH seam, and the second half of a containment that is already
  // structural: an actor at the cap is not wired `team` deps at all, so `hire`
  // is absent from its enum. This covers the one window build-time gating
  // cannot — a toolset is cached across turns and a subordinate's identity is
  // seeded after its facet is built, so a build that ran before the seed could
  // not have known the depth. Depth is fixed for an actor's whole life, so
  // reaching this is a stale build rather than a budget that ran out mid-turn.
  //
  // BOTH LIFETIMES, not just the durable one. A `lifetime:'task'` hire births a
  // child through the identical substrate and therefore adds a level exactly as
  // a durable hire does — so a cap keyed on the lifetime would be a cap the
  // cheap rung walked straight past, one call per level, each spending real
  // money. A hire naming an `agent` that EXISTS is not a spawn and stays
  // available: handing work to an agent that already exists adds no depth, and
  // an actor at the cap still has to be able to use its team. The guard lives on
  // the same read the arm routes on — `if (input.role)` IS the spawn predicate,
  // so the seam and the dispatcher can no longer disagree about what a spawn is
  // (they once did, on exactly `role: ''`, which the schema permits).
  const spawnDepthRefusal = () =>
    team && delegationExhausted(team.delegation) ? delegationDepthRefusal(team.delegation) : null;
  try {
    switch (input.action) {
      case 'swarm':
        return await runSwarmAction(deps, input, mode, toolOptions, deps.budget);

      case 'hire': {
        // A durable roster change is barred under Plan and a `task` hire is
        // not: it is the research rung a Plan turn keeps. Read here, on the
        // same field the routing below reads, rather than in `actionAdmission`
        // where the two could drift.
        const lifetime = input.lifetime ?? 'durable';
        const planBar = workModeRefusal(mode, lifetime === 'task', 'agents.hire');
        if (planBar) throw new KinuError(planBar.reason, planBar.error);
        if ((input.scope ?? 'subordinate') === 'workspace') {
          const workspaceDepth = spawnDepthRefusal();
          if (workspaceDepth) throw new KinuError(workspaceDepth.reason, workspaceDepth.error);
          // Classified, not a bare `{error}`: this is the escape route the depth
          // cap closes — a fresh workspace is the root of its own tree with the
          // whole cap below it — so the one refusal that has to hold must land
          // in `refused` and not indict the tool in `broke`.
          if (!peers) {
            throw new KinuError('denied', 'hire scope=workspace creates a whole workspace, which only the workspace orchestrator may do — '
              + 'hire a subordinate here instead (omit scope), or run a search.');
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
        if (!peers && input.scope !== undefined) {
          return badInput('field "scope" is not available for action "hire" on this actor');
        }
        // `role` IS the discriminator, and it is a presence test rather than an
        // exclusion: with a role this hire CREATES (and `agent`, given, is the
        // name to create under), without one it hands the workstream to an agent
        // that already exists. There is nothing to refuse as ambiguous, because
        // the two readings of `agent` never both apply.
        //
        // A hire naming an agent that exists spends no depth and no birth: its
        // report arrives as an event that wakes you.
        if (!input.role) {
          if (!input.agent || !input.message) {
            return badInput(team
              ? 'hire requires a target and a brief: `role` with `mission` to create an agent, or `agent` with `message` to hand the workstream to one that exists.'
              : 'hire requires agent and message');
          }
          spawnGuard();
          const asked = requestedTopic(input);
          if (team && await isSubordinate(input.agent)) {
            const assignment: Parameters<TeamToolDeps['assign']>[0] = {
              name: input.agent,
              task: input.message,
              mode,
            };
            if (input.deliverable) Object.assign(assignment, { deliverable: input.deliverable });
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
        // From here the hire CREATES, which is what spends a level of tree.
        const createDepth = spawnDepthRefusal();
        if (createDepth) throw new KinuError(createDepth.reason, createDepth.error);
        if (!team) {
          // Capability absence, and `denied` is what that is: the call is
          // well-formed and this actor does not wire the surface it needs.
          throw new KinuError('denied', 'hiring subordinates is not available on this actor');
        }
        if (input.message !== undefined) {
          return badInput('field "message" is not available for a hire that creates an agent — its brief is `mission`');
        }
        if (!input.mission) return badInput('hire requires role and mission');
        // `agent`, here, is the NAME to create under rather than a target.
        // The role is a catalog id here. It is validated and spawn-checked, then carried
        // onto the subordinate's durable identity with its tier override.
        // Without a catalog the hire is refused rather than seeded onto an
        // identity the child's next turn cannot resolve.
        const ctx = deps.profile?.();
        if (!ctx) {
          throw new KinuError('denied', 'This actor wires no role catalog. Hire cannot resolve a role without one.');
        }
        if (lifetime === 'task') {
          // A name would be accepted and ignored: a task agent is archived the
          // moment it answers, so the name never becomes addressable and the
          // roster row it would carry is gone before anyone could use it.
          if (input.agent !== undefined) {
            return badInput('field "agent" is not available on a lifetime:"task" hire — it is archived the '
              + 'moment it answers, so a name you chose is never addressable. Omit it, or hire `durable`.');
          }
          const temporary = team.temporary;
          if (!temporary) {
            throw new KinuError('denied', 'lifetime:"task" runs the agent to its single answer inside this call, which this actor has no substrate for — '
              + 'omit `lifetime` for a durable hire, or name an existing agent with `agent` (action:"list" shows the roster).');
          }
          // A `task` hire uses the same resolver and the same precedence as a
          // durable one. No `tier`: it runs at its ROLE's tier, which is the one
          // routing input this rung has, and a second knob would be a model spec
          // by another name — so the field is not in this variant at all.
          const delegatedTask = resolveDelegatedProfile(ctx, input.role, undefined);
          if ('error' in delegatedTask) return badInput(delegatedTask.error);
          const request: TemporaryRunRequest = {
            role: delegatedTask.resolved.role.id,
            roleLabel: input.role,
            task: input.mission,
            mode,
          };
          if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });
          return await temporary.run(request);
        }
        const delegated = resolveDelegatedProfile(ctx, input.role, input.tier);
        if ('error' in delegated) return badInput(delegated.error);
        // Only an EXPLICIT override rides along: a role's own default tier
        // is re-derived by the child at its next turn boundary from its
        // roleId, so storing it twice would be a second source of truth.
        const resolvedTier = input.tier !== undefined ? delegated.resolved.tier : undefined;
        const request: Parameters<TeamToolDeps['spawn']>[0] = {
          role: delegated.resolved.role.id,
          mission: input.mission,
          mode,
        };
        if (resolvedTier !== undefined) Object.assign(request, { tier: resolvedTier.id });
        if (input.agent) Object.assign(request, { name: input.agent });
        return await team.spawn(request);
      }

      case 'msg': {
        // ONE action, two ways to say WHO — and they are exclusive, because a
        // call naming both has not said which agent it means: `event_id`
        // addresses whoever asked that question, which is not necessarily
        // `agent`. The schema states it (`AgentsActionInputVariant.excludes`);
        // the sandbox namespace has no schema at all, so this is the one place
        // both surfaces meet the rule.
        if (input.agent && input.event_id) {
          return badInput(
            'msg takes ONE target: `agent` to name an agent, or `event_id` to answer the agent '
            + 'message event you were given. Naming both leaves it undecided who this is for — '
            + 'drop `event_id` to message the named agent, or drop `agent` to answer that event.',
          );
        }
        if (!input.message) return badInput('msg requires a message');
        if (input.event_id) {
          if (!peers) {
            throw new KinuError('denied', 'answering an event by `event_id` needs the peer transport, which this actor does not have');
          }
          return await peers.reply({ eventId: input.event_id, message: input.message });
        }
        if (!input.agent) {
          return badInput(peers
            ? 'msg requires a target: `agent` to name an agent, or `event_id` to answer the agent message event you were given.'
            : 'msg requires agent and message');
        }
        // Waking an agent is a spawn-shaped spend; answering a question already
        // asked is not, which is why this guard is here and not before the
        // switch.
        spawnGuard();
        const sent = requestedTopic(input);
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

      case 'list': {
        // PROVENANCE, not addressing: `knows` includes archived rows, so the name
        // a released task-lifetime agent reported still resolves to its record.
        // The hire and msg arms keep routing on the ACTIVE roster
        // (`isSubordinate`), so nothing dismissed can be handed work.
        if (input.agent && team && await team.knows(input.agent)) {
          return await team.status({ name: input.agent });
        }
        // ONE roster read. A `lifetime:'task'` hire appears here while it
        // works — an agent spending the owner's money right now is a helper, and
        // a roster that called itself empty while one ran was the defect this
        // lifetime had to not repeat.
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
          throw new KinuError('denied', 'dismiss applies to subordinates, which this actor does not have');
        }
        if (!input.agent) return badInput('dismiss requires agent');
        return await team.dismiss({
          name: input.agent,
          keepHistory: input.keep_history ?? true,
        });
    }
  } catch (err) {
    if (err instanceof KinuError) throw err;
    const failure = toKinuError({ doing: 'agents.' + input.action, cause: err, otherwise: 'io' });
    failure.message = renderThrownChain({ cause: failure });
    throw failure;
  }
}

/** Build the `agents` tool for whatever deps this actor wires. At least one
 *  deps group must be present — callers gate on that, not this function. */
export function createAgentsTool(deps: AgentsToolDeps): ToolSet[string] {
  const actions = agentsActionsFor(deps);
  const team = deps.team;
  const peers = deps.peers;

  return permitInPlan(tool({
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
              'hire = put one workstream in front of one agent'
              + (team?.temporary
                ? ' — `role` creates it and `lifetime` says how long it lives (durable stays in your roster, task answers this one question here and retires), or `agent` hands it to one that already exists.'
                : ' — `role` creates a persistent named helper, or `agent` hands it to one that already exists.')
              + ' msg = say something to an agent without handing it a workstream. list = the unified roster.'
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
            ...(peers ? ['On msg, `event_id` answers an incoming agent message event instead of naming an `agent`.'] : []),
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
        throw new KinuError('bad_input', renderThrownChain({ cause: error }), { cause: error });
      }
      return dispatchAgentsAction(deps, parsed, toolOptions);
    },
  }));
}
