/**
 * `agents`: the one delegation tool: swarm, hire, msg, list, dismiss, as the wired deps allow (agentsActionsFor).
 * Swarm call contract: docs/EXPLORATION.md "Presets", "Validity over the resolved configuration",
 * "Accepted and ignored".
 */
import { REAL_CLOCK } from '../types/clock';
import { currentWorkMode, inWorkMode, workModeRefusal } from '../execution/work-mode';
import type { LanguageModel, ModelMessage } from 'ai';
import * as v from 'valibot';
import {
  AGENTS_TOOL_ACTIONS,
  type AgentsToolAction,
} from '../tools/registry';
import { SwarmConfigSchema, SwarmModelsSchema, SwarmNodeAssignmentsSchema, SwarmObjectiveSchema } from '../tools/swarm-input';
import {
  PEER_REPLY_TOPIC,
  type PeerAskOutcome, type PeerReplyOutcome, type PeerSendOutcome,
  type PeersToolDeps,
} from '../types/peers';
import { runSwarm, type SwarmRunDeps } from '../strategy/swarm-run';
import type { ActorReference } from '../identity/actor-handle';
import type { SubordinateBirth } from '../subordinates/birth';
import type { SerializedMessage } from '../types/heads';
import { freezeInheritedContext } from '../orchestrator/heads-support';
import { SWARM_CONTEXTS } from '../types/swarm';
import type { PublishHeadStream } from '../heads/head-stream';
import type { AnnounceHeadActivity } from '../heads/live-journal';
import type { ModelCallSink } from '../events/model-call';
import type { WebSearchProvider } from '../web/index';
import { readStartedSwarmProfile } from '../strategy/swarm-resume';
import {
  NAMED_SWARM_PRESETS, SWARM_PRESETS, SWARM_PRESET_DOCTRINE,
  resolveSwarm, swarmValidity,
  type NamedSwarmPreset, type SwarmConfig, type SwarmInput, type SwarmNodeAssignment,
  type SwarmPreset,
} from '../strategy/swarm';
import {
  TierIdSchema, tierIdsOf,
  effectiveRoleCatalog,
  resolveTurnProfile,
  type ProfileAuthorityInputs, type ProfileProvenance,
  type ResolvedTurnProfile, type ResolveTurnProfileInput, type RoleId, type TierId,
} from '../profiles';
import { VERIFIER_KIND_DOC, VERIFIER_KINDS } from '../strategy/objective';
import type { Objective } from '../strategy/objective';
import { readResumeRedrive, readSpawnStarted } from '../jobs/threshold';
import {
  localMissionScope, readMissionLimits, MissionBudgetExhausted,
  type MissionGovernor, type MissionScope,
} from '../mission-budget';
import type { NodeIdentity, NodeWorkspace, NodeWorkspaceProvisioner } from '../strategy/node-workspace';
import type { HostedNodeSeat, NodeCodemode } from '../strategy/node-agent';
import type { AgentRuntime } from '../types/agent-runtime';
import type { WorkMode } from '../types/turn';
import { SWARMS_BETA_SETTING } from '../types/profile';
import type { DelegationChoices } from '../types/dynamic-context';
import { nanoid } from '../utils/nanoid';
import {
  KinuError, renderThrownChain, toKinuError, type ErrorCode, type Refusal, type TurnTrace,
} from '../obs/index';
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
} from '../utils/json';
import {
  countedMsgSend,
  type MsgSendResult,
} from '../obs/msg-counters';

export {
  PEER_REPLY_TOPIC,
  type PeerAskOutcome, type PeerReplyOutcome, type PeerSendOutcome,
  type PeerSpawnOutcome, type PeersToolDeps,
} from '../types/peers';

// Team deps: spawn is `ActorHost.acquire` over the shared workspace database; tasks go out as
// `subordinate_task` events and reports return as `subordinate_report` events on the parent.

export type SubordinateStatus = 'idle' | 'working' | 'awaiting_input' | 'dismissed';

/** One actor_subordinates row; title and role live in the child's actor_config. */
export interface SubordinateRosterEntry {
  name: string;
  actorReference: ActorReference | null;
  birth: SubordinateBirth | null;
  deleteRequested: boolean;
  /** Its actor's origin; `evolution` is an evolution lane's helper. */
  origin: 'user' | 'agent' | 'evolution';
  status: SubordinateStatus;
  currentTask: string | null;
  createdAt: number;
  dismissedAt: number | null;
  lifetime: SubordinateLifetime;
  /** EventLog id of the open assignment ({@link SubordinateHandoff.eventId}; what the report cites), or null. */
  taskEventId: string | null;
}

/**
 * Which branch the subordinate's drain took for a handoff (not a caller choice):
 * `starts_now` when idle, `queued` when busy or deduped.
 */
export type SubordinateDelivery = 'starts_now' | 'queued';

export interface SubordinatePhase {
  busy: boolean;
  lastActivityAt: number | null;
  workingOn: string | null;
}

/** The sender's half of a handoff; `eventId` is what the eventual `subordinate_report` cites. */
export interface SubordinateHandoff {
  eventId: string;
  delivery: SubordinateDelivery;
  phase: SubordinatePhase;
}

export interface SubordinateDismissal {
  readonly stoppedJobs: readonly string[];
}

export interface TeamToolDeps {
  /** The same bounded parent conversation handed to an exploration head. */
  inheritedContext?(): Promise<SerializedMessage[]>;
  /** Where this roster's actor sits in the subordinate tree (subordinates/depth.ts). */
  readonly delegation: DelegationBudget;
  /** The workspace's subordinate roster (dismissed entries excluded). */
  list(): Promise<SubordinateRosterEntry[]>;
  snapshot(): SubordinateRosterEntry[];
  /** Create an idle durable subordinate for the owner; it has no task until messaged or assigned. Role defaults
   *  to `task`, mission to the creator's; the model's `hire` uses {@link spawn}. `role` is the catalog id,
   *  written to the child's config store at seed time. */
  create(input: {
    name?: string;
    /** A title the owner typed: origin `user`, never auto-retitled. */
    displayName?: string;
    role?: RoleId;
    tier?: TierId;
    mission?: string;
  }): Promise<{
    name: string; displayName: string; subordinate: SubordinateRosterEntry;
  }>;
  /** Retitle on the owner's behalf with `user` origin, which permanently stops auto-titling. */
  rename(input: { name: string; displayName: string }): Promise<{
    ok: true; name: string; displayName: string; subordinate: SubordinateRosterEntry;
  }>;
  /** Record a title the child settled itself. Writes nothing; refreshes roster listeners. */
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
    inheritedContext?: SerializedMessage[];
  }): Promise<{
    name: string; displayName: string;
  }>;
  /** Enqueue a task on the subordinate (drained as its next turn). */
  assign(input: { name: string; task: string; deliverable?: string; mode: WorkMode }): Promise<
    { ok: true; name: string } & SubordinateHandoff
  >;
  /** Whether this roster holds `name` at all, archived rows included. Provenance, not addressing:
   *  hire/msg route on {@link list}. */
  knows(name: string): Promise<boolean>;
  /** Roster row and live state; archived rows have none. */
  status(input: { name?: string }): Promise<object>;
  message(input: { name: string; content: string; mode: WorkMode }): Promise<
    { ok: true; name: string } & SubordinateHandoff
  >;
  /** Retire a subordinate. Archives by default; storage is wiped only when keepHistory=false. */
  dismiss(input: {
    name: string;
    keepHistory?: boolean;
    /** Trusted caller attribution: the owner RPC supplies `user`; a model cannot retire user-created agents. */
    requestedBy?: 'orchestrator' | 'user';
  }): Promise<{
    ok: true; name: string; historyKept: boolean;
    stoppedJobs: readonly string[];
  }>;
  /**
   * The `lifetime:'task'` half of `hire`: starts one child and returns; the child retires once it answers.
   * Required wherever a child substrate is wired; unwired, `hire` has no `lifetime` field and every hire is durable.
   */
  readonly temporary?: TemporaryAgentPort;
}

// Peers deps: the EventsHub peer transport (`outbox_peer` -> receivePeerMessage -> EventLog -> turn).


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

// Counter readers: translate each transport's outcome for the counter. Kept beside the outcome types
// so a new outcome case fails to compile here.

function peerSendCount(outcome: PeerSendOutcome): MsgSendResult {
  return outcome.status === 'rejected'
    ? { outcome: 'rejected' }
    : { outcome: outcome.status, messageId: outcome.message_id };
}

/** A send-and-await: `replied`, not `delivered`, because its wait includes the answering turn. */
function peerAskCount(outcome: PeerAskOutcome): MsgSendResult {
  return { outcome: outcome.status === 'replied' ? 'replied' : 'rejected' };
}

function peerReplyCount(outcome: PeerReplyOutcome): MsgSendResult {
  return { outcome: outcome.ok ? 'delivered' : 'rejected' };
}

function handoffCount(handoff: SubordinateHandoff): MsgSendResult {
  return {
    outcome: handoff.delivery === 'queued' ? 'queued' : 'delivered',
    messageId: handoff.eventId,
  };
}

/** What an actor needs to run a search: a model and a workspace. Wired under `swarm` on {@link AgentsToolDeps}. */
export interface AgentsSwarmDeps {
  /** The caller's runtime, not any node's. */
  rt: AgentRuntime;
  hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
  /** Read when a swarm starts, so it is the model the caller's turn runs on, not the one at toolset build. */
  model: () => LanguageModel;
  /** Every model call a search makes bills here. */
  reportModelCall: ModelCallSink;
  nodeCodemode: NodeCodemode;
  webSearch: WebSearchProvider;
  /**
   * Turns a resolved tier's model spec into the model a delegated node runs on. Required wherever
   * {@link AgentsToolDeps.profile} is wired: a run with a profile snapshot and no resolver refuses
   * (`runSwarm`). Absent with no catalog, nodes run `model`.
   */
  resolveModel?: (spec: string) => LanguageModel;
  /** Caller conversation at dispatch, frozen into the search ledger so `context:'inherit'` survives re-drive. */
  originContext?: () => Promise<readonly ModelMessage[]>;
  /** Host-owned async provisioner for one node's private home, resolved per swarm call.
   *  Absent: no credentialed home, and nodes report the shared plane. */
  provisionNodeHome?: () => NodeWorkspaceProvisioner;
  /** Builds one node's runtime over its provisioned home, acting as that home's uid. Requires
   *  {@link provisionNodeHome}; null means the hosted seat supplies it ({@link NodeAgentDeps.runtimeForWorkspace}). */
  runtimeForNodeWorkspace?: (() => (workspace: NodeWorkspace, identity: NodeIdentity) => Promise<AgentRuntime>) | null;
  reportNodeDelta?: () => PublishHeadStream;
  announceHeadActivity?: () => AnnounceHeadActivity;
  /** The *Inherited context* compaction ladder (`SwarmRunDeps.compactShared`); absent, an over-window
   *  parent inherits verbatim and the provider refuses. */
  compactShared?: SwarmRunDeps['compactShared'];
  windowOf?: SwarmRunDeps['windowOf'];
  /** The workspace's running workers, so the owner can stop one. */
  workers?: SwarmRunDeps['workers'];
}

/** Inputs for role/tier/preset precedence, wired under {@link AgentsToolDeps.profile}. */
export interface AgentsProfileContext extends ProfileAuthorityInputs {
  readonly roleId: RoleId;
  readonly availableTools: readonly string[];
  readonly pins: Pick<ResolveTurnProfileInput, 'workspaceModel' | 'actorModel'>;
}

export function agentsProfileContext(
  profile: ResolvedTurnProfile | null,
  authority: ProfileAuthorityInputs | null,
): AgentsProfileContext | null {
  if (!profile || !authority) return null;
  const { source, model } = profile.tier;

  return {
    ...authority,
    roleId: profile.role.id,
    availableTools: profile.allowedTools,
    pins: { workspaceModel: source === 'workspace' ? model : null, actorModel: source === 'actor' ? model : null },
  };
}

export interface DelegatedProfile {
  readonly resolved: ResolvedTurnProfile;
  readonly sources: ProfileProvenance;
}

export interface AgentsToolDeps {
  /** Trusted, host-owned turn mode; never in the model schema, so a child cannot opt out of a Plan
   *  turn's mutation bar. */
  mode: WorkMode;
  /** The exploration substrate; with `swarms` it puts `swarm` in this actor's enum. */
  swarm?: AgentsSwarmDeps;
  /** The account's `SWARMS_BETA_SETTING` the toolset was built under: off withholds the substrate. */
  swarms: boolean;
  team?: TeamToolDeps;
  /** Cross-workspace peer messaging, orchestrator only. Never subordinates: `hire scope=workspace`
   *  mints a fresh tree root and would escape the depth cap. */
  peers?: PeersToolDeps;
  /** Mission budget governor: gates every spawn on its label and hands a search the port its model
   *  calls charge through. Unwired or unscoped changes nothing. */
  budget?: MissionGovernor;
  /** Profile authority thunk (a backend may sign in after the toolset is built). Absent: a
   *  role-targeted hire refuses and swarm needs an explicit preset. */
  profile?: () => AgentsProfileContext | null;
}

interface UnifiedRosterResult {
  subordinates?: SubordinateRosterEntry[];
  peers?: Array<{ name: string; displayName?: string }>;
  note?: string;
}

/** Actions this deps set supports: the one gate shared by the tool schema, the prompt's Delegation
 *  section and `agents.*` codemode. Presence-typed so prompt assembly need not build the substrate. */
export function agentsActionsFor(deps: { swarm?: object; swarms: boolean; team?: object; peers?: object }): AgentsToolAction[] {
  const converse = deps.team !== undefined || deps.peers !== undefined;

  const present = {
    // A search needs exactly the exploration substrate, so it has no deps group of its own.
    swarm: deps.swarm !== undefined && deps.swarms,
    hire: converse,
    msg: converse,
    list: converse,
    dismiss: deps.team !== undefined,
  } satisfies Record<AgentsToolAction, boolean>;

  return AGENTS_TOOL_ACTIONS.filter((action) => present[action]);
}

/** The deps with the substrate withheld while the account's swarms are off, so every rendering omits `swarm`. */
export function offered(deps: AgentsToolDeps): AgentsToolDeps {
  return deps.swarms ? deps : { ...deps, swarm: undefined };
}

export interface AgentsToolInput {
  action: AgentsToolAction;
  /** What the search is for, in prose — never the measured quantity. */
  task?: string;
  /** Cumulative spend cap for everything this helper spawns; nests under the caller's mission scope. */
  budget_usd?: number;
  budget_tokens?: number;
  budget_label?: string;
  preset?: SwarmPreset;
  /** What is measured, in what unit, and which direction is better. Optional; refused on `ideate`. */
  objective?: Objective;
  key?: string;
  config?: Partial<SwarmConfig>;
  from?: NamedSwarmPreset;
  label?: string;
  name?: string;
  branches?: number;
  depth?: number;
  /** Exclusive with `branches`; see {@link SwarmInput.nodes}. */
  nodes?: readonly SwarmNodeAssignment[];
  /** Exclusive with `tier`; see {@link SwarmInput.models}. */
  models?: readonly string[];
  /** The role a delegation runs under; one per swarm. On `hire` it is the discriminant: present
   *  creates, absent hands the workstream to `agent`. */
  role?: RoleId;
  /** Explicit, else the role's default tier, else `default`. Exclusive with `models`. */
  tier?: TierId;
  agent?: string;
  mission?: string;
  scope?: 'subordinate' | 'workspace';
  message?: string;
  topic?: string;
  deliverable?: string;
  event_id?: string;
  keep_history?: boolean;
  /** `durable` (default) stays in the roster; `task` answers once and is archived. */
  lifetime?: SubordinateLifetime;
  context?: 'fresh' | 'inherit';
}

export type AgentsToolInputField = Exclude<keyof AgentsToolInput, 'action'>;

/**
 * Which fields each action's handler reads. `gate:agents-fields` holds each list to the `input.<field>`
 * reads in `dispatchAgentsAction`; a field outside an action's list is refused, not ignored.
 */
export const AGENTS_ACTION_FIELDS = {
  // Mission caps (`budget_*`) sit beside the swarm fields per *Presets*, enforced through `missionScope`.
  // No iteration or wall-clock cap: nothing enforces either (*Accepted and ignored*).
  swarm: [
    'task', 'preset', 'objective', 'key', 'config', 'from', 'label', 'name', 'branches', 'depth',
    'nodes', 'models',
    'role', 'tier',
    'budget_usd', 'budget_tokens', 'budget_label',
  ],
  // `role` creates (with `lifetime`, `tier`); `agent` hands work to an existing agent (`deliverable`,
  // `topic`). Ordered by variant: the codemode variant union is held to this list.
  hire: ['role', 'mission', 'agent', 'tier', 'lifetime', 'context', 'scope', 'message', 'deliverable', 'topic'],
  msg: ['agent', 'event_id', 'message', 'topic'],
  list: ['agent'],
  dismiss: ['agent', 'keep_history'],
} as const satisfies Record<AgentsToolAction, readonly AgentsToolInputField[]>;

/** Every input field and its type, declared once: the model parse refuses unknown fields, replay drops them. */
const AgentsInputEntries = {
  action: v.picklist(AGENTS_TOOL_ACTIONS),
  context: v.optional(v.picklist(SWARM_CONTEXTS)),
  task: v.optional(v.string()),
  budget_usd: v.optional(v.number()),
  budget_tokens: v.optional(v.number()),
  budget_label: v.optional(v.string()),
  // Spelled out rather than spread from tools/swarm-input.ts: `gate:agents-fields` reads these keys.
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
  tier: v.optional(TierIdSchema),
  scope: v.optional(v.picklist(['subordinate', 'workspace'])),
  message: v.optional(v.string()),
  topic: v.optional(v.string()),
  deliverable: v.optional(v.string()),
  event_id: v.optional(v.string()),
  keep_history: v.optional(v.boolean()),
  lifetime: v.optional(v.picklist(SUBORDINATE_LIFETIMES)),
};

/** The engine's input, checked as each operation's fields are mapped onto it: a field it does not declare is refused. */
export const AgentsEngineInputSchema = v.strictObject(AgentsInputEntries);

export interface AgentsToolCallOptions {
  abortSignal?: AbortSignal;
  trace?: TurnTrace;
}

/** Invalid operation inputs fail before delegation; namespace adapters preserve branchable refusals. */
function badInput(error: string): never {
  throw new KinuError('bad_input', error);
}

/** The mission scope for this call (a fresh child label when it declared a cap) and its charging port;
 *  null when there is no governor or scope. */
function missionScope(
  budget: MissionGovernor | undefined,
  input: AgentsToolInput,
): { governor: MissionGovernor; scope: MissionScope } | null {
  if (!budget) return null;
  const limits = readMissionLimits(input);
  let labels: readonly string[] = budget.scope;

  if (limits) {
    // A blank label names no sub-ledger; the generated one keeps it addressable.
    const declared = input.budget_label?.trim();
    const label = declared === undefined || declared === '' ? `swarm-${nanoid()}` : declared;
    budget.declare(label, limits);
    labels = [label];
  }

  const scope = localMissionScope(budget, labels);

  return scope ? { governor: budget, scope } : null;
}

/**
 * One `agents.swarm` call: resolve, check, run. Refusals: `bad_input` (not a legal search), `unsupported`
 * (no engine), `unavailable` (instrument missing). The port charges the run's model calls as they happen,
 * so this seam records the spawn and charges no tokens.
 */
/**
 * Role/tier/preset precedence through the one resolver: explicit input, then the caller's role and its
 * defaults. An explicit role must be in the caller's `spawns`. Returns `{ error }`, never throws.
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
    return { error: `unknown active role ${JSON.stringify(ctx.roleId)}: it is not in this `
      + 'account\'s catalog; ask the owner to fix the catalog or pick an explicit role.' };
  }

  const spawns = callerRole.spawns;

  // Absent `spawns` inherits everything; '*' is the wildcard; a caller may always use its own role.
  if (role !== undefined && role !== ctx.roleId
    && spawns !== undefined && spawns !== '*'
    && !spawns.includes(role)) {
    return { error: `role ${JSON.stringify(role)} is not one your role may delegate to: `
      + `allowed: ${spawns.length > 0 ? spawns.join(', ') : '(none)'}.` };
  }

  try {
    const resolved = resolveTurnProfile({
      envelope: ctx.envelope,
      provider: ctx.provider,
      roleId: role ?? ctx.roleId,
      explicitTier: tier,
      ...ctx.pins,
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

interface AgentsActionCall {
  deps: AgentsToolDeps;
  input: AgentsToolInput;
  mode: WorkMode;
  toolOptions: AgentsToolCallOptions | undefined;
}

/** The exploration substrate for `swarm`; re-checked because the type does not carry the enum gate. */
function swarmSubstrate(deps: AgentsToolDeps): AgentsSwarmDeps {
  const swarm = deps.swarm;

  if (!swarm) throw new KinuError('unsupported', 'this actor wires no exploration substrate, so `swarm` has nothing to run');

  return swarm;
}

interface SwarmActionCall extends AgentsActionCall {
  budget?: MissionGovernor;
}

async function runSwarmAction({ deps, input, mode, toolOptions, budget }: SwarmActionCall): Promise<object> {
  const swarm = swarmSubstrate(deps);

  // A re-drive replays its stored profile snapshot and never consults today's catalog. Read from the
  // options bag (see `RESUME_REDRIVE_OPTION`): the input is the durable row.
  const redrive = readResumeRedrive({ toolOptions });

  if (!redrive && !input.preset && !deps.profile) {
    return badInput(`swarm needs \`preset\`: the shape of the search${deps.profile ? '' : ' (no role catalog is wired here to take its default from)'}. ${SWARM_PRESET_DOCTRINE.join(' ')}`);
  }

  if (!input.task) {
    return badInput('swarm needs `task`: what the search is for, in prose. The measured '
      + 'quantity goes in `objective`, never here.');
  }

  // Precedence for a first attempt only; a re-drive's snapshot comes off the claimed ledger row.
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
      return badInput('role and tier need a profile catalog, which this actor does not have: '
        + 'call again without them.');
    }
  }

  // A re-drive with no preset is not `ideate`: its first attempt may have used the role's default, so
  // the preset comes off the same stored record as role, tier and model.
  const started = redrive && input.preset === undefined
    ? readStartedSwarmProfile(swarm.rt.storage, swarm.rt.actor, input.task)
    : null;

  const preset: SwarmPreset = input.preset
    ?? delegated?.resolved.defaultPreset
    ?? started?.profile.defaultPreset
    ?? 'ideate';

  // `tier` and `models` are exclusive routing inputs.
  if (input.models !== undefined && input.tier !== undefined) {
    return badInput('`models` routes each node to the model its slot is assigned, and `tier` '
      + `resolves one model for the whole run: you named both (tier "${String(input.tier)}" and `
      + `${String(input.models.length)} model spec(s)), and one of the two routing decisions would `
      + 'be ignored. Route through `tier` for one model across the search, or through `models` '
      + 'for per-node routing.');
  }

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

  // Resolution first: *Validity over the resolved configuration* is stated over the resolved tuple.
  const resolved = resolveSwarm(call);

  if ('reason' in resolved) throw new KinuError(resolved.reason, resolved.error);
  const illegal = swarmValidity(resolved);

  if (illegal) throw new KinuError(illegal.reason, illegal.error);

  const mission = missionScope(budget, input);
  let rt: AgentRuntime = swarm.rt;

  if (mission) {
    rt = { ...swarm.rt, llm: mission.governor.govern(swarm.rt.llm, mission.scope.labels) };
  }

  // Each backend factory call is a real event, so resolve them once, before the bag.
  const origin = await swarm.originContext?.();
  const signal = toolOptions?.abortSignal;
  const publishHeadStream = swarm.reportNodeDelta?.();
  const announceHeadActivity = swarm.announceHeadActivity?.();
  const provisionHome = swarm.provisionNodeHome?.();
  // Wired only beside the provisioner.
  const runtimeForWorkspace = swarm.runtimeForNodeWorkspace?.();

  /** One typed literal so every field is checked against `SwarmRunDeps`; an `undefined` field is an absent one. */
  const runDeps: SwarmRunDeps = {
    rt,
    hostNode: swarm.hostNode,
    model: swarm.model,
    mode,
    // Frozen at dispatch so `context:'inherit'` survives a background re-drive.
    originContext: origin === undefined ? undefined : freezeInheritedContext(origin),
    // Forwarded, not pre-resolved: only the runner sees a re-drive's claimed profile.
    resolveModel: swarm.resolveModel,
    // The runner writes the snapshot to the ledger row before any node expands, so a re-drive keeps it.
    profile: delegated === undefined
      ? undefined
      : { profile: delegated.resolved, sources: delegated.sources },
    // The search charges its own calls, so an exhausted label stops it mid-run.
    mission: mission?.scope,
    signal,
    // Real time on every node's ledger (D19); a test can inject its own clock.
    clock: REAL_CLOCK,
    reportModelCall: swarm.reportModelCall,
    nodeCodemode: swarm.nodeCodemode,
    webSearch: swarm.webSearch,
    publishHeadStream,
    announceHeadActivity,
    provisionHome,
    runtimeForWorkspace,
    // The *Inherited context* barrier; absent stays absent (the seam's loud failure).
    compactShared: swarm.compactShared,
    windowOf: swarm.windowOf,
    workers: swarm.workers,
    redrive,
  };

  readSpawnStarted({ toolOptions })?.();
  const result = await inWorkMode(mode, () => runSwarm(runDeps, resolved));

  if ('reason' in result) throw new KinuError(result.reason, result.error);
  // Record the spawn only: the run's tokens were already debited per call through
  // `SwarmRunDeps.mission`, so charging `report.tokens` again would bill twice.
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

/** The roles and tiers this actor's `role` and `tier` take, for its step context: in the schema they would make each
 *  account's tool bytes its own. Null with no catalog. */
export function delegationChoices(ctx: AgentsProfileContext | null): DelegationChoices | null {
  if (!ctx) return null;
  const roles = effectiveRoleCatalog(ctx.envelope.catalog);
  const callerSpawns = roles[ctx.roleId]?.spawns;

  const allowed = (id: string): boolean => {
    if (ctx.roleId === id) return true;

    if (callerSpawns === undefined || callerSpawns === '*') return true;

    return callerSpawns.includes(id);
  };

  return {
    roles: Object.entries(roles).filter(([id]) => allowed(id)).map(([id, role]) => `${id}: ${role.description}`),
    tiers: tierIdsOf(ctx.envelope.catalog),
  };
}

/** Registered instruments with their `spec` keys, from `VERIFIER_KIND_DOC`, so the schema matches `swarmValidity`. */
export function verifierKinds(): string {
  return VERIFIER_KINDS.map((kind) => `${kind} (spec {${VERIFIER_KIND_DOC[kind].specFields.join(', ')}})`).join(', ');
}

/** The peer topic for a hire or msg, or a refusal when the caller claimed the transport's reserved one. */
function requestedTopic(input: AgentsToolInput): { topic: string } {
  const requested = input.topic?.trim();
  // A blank topic is no topic: the default is what the transport routes on.
  const topic = requested === undefined || requested === '' ? 'message' : requested;

  return topic === PEER_REPLY_TOPIC
    ? badInput(`topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes`)
    : { topic };
}

/** The refusal of a `swarm` the account's beta withholds; null when the beta is not what stops it. */
function withheldBeta(wired: AgentsToolDeps, action: AgentsToolInput['action']): string | null {
  if (action !== 'swarm' || wired.swarm === undefined || wired.swarms) return null;

  return `swarm is a beta this account has not turned on: "${SWARMS_BETA_SETTING}" in Settings, Beta`;
}

/** Whether this actor may run the action now: unwired is `unsupported`, a durable roster change under
 *  Plan is `denied`, as is an action the account's beta withholds. `hire` is decided in its arm, since Plan
 *  permits a `task` hire. */
function actionAdmission(
  actions: readonly AgentsToolInput['action'][], mode: WorkMode, action: AgentsToolInput['action'], beta: string | null,
): Refusal | null {
  if (beta !== null) return { reason: 'denied', error: beta };

  if (!actions.includes(action)) {
    return { reason: 'unsupported', error: `action "${action}" is not available here. Available: ${actions.join(', ')}` };
  }

  return action === 'hire' ? null : workModeRefusal(mode, action !== 'dismiss', 'agents.' + action);
}

/** Refuse fields the chosen hire variant cannot act on, naming the field that does the job; neither
 *  the parse nor the codemode namespace catches cross-variant fields. */
function assertHireVariant(input: AgentsToolInput): void {
  if (!input.role) {
    if (input.context !== undefined) {
      return badInput('field "context" belongs to a hire that creates with `role`: an existing agent already has its conversation');
    }

    if (input.mission !== undefined) {
      return badInput('field "mission" is not available on a hire that names an existing agent: its brief is `message`');
    }

    if (input.tier !== undefined) {
      return badInput('field "tier" is not available on a hire that names an existing agent: it already runs at its own tier');
    }

    if (input.lifetime !== undefined) {
      return badInput('field "lifetime" is not available on a hire that names an existing agent: it already has one; `lifetime` belongs to a hire that creates with `role`');
    }

    return;
  }

  if (input.message !== undefined) {
    return badInput('field "message" is not available for a hire that creates an agent: its brief is `mission`');
  }

  if (input.deliverable !== undefined) {
    return badInput('field "deliverable" is not available on a hire that creates an agent: say what the result should be in `mission`');
  }

  if (input.topic !== undefined) {
    return badInput('field "topic" is not available on a hire that creates an agent: it labels a message to an agent that already exists');
  }

  if (input.lifetime === 'task' && input.tier !== undefined) {
    return badInput('field "tier" is not available on a lifetime:"task" hire: it runs at its role\'s tier; omit it, or hire `durable` for an override');
  }
}

/**
 * The one delegation dispatch, for the `agents` tool and `agents.*` codemode. Every read of `input`
 * happens inside the try, since codemode input is unvalidated. Only `toolOptions.abortSignal` is read.
 */
/** The `hire scope=workspace` route: a whole new workspace, which only the
 *  orchestrator's peer seam may open. */
interface WorkspaceHireCall extends AgentsActionCall {
  spawnDepthRefusal: () => { reason: ErrorCode; error: string } | null;
}

async function hireWorkspace({ deps, input, mode, toolOptions, spawnDepthRefusal }: WorkspaceHireCall): Promise<object> {
  const peers = deps.peers;

  if (input.context !== undefined) return badInput('field "context" belongs to a subordinate hire with `role`, not scope="workspace"');
  const workspaceDepth = spawnDepthRefusal();

  if (workspaceDepth) throw new KinuError(workspaceDepth.reason, workspaceDepth.error);

  // Classified: a fresh workspace escapes the depth cap, so this refusal must land in `refused`.
  if (!peers) {
    throw new KinuError('denied', 'hire scope=workspace creates a whole workspace, which only the workspace orchestrator may do: '
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

interface CreateHireCall extends Omit<AgentsActionCall, 'toolOptions'> {
  team: TeamToolDeps;
  input: AgentsToolInput & { role: string; mission: string };
  lifetime: 'durable' | 'task';
}

async function hireCreate({ deps, team, input, mode, lifetime }: CreateHireCall): Promise<object> {
  const ctx = deps.profile?.();

  if (!ctx) {
    throw new KinuError('denied', 'This actor wires no role catalog. Hire cannot resolve a role without one.');
  }

  const inheritedContext = input.context === 'inherit'
    ? [...freezeInheritedContext(await team.inheritedContext?.()
      ?? badInput('context:"inherit" requires this actor\'s parent-conversation source'))]
    : undefined;

  if (lifetime === 'task') {
    if (input.agent !== undefined) {
      return badInput('field "agent" is not available on a lifetime:"task" hire: it is archived the '
        + 'moment it answers, so a name you chose is never addressable. Omit it, or hire `durable`.');
    }

    const temporary = team.temporary;

    if (!temporary) {
      throw new KinuError('denied', 'lifetime:"task" needs a task-agent substrate, which this actor has none of: '
        + 'omit `lifetime` for a durable hire, or name an existing agent with `agent` (op:"list" shows the roster).');
    }

    const delegatedTask = resolveDelegatedProfile(ctx, input.role, undefined);

    if ('error' in delegatedTask) return badInput(delegatedTask.error);

    const request: TemporaryRunRequest = {
      role: delegatedTask.resolved.role.id,
      roleLabel: input.role,
      task: input.mission,
      mode,
    };

    if (inheritedContext !== undefined) Object.assign(request, { inheritedContext });

    return await temporary.start(request);
  }

  const delegated = resolveDelegatedProfile(ctx, input.role, input.tier);

  if ('error' in delegated) return badInput(delegated.error);
  // Only an explicit tier is stored; the child re-derives its role's default.
  const resolvedTier = input.tier !== undefined ? delegated.resolved.tier : undefined;

  const request: Parameters<TeamToolDeps['spawn']>[0] = {
    role: delegated.resolved.role.id,
    mission: input.mission,
    mode,
  };

  if (inheritedContext !== undefined) Object.assign(request, { inheritedContext });

  if (resolvedTier !== undefined) Object.assign(request, { tier: resolvedTier.id });

  if (input.agent) Object.assign(request, { name: input.agent });

  return await team.spawn(request);
}

/** Narrows `role` and `mission` for `hireCreate` without an assertion. */
function isHireCreateInput(
  input: AgentsToolInput,
): input is AgentsToolInput & { role: string; mission: string } {
  return Boolean(input.role) && Boolean(input.mission);
}

interface HireActionCall extends WorkspaceHireCall {
  spawnGuard: () => void;
  isSubordinate: (name: string) => Promise<boolean>;
}

async function runHireAction(
  { deps, input, mode, toolOptions, spawnGuard, spawnDepthRefusal, isSubordinate }: HireActionCall,
): Promise<object> {
  const team = deps.team;
  const peers = deps.peers;

  // Plan bars a durable roster change but keeps a `task` hire; read on the same field routing reads.
  const lifetime = input.lifetime ?? 'durable';
  const planBar = workModeRefusal(mode, lifetime === 'task', 'agents.hire');

  if (planBar) throw new KinuError(planBar.reason, planBar.error);

  if ((input.scope ?? 'subordinate') === 'workspace') {
    return await hireWorkspace({ deps, input, mode, toolOptions, spawnDepthRefusal });
  }

  if (!peers && input.scope !== undefined) {
    return badInput('field "scope" is not available for action "hire" on this actor');
  }

  // `role` is the discriminator: with it this hire creates (named `agent`); without it, it hands work
  // to an existing agent, which spends no depth.
  if (!input.role) {
    if (!input.agent || !input.message) {
      return badInput(team
        ? 'hire requires a target and a brief: `role` with `mission` to create an agent, or `agent` with `message` to hand the workstream to one that exists.'
        : 'hire requires agent and message');
    }

    assertHireVariant(input);
    spawnGuard();
    const asked = requestedTopic(input);

    if (team && await isSubordinate(input.agent)) {
      const assignment: Parameters<TeamToolDeps['assign']>[0] = {
        name: input.agent,
        task: input.message,
        mode,
      };

      if (input.deliverable) Object.assign(assignment, { deliverable: input.deliverable });

      const handoff = await countedMsgSend(
        { action: 'hire', transport: 'subordinate', addressing: 'agent', target: input.agent, chars: input.message.length },
        () => team.assign(assignment),
        handoffCount,
      );

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

      return await countedMsgSend(
        { action: 'hire', transport: 'peer', addressing: 'agent', target: input.agent, chars: input.message.length },
        () => peers.ask(request),
        peerAskCount,
      );
    }

    return badInput(`unknown agent "${input.agent}": check the roster with op:"list"`);
  }

  // From here the hire creates, which spends a tree level.
  const createDepth = spawnDepthRefusal();

  if (createDepth) throw new KinuError(createDepth.reason, createDepth.error);

  if (!team) {
    // Capability absence is `denied`.
    throw new KinuError('denied', 'hiring subordinates is not available on this actor');
  }

  assertHireVariant(input);

  if (!input.mission) return badInput('hire requires role and mission');

  // `agent` is the name to create under; the role is validated, spawn-checked, and stored with its tier.
  if (!isHireCreateInput(input)) return badInput('hire requires role and mission');

  return await hireCreate({ deps, team, input, mode, lifetime });
}

export async function dispatchAgentsAction(
  deps: AgentsToolDeps,
  input: AgentsToolInput,
  toolOptions?: AgentsToolCallOptions,
): Promise<object> {
  // A withheld swarm is refused at admission, so its arm never reads the substrate.
  const actions = agentsActionsFor(offered(deps));
  const mode = inWorkMode(deps.mode, currentWorkMode);
  const team = deps.team;
  const peers = deps.peers;

  // No catch: a roster read failure must reach the caller, not route the assignment to the peer path.
  const isSubordinate = async (name: string): Promise<boolean> => {
    if (!team) return false;

    return (await team.list()).some((entry) => entry.name === name);
  };

  // An action this actor does not wire: `unsupported` (obs/error.ts), classified so it counts as refused.
  const admission = actionAdmission(actions, mode, input.action, withheldBeta(deps, input.action));

  if (admission) throw new KinuError(admission.reason, admission.error);

  // Spawn seam: check the mission cap before any action that creates or wakes an agent. `list`,
  // `dismiss` and the `event_id` half of `msg` stay available.
  const spawnGuard = () => {
    const refusal = deps.budget?.guard('spawn');

    if (refusal) throw new MissionBudgetExhausted(refusal);
  };

  if (input.action === 'swarm' || input.action === 'hire') spawnGuard();

  // Depth seam: covers a toolset cached before the identity was seeded. Applies to both lifetimes; a
  // hire naming an existing `agent` is not a spawn and stays available.
  const spawnDepthRefusal = () =>
    team && delegationExhausted(team.delegation) ? delegationDepthRefusal(team.delegation) : null;

  try {
    switch (input.action) {
      case 'swarm':
        return await runSwarmAction({ deps, input, mode, toolOptions, budget: deps.budget });

      case 'hire':
        return await runHireAction({ deps, input, mode, toolOptions, spawnGuard, spawnDepthRefusal, isSubordinate });

      case 'msg': {
        // `agent` and `event_id` are exclusive; the sandbox has no schema, so both surfaces enforce it here.
        if (input.agent && input.event_id) {
          return badInput(
            'msg takes ONE target: `agent` to name an agent, or `event_id` to answer the agent '
            + 'message event you were given. Naming both leaves it undecided who this is for: '
            + 'drop `event_id` to message the named agent, or drop `agent` to answer that event.',
          );
        }

        if (!input.message) return badInput('msg requires a message');
        // Bound to consts: the counter's closures would otherwise re-read `input.message` without its narrowing.
        const message = input.message;

        if (input.event_id) {
          if (!peers) {
            throw new KinuError('denied', 'answering an event by `event_id` needs the peer transport, which this actor does not have');
          }

          const answered = input.event_id;

          return await countedMsgSend(
            { action: 'msg', transport: 'peer', addressing: 'event', target: answered, chars: message.length },
            () => peers.reply({ eventId: answered, message }),
            peerReplyCount,
          );
        }

        const agent = input.agent;

        if (!agent) {
          return badInput(peers
            ? 'msg requires a target: `agent` to name an agent, or `event_id` to answer the agent message event you were given.'
            : 'msg requires agent and message');
        }

        // Waking an agent is a spawn-shaped spend; answering an asked question is not.
        spawnGuard();
        const sent = requestedTopic(input);

        if (team && await isSubordinate(agent)) {
          const handoff = await countedMsgSend(
            { action: 'msg', transport: 'subordinate', addressing: 'agent', target: agent, chars: message.length },
            () => team.message({ name: agent, content: message, mode }),
            handoffCount,
          );

          return {
            status: handoff.delivery === 'queued' ? 'queued' : 'delivered',
            agent: input.agent,
            ...renderHandoff(handoff),
          };
        }

        if (peers) {
          return await countedMsgSend(
            { action: 'msg', transport: 'peer', addressing: 'agent', target: agent, chars: message.length },
            () => peers.send({ agent, topic: sent.topic, message, mode }),
            peerSendCount,
          );
        }

        return badInput(`unknown agent "${input.agent}": check the roster with op:"list"`);
      }

      case 'list': {
        // Provenance, not addressing: `knows` includes archived rows; hire and msg route on the active roster.
        if (input.agent && team && await team.knows(input.agent)) {
          return await team.status({ name: input.agent });
        }

        const subordinates = team ? await team.list() : undefined;
        const peerRoster = peers ? await peers.listPeers() : undefined;
        const empty = (subordinates?.length ?? 0) === 0 && (peerRoster?.length ?? 0) === 0;
        const roster: UnifiedRosterResult = {};

        if (subordinates) Object.assign(roster, { subordinates });

        if (peerRoster) Object.assign(roster, { peers: peerRoster });

        if (empty) Object.assign(roster, { note: 'No helper agents yet: create one with op:"hire".' });

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

/** How much further a hire may delegate, said on `hire`. */
export function nestingRoom(delegation: DelegationBudget): string {
  if (delegation.maxDepth > 1) return `A subordinate you hire can hire its own, ${delegation.maxDepth - 1} level(s) further.`;

  return 'A subordinate you hire cannot hire its own.';
}
