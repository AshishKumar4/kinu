/**
 * `agents`: the one delegation tool, its operations as the wired deps offer them (agentsActionsFor), each dispatched
 * with the fields its declaration admitted (`agents-operations.ts`).
 * Swarm call contract: docs/EXPLORATION.md "Presets", "Validity over the resolved configuration",
 * "Accepted and ignored".
 */
import { REAL_CLOCK } from '../types/clock';
import { currentWorkMode, inWorkMode, workModeRefusal } from '../execution/work-mode';
import type { LanguageModel, ModelMessage } from 'ai';
import * as v from 'valibot';
import { AGENTS_OPS, type AgentsOp } from '../operations/agents';
import { SwarmConfigSchema, SwarmObjectiveSchema } from '../tools/swarm-input';
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
import type { BranchContext } from '../types/swarm';
import type { PublishHeadStream } from '../heads/head-stream';
import type { AnnounceHeadActivity } from '../heads/live-journal';
import type { ModelCallSink } from '../events/model-call';
import type { WebSearchProvider } from '../web/index';
import { readStartedSwarmProfile } from '../strategy/swarm-resume';
import {
  SWARM_PRESET_DOCTRINE,
  resolveSwarm, swarmValidity,
  type NamedSwarmPreset, type SwarmInput, type SwarmNodeAssignment,
  type SwarmPreset,
} from '../strategy/swarm';
import {
  tierIdsOf,
  effectiveRoleCatalog,
  resolveTurnProfile,
  type ProfileAuthorityInputs, type ProfileProvenance,
  type ResolvedTurnProfile, type ResolveTurnProfileInput, type RoleId, type TierId,
} from '../profiles';
import { VERIFIER_KIND_DOC, VERIFIER_KINDS } from '../strategy/objective';
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
  type SubordinateLifetime,
  type TemporaryAgentPort,
  type TemporaryRunRequest,
} from '../subordinates/temporary';
import {
  parseJsonObject,
  type JsonObject, type JsonValue,
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
    /** The words the owner opened it with: they name it, and its mission stays the creator's. */
    brief?: string;
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

/** What wires each operation; a search needs exactly the exploration substrate, so it has no deps group of its own. */
const OFFERED_WHEN = {
  swarm: (deps) => deps.swarm !== undefined && deps.swarms,
  hire: (deps) => deps.team !== undefined,
  assign: (deps) => deps.team !== undefined || deps.peers !== undefined,
  hireWorkspace: (deps) => deps.peers !== undefined,
  message: (deps) => deps.team !== undefined || deps.peers !== undefined,
  reply: (deps) => deps.peers !== undefined,
  list: (deps) => deps.team !== undefined || deps.peers !== undefined,
  dismiss: (deps) => deps.team !== undefined,
} as const satisfies Record<AgentsOp, (deps: AgentsWiring) => boolean>;

/** The deps an operation's presence reads, presence-typed so prompt assembly need not build the substrate. */
interface AgentsWiring {
  readonly swarm?: object;
  readonly swarms: boolean;
  readonly team?: object;
  readonly peers?: object;
}

/** The operations this deps set offers: the one gate shared by the tool, the prompt's Delegation section and
 *  `agents.*` codemode. */
export function agentsActionsFor(deps: AgentsWiring): AgentsOp[] {
  return AGENTS_OPS.filter((op) => OFFERED_WHEN[op](deps));
}

/** The deps with the substrate withheld while the account's swarms are off, so every rendering omits `swarm`. */
export function offered(deps: AgentsToolDeps): AgentsToolDeps {
  return deps.swarms ? deps : { ...deps, swarm: undefined };
}

/** A search's fields, as `agents.swarm` admits them. */
interface SwarmFields {
  /** What the search is for, in prose; never the measured quantity. */
  readonly task: string;
  readonly preset?: SwarmPreset;
  /** What is measured, in what unit, and which direction is better: its wire form, which the search reads. */
  readonly objective?: JsonValue;
  readonly key?: string;
  /** Its wire form too: preset "custom"'s axes. */
  readonly config?: JsonValue;
  readonly from?: NamedSwarmPreset;
  readonly label?: string;
  readonly name?: string;
  readonly branches?: number;
  readonly depth?: number;
  /** Exclusive with `branches`; see {@link SwarmInput.nodes}. */
  readonly nodes?: readonly SwarmNodeAssignment[];
  /** Exclusive with `tier`; see {@link SwarmInput.models}. */
  readonly models?: readonly string[];
  readonly role?: RoleId;
  readonly tier?: TierId;
  /** Cumulative spend caps for everything the search spawns; they nest under the caller's mission scope. */
  readonly budgetUsd?: number;
  readonly budgetTokens?: number;
  readonly budgetLabel?: string;
}

/** A new helper's fields, as `agents.hire` admits them. */
interface HireFields {
  readonly role: RoleId;
  readonly mission: string;
  readonly name?: string;
  /** Explicit, else the role's default tier. */
  readonly tier?: TierId;
  readonly context?: BranchContext;
  /** `durable` (default) stays in the roster; `task` answers once and is archived. */
  readonly lifetime?: SubordinateLifetime;
}

/** An existing agent's next workstream, as `agents.assign` admits it. */
interface AssignFields {
  readonly agent: string;
  readonly message: string;
  readonly deliverable?: string;
  readonly topic?: string;
}

interface HireWorkspaceFields {
  readonly mission: string;
  readonly message: string;
  readonly agent?: string;
}

interface MessageFields {
  readonly agent: string;
  readonly message: string;
  readonly topic?: string;
}

interface ReplyFields {
  readonly eventId: string;
  readonly message: string;
}

interface ListFields {
  readonly agent?: string;
}

interface DismissFields {
  readonly agent: string;
  readonly keepHistory?: boolean;
}

/** One served operation's call, with the fields its declaration admitted: the dispatcher reads these and no others. */
export type AgentsCall =
  | { readonly op: 'swarm'; readonly fields: SwarmFields }
  | { readonly op: 'hire'; readonly fields: HireFields }
  | { readonly op: 'assign'; readonly fields: AssignFields }
  | { readonly op: 'hireWorkspace'; readonly fields: HireWorkspaceFields }
  | { readonly op: 'message'; readonly fields: MessageFields }
  | { readonly op: 'reply'; readonly fields: ReplyFields }
  | { readonly op: 'list'; readonly fields: ListFields }
  | { readonly op: 'dismiss'; readonly fields: DismissFields };

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
  fields: SwarmFields,
): { governor: MissionGovernor; scope: MissionScope } | null {
  if (!budget) return null;
  const limits = readMissionLimits({ budget_usd: fields.budgetUsd, budget_tokens: fields.budgetTokens });
  let labels: readonly string[] = budget.scope;

  if (limits) {
    // A blank label names no sub-ledger; the generated one keeps it addressable.
    const declared = fields.budgetLabel?.trim();
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

interface AgentsActionCall<F> {
  deps: AgentsToolDeps;
  fields: F;
  mode: WorkMode;
  toolOptions: AgentsToolCallOptions | undefined;
}

/** The exploration substrate for `swarm`; re-checked because the type does not carry the enum gate. */
function swarmSubstrate(deps: AgentsToolDeps): AgentsSwarmDeps {
  const swarm = deps.swarm;

  if (!swarm) throw new KinuError('unsupported', 'this actor wires no exploration substrate, so `swarm` has nothing to run');

  return swarm;
}

/** A field the operation checked against `schema` and passed on as sent, read as the search takes it. */
function readWireForm<S extends v.GenericSchema>(schema: S, sent: JsonValue | undefined): v.InferOutput<S> | undefined {
  return sent === undefined ? undefined : v.parse(schema, sent);
}

interface SwarmActionCall extends AgentsActionCall<SwarmFields> {
  budget?: MissionGovernor;
}

async function runSwarmAction({ deps, fields, mode, toolOptions, budget }: SwarmActionCall): Promise<object> {
  const swarm = swarmSubstrate(deps);

  // A re-drive replays its stored profile snapshot and never consults today's catalog. Read from the
  // options bag (see `RESUME_REDRIVE_OPTION`): the fields are the durable row.
  const redrive = readResumeRedrive({ toolOptions });

  if (!redrive && !fields.preset && !deps.profile) {
    return badInput(`swarm needs \`preset\`: the shape of the search${deps.profile ? '' : ' (no role catalog is wired here to take its default from)'}. ${SWARM_PRESET_DOCTRINE.join(' ')}`);
  }

  if (!fields.task) {
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
        fields.role,
        fields.tier,
        fields.preset === undefined ? 'role_default' : 'explicit',
      );

      if ('error' in resolution) return badInput(resolution.error);
      delegated = resolution;
    } else if (fields.role !== undefined || fields.tier !== undefined) {
      return badInput('role and tier need a profile catalog, which this actor does not have: '
        + 'call again without them.');
    }
  }

  // A re-drive with no preset is not `ideate`: its first attempt may have used the role's default, so
  // the preset comes off the same stored record as role, tier and model.
  const started = redrive && fields.preset === undefined
    ? readStartedSwarmProfile(swarm.rt.storage, swarm.rt.actor, fields.task)
    : null;

  const preset: SwarmPreset = fields.preset
    ?? delegated?.resolved.defaultPreset
    ?? started?.profile.defaultPreset
    ?? 'ideate';

  // `tier` and `models` are exclusive routing inputs.
  if (fields.models !== undefined && fields.tier !== undefined) {
    return badInput('`models` routes each node to the model its slot is assigned, and `tier` '
      + `resolves one model for the whole run: you named both (tier "${String(fields.tier)}" and `
      + `${String(fields.models.length)} model spec(s)), and one of the two routing decisions would `
      + 'be ignored. Route through `tier` for one model across the search, or through `models` '
      + 'for per-node routing.');
  }

  const call: SwarmInput = {
    preset,
    task: fields.task,
    objective: readWireForm(SwarmObjectiveSchema, fields.objective),
    key: fields.key,
    config: readWireForm(SwarmConfigSchema, fields.config),
    from: fields.from,
    label: fields.label,
    branches: fields.branches,
    depth: fields.depth,
    name: fields.name,
    nodes: fields.nodes,
    models: fields.models,
  };

  // Resolution first: *Validity over the resolved configuration* is stated over the resolved tuple.
  const resolved = resolveSwarm(call);

  if ('reason' in resolved) throw new KinuError(resolved.reason, resolved.error);
  const illegal = swarmValidity(resolved);

  if (illegal) throw new KinuError(illegal.reason, illegal.error);

  const mission = missionScope(budget, fields);
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

/** The peer topic for an assignment or a message, or a refusal when the caller claimed the transport's reserved one. */
function requestedTopic(requested: string | undefined): { topic: string } {
  const trimmed = requested?.trim();
  // A blank topic is no topic: the default is what the transport routes on.
  const topic = trimmed === undefined || trimmed === '' ? 'message' : trimmed;

  return topic === PEER_REPLY_TOPIC
    ? badInput(`topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes`)
    : { topic };
}

/** The refusal of a `swarm` the account's beta withholds; null when the beta is not what stops it. */
export function withheldBeta(wired: AgentsToolDeps, op: AgentsOp): string | null {
  if (op !== 'swarm' || wired.swarm === undefined || wired.swarms) return null;

  return `swarm is a beta this account has not turned on: "${SWARMS_BETA_SETTING}" in Settings, Beta`;
}

/** Plan keeps what changes no roster: a search, a message, a reply and the roster read. `hire` is decided in its arm,
 *  since Plan permits a `task` hire. */
const PLAN_KEEPS = {
  swarm: true, hire: true, assign: false, hireWorkspace: false, message: true, reply: true, list: true, dismiss: false,
} as const satisfies Record<AgentsOp, boolean>;

/** Whether this actor may run the operation now: unwired is `unsupported`, a durable roster change under Plan is
 *  `denied`, as is a search the account's beta withholds. */
function opAdmission(offeredOps: readonly AgentsOp[], mode: WorkMode, op: AgentsOp, beta: string | null): Refusal | null {
  if (beta !== null) return { reason: 'denied', error: beta };

  if (!offeredOps.includes(op)) {
    return { reason: 'unsupported', error: `agents.${op} is not available here. Available: ${offeredOps.join(', ')}` };
  }

  return workModeRefusal(mode, PLAN_KEEPS[op], 'agents.' + op);
}

/** A new workspace, which only the orchestrator's peer seam may open. */
interface WorkspaceHireCall extends AgentsActionCall<HireWorkspaceFields> {
  spawnDepthRefusal: () => { reason: ErrorCode; error: string } | null;
}

async function hireWorkspace({ deps, fields, mode, toolOptions, spawnDepthRefusal }: WorkspaceHireCall): Promise<object> {
  const peers = deps.peers;
  const workspaceDepth = spawnDepthRefusal();

  if (workspaceDepth) throw new KinuError(workspaceDepth.reason, workspaceDepth.error);

  // Classified: a fresh workspace escapes the depth cap, so this refusal must land in `refused`.
  if (!peers) {
    throw new KinuError('denied', 'agents.hireWorkspace creates a whole workspace, which only the workspace orchestrator may do: '
      + 'hire a subordinate here instead, or run a search.');
  }

  const request: Parameters<PeersToolDeps['spawnWorkspace']>[0] = {
    purpose: fields.mission,
    message: fields.message,
    mode,
  };

  if (fields.agent) Object.assign(request, { name: fields.agent });

  if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });

  return await peers.spawnWorkspace(request);
}

interface CreateHireCall extends Omit<AgentsActionCall<HireFields>, 'toolOptions'> {
  team: TeamToolDeps;
  lifetime: SubordinateLifetime;
}

async function hireCreate({ deps, team, fields, mode, lifetime }: CreateHireCall): Promise<object> {
  const ctx = deps.profile?.();

  if (!ctx) {
    throw new KinuError('denied', 'This actor wires no role catalog. Hire cannot resolve a role without one.');
  }

  const inheritedContext = fields.context === 'inherit'
    ? [...freezeInheritedContext(await team.inheritedContext?.()
      ?? badInput('context:"inherit" requires this actor\'s parent-conversation source'))]
    : undefined;

  if (lifetime === 'task') {
    if (fields.name !== undefined) {
      return badInput('field "name" is not available on a lifetime:"task" hire: it is archived the '
        + 'moment it answers, so a name you chose is never addressable. Omit it, or hire `durable`.');
    }

    if (fields.tier !== undefined) {
      return badInput('field "tier" is not available on a lifetime:"task" hire: it runs at its role\'s tier; omit it, or hire `durable` for an override');
    }

    const temporary = team.temporary;

    if (!temporary) {
      throw new KinuError('denied', 'lifetime:"task" needs a task-agent substrate, which this actor has none of: '
        + 'omit `lifetime` for a durable hire, or hand the work to an existing agent with op:"assign" (op:"list" shows the roster).');
    }

    const delegatedTask = resolveDelegatedProfile(ctx, fields.role, undefined);

    if ('error' in delegatedTask) return badInput(delegatedTask.error);

    const request: TemporaryRunRequest = {
      role: delegatedTask.resolved.role.id,
      roleLabel: fields.role,
      task: fields.mission,
      mode,
    };

    if (inheritedContext !== undefined) Object.assign(request, { inheritedContext });

    return await temporary.start(request);
  }

  const delegated = resolveDelegatedProfile(ctx, fields.role, fields.tier);

  if ('error' in delegated) return badInput(delegated.error);
  // Only an explicit tier is stored; the child re-derives its role's default.
  const resolvedTier = fields.tier !== undefined ? delegated.resolved.tier : undefined;

  const request: Parameters<TeamToolDeps['spawn']>[0] = {
    role: delegated.resolved.role.id,
    mission: fields.mission,
    mode,
  };

  if (inheritedContext !== undefined) Object.assign(request, { inheritedContext });

  if (resolvedTier !== undefined) Object.assign(request, { tier: resolvedTier.id });

  if (fields.name) Object.assign(request, { name: fields.name });

  return await team.spawn(request);
}

interface RosterCall {
  readonly mode: WorkMode;
  readonly toolOptions: AgentsToolCallOptions | undefined;
  readonly spawnGuard: () => void;
  readonly isSubordinate: (name: string) => Promise<boolean>;
}

/** An existing agent's next workstream: a subordinate's reports later, a peer's reply is awaited. Spends no depth. */
async function assignWork(deps: AgentsToolDeps, fields: AssignFields, { mode, toolOptions, isSubordinate }: RosterCall): Promise<object> {
  const { team, peers } = deps;
  const asked = requestedTopic(fields.topic);

  if (team && await isSubordinate(fields.agent)) {
    const assignment: Parameters<TeamToolDeps['assign']>[0] = { name: fields.agent, task: fields.message, mode };

    if (fields.deliverable) Object.assign(assignment, { deliverable: fields.deliverable });

    const handoff = await countedMsgSend(
      { action: 'assign', transport: 'subordinate', addressing: 'agent', target: fields.agent, chars: fields.message.length },
      () => team.assign(assignment),
      handoffCount,
    );

    return {
      status: 'working',
      agent: fields.agent,
      ...renderHandoff(handoff),
      note: `${ASSIGN_NOTES[handoff.delivery]} The subordinate's report arrives as an event that wakes you, citing ${handoff.eventId}.`,
    };
  }

  if (peers) {
    const request: Parameters<PeersToolDeps['ask']>[0] = { agent: fields.agent, topic: asked.topic, message: fields.message, mode };

    if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });

    return await countedMsgSend(
      { action: 'assign', transport: 'peer', addressing: 'agent', target: fields.agent, chars: fields.message.length },
      () => peers.ask(request),
      peerAskCount,
    );
  }

  return badInput(`unknown agent "${fields.agent}": check the roster with op:"list"`);
}

/** A message to an agent, with no workstream handed over. Waking an agent is a spawn-shaped spend. */
async function messageAgent(deps: AgentsToolDeps, fields: MessageFields, { mode, spawnGuard, isSubordinate }: RosterCall): Promise<object> {
  const { team, peers } = deps;
  const { agent, message } = fields;

  spawnGuard();
  const sent = requestedTopic(fields.topic);

  if (team && await isSubordinate(agent)) {
    const handoff = await countedMsgSend(
      { action: 'message', transport: 'subordinate', addressing: 'agent', target: agent, chars: message.length },
      () => team.message({ name: agent, content: message, mode }),
      handoffCount,
    );

    return { status: handoff.delivery === 'queued' ? 'queued' : 'delivered', agent, ...renderHandoff(handoff) };
  }

  if (peers) {
    return await countedMsgSend(
      { action: 'message', transport: 'peer', addressing: 'agent', target: agent, chars: message.length },
      () => peers.send({ agent, topic: sent.topic, message, mode }),
      peerSendCount,
    );
  }

  return badInput(`unknown agent "${agent}": check the roster with op:"list"`);
}

/** The roster, or one agent's status: provenance, not addressing, so `knows` includes archived rows. */
async function roster(deps: AgentsToolDeps, fields: ListFields): Promise<object> {
  const { team, peers } = deps;

  if (fields.agent && team && await team.knows(fields.agent)) return await team.status({ name: fields.agent });

  const subordinates = team ? await team.list() : undefined;
  const peerRoster = peers ? await peers.listPeers() : undefined;
  const empty = (subordinates?.length ?? 0) === 0 && (peerRoster?.length ?? 0) === 0;
  const listed: UnifiedRosterResult = {};

  if (subordinates) Object.assign(listed, { subordinates });

  if (peerRoster) Object.assign(listed, { peers: peerRoster });

  if (empty) Object.assign(listed, { note: 'No helper agents yet: create one with op:"hire".' });

  return listed;
}

/** The operations that create or wake an agent, checked against the mission cap before they run. */
const SPAWNING: ReadonlySet<AgentsOp> = new Set(['swarm', 'hire', 'assign', 'hireWorkspace']);

/** The one delegation dispatch, for the `agents` tool and `agents.*` codemode, over each operation's own fields. Only
 *  `toolOptions.abortSignal` is read. */
export async function dispatchAgentsCall(
  deps: AgentsToolDeps,
  call: AgentsCall,
  toolOptions?: AgentsToolCallOptions,
): Promise<object> {
  // A withheld swarm is refused at admission, so its arm never reads the substrate.
  const offeredOps = agentsActionsFor(offered(deps));
  const mode = inWorkMode(deps.mode, currentWorkMode);
  const { team, peers } = deps;

  // No catch: a roster read failure must reach the caller, not route the assignment to the peer path.
  const isSubordinate = async (name: string): Promise<boolean> => {
    if (!team) return false;

    return (await team.list()).some((entry) => entry.name === name);
  };

  // An operation this actor does not wire: `unsupported` (obs/error.ts), classified so it counts as refused.
  const admission = opAdmission(offeredOps, mode, call.op, withheldBeta(deps, call.op));

  if (admission) throw new KinuError(admission.reason, admission.error);

  // Spawn seam: check the mission cap before any operation that creates or wakes an agent.
  const spawnGuard = () => {
    const refusal = deps.budget?.guard('spawn');

    if (refusal) throw new MissionBudgetExhausted(refusal);
  };

  if (SPAWNING.has(call.op)) spawnGuard();

  // Depth seam: covers a toolset cached before the identity was seeded. An assignment to an existing agent is not a
  // spawn and stays available.
  const spawnDepthRefusal = () =>
    team && delegationExhausted(team.delegation) ? delegationDepthRefusal(team.delegation) : null;

  const rosterCall: RosterCall = { mode, toolOptions, spawnGuard, isSubordinate };

  try {
    switch (call.op) {
      case 'swarm':
        return await runSwarmAction({ deps, fields: call.fields, mode, toolOptions, budget: deps.budget });

      case 'hire': {
        // Plan bars a durable roster change but keeps a `task` hire.
        const lifetime = call.fields.lifetime ?? 'durable';
        const planBar = workModeRefusal(mode, lifetime === 'task', 'agents.hire');

        if (planBar) throw new KinuError(planBar.reason, planBar.error);
        const createDepth = spawnDepthRefusal();

        if (createDepth) throw new KinuError(createDepth.reason, createDepth.error);

        // Capability absence is `denied`; admission already holds `hire` to a wired team.
        if (!team) throw new KinuError('denied', 'hiring subordinates is not available on this actor');

        return await hireCreate({ deps, team, fields: call.fields, mode, lifetime });
      }

      case 'assign':
        return await assignWork(deps, call.fields, rosterCall);

      case 'hireWorkspace':
        return await hireWorkspace({ deps, fields: call.fields, mode, toolOptions, spawnDepthRefusal });

      case 'message':
        return await messageAgent(deps, call.fields, rosterCall);

      case 'reply': {
        if (!peers) throw new KinuError('denied', 'answering an event needs the peer transport, which this actor does not have');
        const { eventId, message } = call.fields;

        return await countedMsgSend(
          { action: 'reply', transport: 'peer', addressing: 'event', target: eventId, chars: message.length },
          () => peers.reply({ eventId, message }),
          peerReplyCount,
        );
      }

      case 'list':
        return await roster(deps, call.fields);

      case 'dismiss':
        if (!team) throw new KinuError('denied', 'dismiss applies to subordinates, which this actor does not have');

        return await team.dismiss({ name: call.fields.agent, keepHistory: call.fields.keepHistory ?? true });
    }
  } catch (err) {
    if (err instanceof KinuError) throw err;
    const failure = toKinuError({ doing: 'agents.' + call.op, cause: err, otherwise: 'io' });
    failure.message = renderThrownChain({ cause: failure });
    throw failure;
  }
}

/** How much further a hire may delegate, said on `hire`. */
export function nestingRoom(delegation: DelegationBudget): string {
  if (delegation.maxDepth > 1) return `A subordinate you hire can hire its own, ${delegation.maxDepth - 1} level(s) further.`;

  return 'A subordinate you hire cannot hire its own.';
}
