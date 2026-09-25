/**
 * `agents`: the one delegation tool. Actions: swarm (configured search over ephemeral nodes), hire
 * (`lifetime` durable|task, an existing `agent`, or scope=workspace), msg, list, dismiss.
 * Which actions exist follows the wired deps (agentsActionsFor).
 * Swarm call contract: docs/EXPLORATION.md "Presets", "Validity over the resolved configuration",
 * "Accepted and ignored".
 */
import { REAL_CLOCK } from '../types/clock';
import { tool, jsonSchema } from 'ai';
import { currentWorkMode, inWorkMode, permitInPlan, workModeRefusal } from '../execution/work-mode';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import {
  AGENTS_TOOL_ACTIONS,
  AGENTS_TOOL_NOTES,
  BUILTIN_TOOL_SPECS,
  renderToolSchemaDescription,
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
  TIER_IDS, TierIdSchema, tierIdsOf,
  effectiveRoleCatalog,
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
import type { HostedNodeSeat, NodeCodemode } from '../strategy/node-agent';
import type { AgentRuntime } from '../types/agent-runtime';
import type { CostModel } from '../mcts/cost';
import type { WorkMode } from '../types/turn';
import { nanoid } from '../utils/nanoid';
import { diagnostics, KinuError, renderThrownChain, toKinuError, type ErrorCode, type Refusal } from '../obs/index';
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
  createdBy: 'orchestrator' | 'user';
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
  }>;
  /**
   * The `lifetime:'task'` half of `hire`: runs one child to completion inside the call and archives its
   * row on answer. Required wherever a child substrate is wired; unwired, `hire` has no `lifetime` field
   * and every hire is durable.
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
  model: LanguageModel;
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
  originContext?: () => readonly ModelMessage[];
  /** Pricing for projected-spend gates; absent, the gate blends and says so. */
  costModel?: () => CostModel;
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
}

/** Inputs for role/tier/preset precedence, wired under {@link AgentsToolDeps.profile}. */
export interface AgentsProfileContext extends ProfileAuthorityInputs {
  readonly roleId: RoleId;
  readonly availableTools: readonly string[];
}

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
  /** Trusted, host-owned turn mode; never in the model schema, so a child cannot opt out of a Plan
   *  turn's mutation bar. */
  mode: WorkMode;
  /** The exploration substrate; its presence puts `swarm` in this actor's enum. */
  swarm?: AgentsSwarmDeps;
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
export function agentsActionsFor(deps: { swarm?: object; team?: object; peers?: object }): AgentsToolAction[] {
  const converse = deps.team !== undefined || deps.peers !== undefined;

  const present = {
    // A search needs exactly the exploration substrate, so it has no deps group of its own.
    swarm: deps.swarm !== undefined,
    hire: converse,
    msg: converse,
    list: converse,
    dismiss: deps.team !== undefined,
  } satisfies Record<AgentsToolAction, boolean>;

  return AGENTS_TOOL_ACTIONS.filter((action) => present[action]);
}

/** The spec's notes an actor's wiring can act on: a description never promises an unwired action. */
export function renderAgentsToolDescription(deps: AgentsToolDeps): string {
  const converse = deps.team !== undefined || deps.peers !== undefined;

  const notes = [
    ...(deps.swarm ? [AGENTS_TOOL_NOTES.swarm] : []),
    ...(converse ? [AGENTS_TOOL_NOTES.hire] : []),
    ...(deps.team?.temporary ? [AGENTS_TOOL_NOTES.task] : []),
    ...(converse ? [AGENTS_TOOL_NOTES.converse] : []),
    ...(deps.peers ? [AGENTS_TOOL_NOTES.peers] : []),
  ];

  return renderToolSchemaDescription({ ...BUILTIN_TOOL_SPECS.agents, notes });
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

const fieldsOf = (action: AgentsToolAction): readonly string[] => AGENTS_ACTION_FIELDS[action];

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

/** Codemode declaration type per input field; a new field without an entry fails to compile. */
export const AGENTS_FIELD_TS_TYPES = {
  context: `"${SWARM_CONTEXTS.join('" | "')}"`,
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
  tier: 'string',
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

/** Fields each action's caller must supply; dispatch arms re-check them because the sandbox parse cannot. */
export const AGENTS_ACTION_REQUIRED_FIELDS = {
  swarm: ['task'],
  // The create variant, which a bare `hire` means; read only by the single-variant path.
  hire: ['role', 'mission'],
  msg: ['message'],
  list: [],
  dismiss: ['agent'],
} as const satisfies Record<AgentsToolAction, readonly AgentsToolInputField[]>;

/** Creating a helper: `lifetime` only where the task port is wired, `scope` only beside `peers`. */
const HIRE_CREATE_FIELDS = [
  'role', 'mission', 'agent', 'tier', 'context',
] as const satisfies readonly AgentsToolInputField[];

const HIRE_WORKSPACE_FIELDS = [
  'agent', 'mission', 'scope', 'message',
] as const satisfies readonly AgentsToolInputField[];

/** An existing agent; selected by the absence of `role`. */
const HIRE_EXISTING_FIELDS = [
  'agent', 'message',
] as const satisfies readonly AgentsToolInputField[];

export interface AgentsActionInputVariant {
  readonly required: readonly AgentsToolInputField[];
  readonly fields: readonly AgentsToolInputField[];
  readonly scope?: 'subordinate' | 'workspace';
  readonly scopeOptional?: boolean;
  /** Fields that must be absent for this variant: the XOR between targets with no discriminant field.
   *  The schema states it; the dispatch enforces it. */
  readonly excludes?: readonly AgentsToolInputField[];
}

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

function hireInputVariants(deps: AgentsToolDeps): readonly AgentsActionInputVariant[] {
  const variants: AgentsActionInputVariant[] = [];

  if (deps.team) {
    const fields: AgentsToolInputField[] = [...HIRE_CREATE_FIELDS];

    // Deps-gated like the rung: with no task port, `lifetime` is structurally absent.
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
    // Exclusive with `role`.
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

/** `msg`'s targets, exactly one: `agent`, or the inbound `event_id` (peers only). */
function msgInputVariants(deps: AgentsToolDeps): readonly AgentsActionInputVariant[] {
  const named: AgentsToolInputField[] = ['agent', 'message'];

  if (deps.peers) named.push('topic');

  const byName: AgentsActionInputVariant = {
    fields: named,
    required: ['agent', 'message'],
  };

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

/** Fields one action reads under this actor's transports. */
export function agentsActionFieldsFor(
  deps: AgentsToolDeps,
  action: AgentsToolAction,
): readonly AgentsToolInputField[] {
  const fields = AGENTS_ACTION_FIELDS[action];

  switch (action) {
    case 'swarm':
      return deps.swarm ? fields : [];
    case 'hire':
    case 'msg':
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

      // Exclusivity as JSON Schema: without it a call naming both targets matches both branches.
      if (variant.excludes && variant.excludes.length > 0) {
        Object.assign(branch, {
          not: { anyOf: variant.excludes.map((field) => ({ required: [field] })) },
        });
      }

      return branch;
    }));
}

/** The model-facing parse: `strictObject`, so an unrecognised field (a camelCase cap) is refused, not dropped. */
const AgentsToolInputSchema = v.strictObject(AgentsInputEntries);

/** The replay parse over a durable job row: unknown entries are dropped (logged by `resumableAgentsInput`),
 *  and `action` is a plain string so retired actions can be translated. */
const StoredAgentsInputSchema = v.object({ ...AgentsInputEntries, action: v.string() });

const AGENTS_INPUT_FIELDS: readonly string[] = Object.keys(AgentsInputEntries)
  .filter((field) => field !== 'action');

function actionReads(action: AgentsToolAction, field: string): boolean {
  return fieldsOf(action).some((declared) => declared === field);
}

const MAX_FIELD_EDIT_DISTANCE = 2;

/** Normalizes naming convention so `budgetUsd`, `budget-usd` and `Budget USD` reach `budget_usd`. */
const FIELD_NAME_SEPARATORS = /[^a-z0-9]/gi;

/** Levenshtein distance, abandoned once a row exceeds `limit`; returns `limit + 1` for "too far". */
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

/** The field `name` was probably meant to be (convention, then one or two edits), or undefined. */
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

const FieldNamesSchema = v.record(v.string(), v.unknown());

function fieldNames(value: JsonValue): readonly string[] {
  const parsed = v.safeParse(FieldNamesSchema, value);

  return parsed.success ? Object.keys(parsed.output) : [];
}

const FIELD_RULE = 'A field the called action cannot act on is refused rather than dropped — a cap'
  + ' that never reached the run is a cap that was never applied.';

function takesSentence(action: AgentsToolAction): string {
  return `action "${action}" takes: ${fieldsOf(action).join(', ')}.`;
}

function fieldsSentence(action: AgentsToolAction | undefined): string {
  if (action) return ` ${takesSentence(action)}`;

  return ` Fields are: ${AGENTS_INPUT_FIELDS.join(', ')}.`;
}

/**
 * What is wrong with the field names of `input` (unknown, or misplaced for the called action), or
 * undefined. Runs ahead of the strict schemas, which still refuse anything this misses.
 */
function agentsFieldRefusal(call: { input: unknown }): string | undefined {
  const parsed = v.safeParse(FieldNamesSchema, call.input);

  if (!parsed.success) return undefined;
  const declared = v.safeParse(v.picklist(AGENTS_TOOL_ACTIONS), parsed.output['action']);
  const action = declared.success ? declared.output : undefined;
  const problems: string[] = [];
  // Printed once at the end so the field list is not repeated per clause.
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
  const fields = listFields ? fieldsSentence(action) : '';

  return `${problems.join(' ')}${fields} ${FIELD_RULE}`;
}

/** The one parse for the `agents` tool and its codemode namespace. */
export function parseAgentsToolInput(call: { input: unknown }): AgentsToolInput {
  const refusal = agentsFieldRefusal(call);

  if (refusal) throw new Error(refusal);

  return v.parse(AgentsToolInputSchema, call.input);
}

type StoredAgentsRow = v.InferOutput<typeof StoredAgentsInputSchema>;

/** Fields a translated row must not carry: `preset` is fixed to `ideate`, and there is no `objective`. */
const TRANSLATION_DECIDES = { preset: true, objective: true } satisfies Record<string, true>;

function swarmFieldsOf(row: StoredAgentsRow, skip: Record<string, true>): Partial<AgentsToolInput> {
  const carried: Partial<AgentsToolInput> = {};

  for (const field of AGENTS_ACTION_FIELDS.swarm) {
    if (Object.hasOwn(skip, field)) continue;
    const value = row[field];

    if (value !== undefined) Object.assign(carried, { [field]: value });
  }

  return carried;
}

/** What the re-drive lost, named per field; `extra` covers the row's settlement, which a swarm cannot carry. */
function recordDroppedFields(
  kind: string,
  input: JsonValue,
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
 * Background-job resume filter and detach gate (orchestrator/background-tools.ts): a call that cannot be
 * re-driven must never be detached. Returns the input to re-execute, or null.
 * Stored rows are translated, not validated: `action:'fork'` re-drives as `preset:'ideate'`, `settle` is
 * reported as unsupported, and `config.context:'fork'` becomes `inherit`; each loss is logged.
 */
/** Rewrite a stored row's retired `config.context` value; runs before the replay parse. */
const StoredSwarmContextSchema = v.looseObject({
  config: v.optional(v.looseObject({ context: v.optional(v.string()) })),
});

type StoredSwarmContext = v.InferOutput<typeof StoredSwarmContextSchema>;

function translateStoredSwarmContext(row: StoredSwarmContext): StoredSwarmContext {
  if (row.config?.context !== 'fork') return row;

  return { ...row, config: { ...row.config, context: 'inherit' } };
}

export function resumableAgentsInput(kind: string, input: JsonValue): AgentsToolInput | null {
  if (kind !== 'agents') return null;
  const rewritten = v.safeParse(StoredSwarmContextSchema, input);
  const parsed = v.safeParse(StoredAgentsInputSchema, rewritten.success ? translateStoredSwarmContext(rewritten.output) : input);

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
    return { error: `unknown active role ${JSON.stringify(ctx.roleId)} — it is not in this `
      + 'account\'s catalog; ask the owner to fix the catalog or pick an explicit role.' };
  }

  const spawns = callerRole.spawns;

  // Absent `spawns` inherits everything; '*' is the wildcard; a caller may always use its own role.
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
    return badInput(`swarm needs \`preset\` — the shape of the search${deps.profile ? '' : ' (no role catalog is wired here to take its default from)'}. ${SWARM_PRESET_DOCTRINE.join(' ')}`);
  }

  if (!input.task) {
    return badInput('swarm needs `task` — what the search is for, in prose. The measured '
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
      return badInput('role and tier need a profile catalog, which this actor does not have — '
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
      + `resolves one model for the whole run — you named both (tier "${String(input.tier)}" and `
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
  const origin = swarm.originContext?.();
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

/** JSON-Schema properties an action may advertise, derived from AGENTS_ACTION_FIELDS. */
type SchemaPropertiesFor<Action extends AgentsToolAction> =
  { [Field in (typeof AGENTS_ACTION_FIELDS)[Action][number]]?: JsonObject };

type SwarmSchemaProperties = SchemaPropertiesFor<'swarm'>;

/** The roles this actor may name, `id: description`; empty with no catalog. */
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
    .map(([id, role]) => `${id}: ${role.description}`)
    .join('; ');
}

function tierIds(deps: AgentsToolDeps): TierId[] {
  const ctx = deps.profile?.();

  return ctx ? tierIdsOf(ctx.envelope.catalog) : [...TIER_IDS];
}

/** Registered instruments with their `spec` keys, from `VERIFIER_KIND_DOC`, so the schema matches `swarmValidity`. */
function verifierKinds(): string {
  return VERIFIER_KINDS.map((kind) => `${kind} (spec {${VERIFIER_KIND_DOC[kind].specFields.join(', ')}})`).join(', ');
}

/** `role` and `tier` serve swarm and hire under one key each, so one description states both. */
function roleProperties(deps: AgentsToolDeps): Pick<SchemaPropertiesFor<'swarm'>, 'role' | 'tier'> {
  const uses = [
    ...(deps.team ? ['for hire, the one to create the helper under'] : []),
    ...(deps.swarm ? ['for swarm, the one every node runs under (default: yours)'] : []),
  ].join('; ');

  const roles = roleSummaries(deps);

  return {
    role: { type: 'string', maxLength: 64, description: `Catalog role id: ${uses}.${roles ? ` Roles: ${roles}.` : ''}` },
    tier: { type: 'string', enum: tierIds(deps), description: 'Inference tier; default: the role\'s. A lifetime:"task" hire refuses it.' },
  };
}

function swarmProperties(deps: AgentsToolDeps): SwarmSchemaProperties {
  if (!deps.swarm) return {};

  return {
    task: { type: 'string', description: 'For swarm: what the search is for, stated once for every node. The measured quantity goes in `objective`.' },
    preset: { type: 'string', enum: [...SWARM_PRESETS], description: `For swarm: the search's shape. ${SWARM_PRESET_DOCTRINE.join(' ')}` },
    objective: {
      type: 'object',
      description: 'For swarm, optional: what a verifier measures, which turns the judged sweep into a measured search. '
        + '{kind:"scalar", metric, unit, direction:"minimise"|"maximise", scale:"linear"|"log", target, verify:{kind, spec}}, '
        + 'optionally floor:{value, kind:"certificate", proof, best_known_honest}. '
        + `verify.kind is a registered instrument: ${verifierKinds()}. `
        + 'kind "instanced" (one metric over `instances`) and "vector" (several `components`) need advance:"pareto"; kind "witness" needs a scalar `proxy`.',
    },
    key: { type: 'string', description: 'For swarm with advance:"archive", where it is required: the quantity elites are binned by, one the objective\'s verifier reports.' },
    config: { type: 'object', description: 'For swarm with preset:"custom" only: the axes unit, context, expand, score, advance and carry, overriding `from`\'s or all six without it.' },
    from: { type: 'string', enum: [...NAMED_SWARM_PRESETS], description: 'For swarm with preset:"custom": the named preset whose axes `config` overrides.' },
    label: { type: 'string', maxLength: 120, description: 'For swarm with preset:"custom", required: a name for the composed shape.' },
    name: { type: 'string', maxLength: 60, description: 'For swarm: a two-to-four-word name for the search; default: derived from `task`.' },
    branches: { type: 'integer', minimum: 1, description: 'For swarm: candidates per expansion; default: the preset\'s. Not with `nodes`.' },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', minLength: 1, description: 'This node\'s own question, distinct from the others\'.' },
          prompt: { type: 'string', minLength: 1, description: 'The brief this node works under.' },
        },
        required: ['task', 'prompt'],
      },
      description: 'For swarm: the first level, one entry per node; its length is the branch count. Not with `branches`.',
    },
    models: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      description: 'For swarm: model specs, node i runs models[i % length]. Route for capability or cost, not for variety. Not with `tier`.',
    },
    depth: { type: 'integer', minimum: 1, description: 'For swarm: maximum tree depth; default: the preset\'s. advance:"none" fixes it at 1.' },
    ...roleProperties(deps),
    budget_usd: { type: 'number', minimum: 0, description: 'For swarm: USD cap on everything the search spawns; default: none.' },
    budget_tokens: { type: 'integer', minimum: 1, description: 'For swarm: token cap, same scope as budget_usd.' },
    budget_label: { type: 'string', maxLength: 120, description: 'For swarm: a ledger name, so several calls share one budget.' },
  };
}

type ConverseSchemaProperties = SchemaPropertiesFor<Exclude<AgentsToolAction, 'swarm'>>;

function converseTargets(deps: AgentsToolDeps): string {
  if (deps.team && deps.peers) {
    return 'a subordinate here or a peer workspace agent (a subordinate wins a name collision)';
  }

  if (deps.team) return 'a subordinate';

  return 'a peer workspace agent';
}

function converseProperties(deps: AgentsToolDeps): ConverseSchemaProperties {
  if (!deps.team && !deps.peers) return {};

  const properties: ConverseSchemaProperties = {
    agent: {
      type: 'string',
      description: `Agent name, ${converseTargets(deps)}. On hire without \`role\`, the existing agent that takes the workstream; with \`role\`, an optional name for the new one. The target of msg and dismiss; filters list.`,
    },
    mission: { type: 'string', maxLength: 20000, description: 'For hire with `role`: the brief, run as the new agent\'s first turn; for lifetime:"task", the whole question.' },
    message: { type: 'string', maxLength: 20000, description: 'The work for a hire of an existing `agent`, the text of a msg, or the first task of a scope:"workspace" hire.' },
  };

  if (deps.peers) {
    Object.assign(properties, {
      scope: { type: 'string', enum: ['subordinate', 'workspace'], description: 'For hire: subordinate (default) hires into this workspace; workspace creates or reuses a specialist workspace, sends it `message` and waits for the result.' },
      topic: { type: 'string', maxLength: 80, description: 'A short label for a message to a peer workspace agent; default: "message".' },
      event_id: { type: 'string', description: 'For msg: the incoming agent message you are answering. Not with `agent`.' },
    });
  }

  if (deps.team) {
    Object.assign(properties, {
      context: { type: 'string', enum: [...SWARM_CONTEXTS], description: 'For hire with `role`: fresh (default) starts from the mission and a digest of your recent messages; inherit also carries your recent turns.' },
      ...roleProperties(deps),
      deliverable: { type: 'string', maxLength: 2000, description: 'For a hire of an existing subordinate: what the finished result is.' },
      keep_history: { type: 'boolean', description: 'For dismiss: false deletes its storage for good; default true archives it with its context.' },
    });

    if (deps.team.temporary !== undefined) {
      Object.assign(properties, {
        lifetime: { type: 'string', enum: [...SUBORDINATE_LIFETIMES], description: 'For hire with `role`: durable (default) stays in your roster; task answers one question and is archived.' },
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

/** The peer topic for a hire or msg, or a refusal when the caller claimed the transport's reserved one. */
function requestedTopic(input: AgentsToolInput): { topic: string } {
  const requested = input.topic?.trim();
  // A blank topic is no topic: the default is what the transport routes on.
  const topic = requested === undefined || requested === '' ? 'message' : requested;

  return topic === PEER_REPLY_TOPIC
    ? badInput(`topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes`)
    : { topic };
}

/** Whether this actor may run the action now: unwired is `unsupported`, a durable roster change under
 *  Plan is `denied`. `hire` is decided in its arm, since Plan permits a `task` hire. */
function actionAdmission(actions: readonly AgentsToolInput['action'][], mode: WorkMode, action: AgentsToolInput['action']): Refusal | null {
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
      return badInput('field "context" belongs to a hire that creates with `role` — an existing agent already has its conversation');
    }

    if (input.mission !== undefined) {
      return badInput('field "mission" is not available on a hire that names an existing agent — its brief is `message`');
    }

    if (input.tier !== undefined) {
      return badInput('field "tier" is not available on a hire that names an existing agent — it already runs at its own tier');
    }

    if (input.lifetime !== undefined) {
      return badInput('field "lifetime" is not available on a hire that names an existing agent — it already has one; `lifetime` belongs to a hire that creates with `role`');
    }

    return;
  }

  if (input.message !== undefined) {
    return badInput('field "message" is not available for a hire that creates an agent — its brief is `mission`');
  }

  if (input.deliverable !== undefined) {
    return badInput('field "deliverable" is not available on a hire that creates an agent — say what the result should be in `mission`');
  }

  if (input.topic !== undefined) {
    return badInput('field "topic" is not available on a hire that creates an agent — it labels a message to an agent that already exists');
  }

  if (input.lifetime === 'task' && input.tier !== undefined) {
    return badInput('field "tier" is not available on a lifetime:"task" hire — it runs at its role\'s tier; omit it, or hire `durable` for an override');
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

interface CreateHireCall extends AgentsActionCall {
  team: TeamToolDeps;
  input: AgentsToolInput & { role: string; mission: string };
  lifetime: 'durable' | 'task';
}

async function hireCreate({ deps, team, input, mode, lifetime, toolOptions }: CreateHireCall): Promise<object> {
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
      return badInput('field "agent" is not available on a lifetime:"task" hire — it is archived the '
        + 'moment it answers, so a name you chose is never addressable. Omit it, or hire `durable`.');
    }

    const temporary = team.temporary;

    if (!temporary) {
      throw new KinuError('denied', 'lifetime:"task" runs the agent to its single answer inside this call, which this actor has no substrate for — '
        + 'omit `lifetime` for a durable hire, or name an existing agent with `agent` (action:"list" shows the roster).');
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

    if (toolOptions?.abortSignal) Object.assign(request, { signal: toolOptions.abortSignal });

    return await temporary.run(request);
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

    return badInput(`unknown agent "${input.agent}" — check the roster with action:"list"`);
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

  return await hireCreate({ deps, team, input, mode, lifetime, toolOptions });
}

export async function dispatchAgentsAction(
  deps: AgentsToolDeps,
  input: AgentsToolInput,
  toolOptions?: AgentsToolCallOptions,
): Promise<object> {
  const actions = agentsActionsFor(deps);
  const mode = inWorkMode(deps.mode, currentWorkMode);
  const team = deps.team;
  const peers = deps.peers;

  // No catch: a roster read failure must reach the caller, not route the assignment to the peer path.
  const isSubordinate = async (name: string): Promise<boolean> => {
    if (!team) return false;

    return (await team.list()).some((entry) => entry.name === name);
  };

  // An action this actor does not wire: `unsupported` (obs/error.ts), classified so it counts as refused.
  const admission = actionAdmission(actions, mode, input.action);

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
            + 'message event you were given. Naming both leaves it undecided who this is for — '
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

        return badInput(`unknown agent "${input.agent}" — check the roster with action:"list"`);
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

/** Build the `agents` tool; callers ensure at least one deps group is present. */
function nestingRoom(delegation: DelegationBudget): string {
  if (delegation.maxDepth > 1) return `A subordinate you hire can hire its own, ${delegation.maxDepth - 1} level(s) further.`;

  return 'A subordinate you hire cannot hire its own.';
}

export function createAgentsTool(deps: AgentsToolDeps): ToolSet[string] {
  const actions = agentsActionsFor(deps);
  const team = deps.team;

  return permitInPlan(tool({
    description: renderAgentsToolDescription(deps),
    inputSchema: jsonSchema<AgentsToolInput>({
      type: 'object',
      required: ['action'],
      properties: {
        action: team === undefined ? { type: 'string', enum: actions } : { type: 'string', enum: actions, description: nestingRoom(team.delegation) },
        ...agentsInputProperties(deps),
      },
      oneOf: agentsJsonSchemaVariants(deps, actions),
      // No `additionalProperties: false`: the parse below refuses an unknown field, naming the fields the action
      // takes. The SDK checks nothing against this schema (it carries no validator); the tool surface checks its fields.
    }),
    execute: async (input: AgentsToolInput, toolOptions?: AgentsToolCallOptions) => {
      // The native surface parses too: its inputs are type-checked but not name-checked.
      let parsed: AgentsToolInput;

      try {
        parsed = parseAgentsToolInput({ input });
      } catch (error) {
        // Reason first: a parse refusal is bad input, not a broken tool.
        throw new KinuError('bad_input', renderThrownChain({ cause: error }), { cause: error });
      }

      return dispatchAgentsAction(deps, parsed, toolOptions);
    },
  }));
}
