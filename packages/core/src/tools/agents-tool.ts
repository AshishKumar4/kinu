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
 *   ask     — hand any agent work and expect the answer back: a subordinate's
 *             report (or a peer's reply) arrives as an event that wakes you.
 *   send    — fire-and-forget message to any agent.
 *   reply   — answer an incoming agent message event by event_id.
 *   list    — the unified roster: subordinates + peer workspaces.
 *   dismiss — retire a subordinate (archived by default; context kept).
 *
 * The machinery underneath: swarm dispatches through `strategy/swarm-run.ts`,
 * whose nodes are real tool-using agents on the heads runtime; hire/ask/send
 * ride TeamToolDeps' facet substrate, and peer messaging rides PeersToolDeps'
 * EventsHub transport. Which actions exist is decided structurally by which
 * deps the backend wires — see agentsActionsFor.
 *
 * The swarm action's call contract is specified by docs/EXPLORATION.md — "Presets",
 * "Validity over the resolved configuration" and "Accepted and ignored".
 */
import { tool, jsonSchema } from 'ai';
import type { LanguageModel, ToolSet } from 'ai';
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
import { SwarmConfigSchema, SwarmObjectiveSchema } from './swarm-input';
import { resolveSwarm, swarmValidity, NAMED_SWARM_PRESETS, SWARM_PRESETS } from '../strategy/swarm';
import { runSwarm, type SwarmRunDeps } from '../strategy/swarm-run';
import type { NodeLoopHost } from '../strategy/node-agent';
import type { NamedSwarmPreset, SwarmConfig, SwarmPreset } from '../strategy/swarm';
import type { Objective } from '../strategy/objective';
import { readSpawnStarted } from '../jobs/threshold';
import { readMissionLimits, type MissionGovernor } from '../mission-budget';
import type { BuiltinStrategyOptions, StrategyRegistry } from '../strategy/types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { CostModel } from '../mcts/cost';
import type { WorkMode } from '../prompting/surface';
import { nanoid } from '../utils/nanoid';
import { diagnostics } from '../obs/index';
import { TURN_WALL_CLOCK_ENVELOPE_MS } from '../config';
import {
  delegationDepthRefusal,
  delegationExhausted,
  type DelegationBudget,
  type DelegationDepthRefusal,
} from '../subordinates/depth';
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

/** One row of the workspace_subordinates roster (parent-DO source of truth). */
export interface SubordinateRosterEntry {
  name: string;
  displayName: string;
  role: string;
  createdBy: 'orchestrator' | 'user';
  status: SubordinateStatus;
  currentTask: string | null;
  createdAt: number;
  dismissedAt: number | null;
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
  /** Create an idle durable subordinate identity. This is the owner-facing
   *  operation: a mission defines the agent, but does not become a task until
   *  the owner explicitly messages or assigns it. */
  create(input: {
    name?: string;
    role: string;
    mission: string;
    model?: string;
  }): Promise<{
    name: string; displayName: string; subordinate: SubordinateRosterEntry;
  }>;
  /** Create a durable subordinate; its first turn is the mission. */
  spawn(input: {
    name?: string;
    role: string;
    mission: string;
    model?: string;
    mode: WorkMode;
  }): Promise<{
    name: string; displayName: string;
  }>;
  /** Enqueue a task on the subordinate (drained as its next turn). */
  assign(input: { name: string; task: string; deliverable?: string; deadlineHint?: string; mode: WorkMode }): Promise<
    { ok: true; name: string } & SubordinateHandoff
  >;
  /** Roster row + live snapshot for one subordinate, or the whole roster. */
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
}

// ── Peers (cross-workspace agents) deps contract ────────────────────────────
// The deps implementation rides the existing EventsHub peer transport:
// enqueueOutboundPeer → receiver's receivePeerMessage → EventLog → turn, with
// replies routed back through the receiver's peer-back reply channel.

export type PeerSendOutcome =
  | { status: 'delivered' | 'queued'; message_id: string }
  | { status: 'rejected'; reason: string };

export type PeerAskOutcome =
  | { status: 'replied'; from: string; reply: JsonValue | undefined }
  | { status: 'no_reply'; note: string }
  | { status: 'rejected'; reason: string };

export type PeerReplyOutcome = { ok: true } | { ok: false; error: string };

export type PeerSpawnOutcome = { agent: string; created: boolean } & PeerAskOutcome;

export interface PeersToolDeps {
  /** The owner's other workspaces' agents this one may address (self excluded). */
  listPeers(): Promise<Array<{ name: string; displayName?: string }>>;
  /** Send-and-await: deliver a message and wait for the peer's reply. */
  ask(input: { agent: string; topic: string; message: string; timeoutMs: number; mode: WorkMode }): Promise<PeerAskOutcome>;
  /** Fire-and-forget: deliver a message without waiting for a reply. */
  send(input: { agent: string; topic: string; message: string; mode: WorkMode }): Promise<PeerSendOutcome>;
  /** Answer a peer message event received this (or an earlier) turn. */
  reply(input: { eventId: string; message: string }): Promise<PeerReplyOutcome>;
  /** Create (or reuse by name) a specialist workspace, message its agent, await the result. */
  spawnWorkspace(input: { name?: string; purpose: string; message: string; timeoutMs: number; mode: WorkMode }): Promise<PeerSpawnOutcome>;
}

/** Reserved topic for transport-generated reply envelopes; user sends must not claim it. */
export const PEER_REPLY_TOPIC = 'peer_reply';

/**
 * How long an `ask` (or a `hire scope=workspace`) waits for the addressed agent
 * to answer — its whole turn, not a completion.
 *
 * This was 120_000 default / 600_000 ceiling. 120_000 is the same number, on the
 * same workload, that `branch-process.ts` measured wrong: on the default model
 * every peer whose turn took 151-509 s answered a caller that had already been
 * told `no_reply`. Softer than the branch case — the real reply is not lost, it
 * lands later as an event — but the calling turn concludes on a false premise and
 * may route around a peer that was working. So the default IS the measured
 * envelope, and so is the ceiling: a caller asking for more than one turn's worth
 * of waiting is asking to hold its own turn open indefinitely.
 *
 * There is no floor. It was 5_000, which silently overrode a caller that asked
 * for one second, and nothing depends on it: a tiny timeout returns `no_reply`
 * with the note saying the answer arrives later as an event, which is honest.
 * Zero is the floor a duration has anyway.
 */
const ASK_TIMEOUT_CEILING_MS = TURN_WALL_CLOCK_ENVELOPE_MS;

function askTimeoutMs(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) return ASK_TIMEOUT_CEILING_MS;
  return Math.min(ASK_TIMEOUT_CEILING_MS, Math.max(0, Math.round(timeoutSeconds * 1000)));
}

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
 * workspace to measure in. Wired under the `fork` key on {@link AgentsToolDeps}
 * because that is the key both backends already build (`buildStrategyForkDeps`),
 * and the exploration substrate it names — the heads runtime, the durable MCTS
 * session — is the same substrate a search's nodes run on.
 *
 * `runSwarmAction` reads `rt` and `model`. The other three carry the strategy
 * plumbing the backends assemble around that substrate; they are declared here
 * because the backends' one builder produces the whole bag, not because this
 * module dispatches a strategy.
 */
export interface AgentsForkDeps {
  registry: StrategyRegistry;
  rt: AgentRuntime;
  model: LanguageModel;
  /** What the resolved model charges, for gates on projected spend before
   *  starting. Backends wire the ModelCatalogSession they already hold;
   *  absence makes the gate blend and say so. */
  costModel?: () => CostModel;
  /**
   * Where a tool-using swarm node's loop runs, resolved per call.
   *
   * A FACTORY for the same reason `costModel` and `heads.controller` are: a
   * backend may not be able to build one until the actor has an owner, so
   * resolving it at dispatch keeps the refusal where it can be reported rather
   * than at wiring time. Absent is a backend with no facets, and then a node's
   * loop runs in this isolate — the same body, without a storage boundary.
   */
  nodeHost?: () => NodeLoopHost;
  /** Per-strategy infrastructure options the LLM must not set — e.g.
   *  `{ mcts: { session }, heads: { controller, inheritedContext, onPhase } }`. */
  defaultOptions?: () => BuiltinStrategyOptions;
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
  /** The actor's mission budget governor. Wired, it makes this the SPAWN seam:
   *  no helper is launched under an exhausted label, and a fork's own declared
   *  cap nests under the mission that spawned it. Unwired (or unscoped, the
   *  default) changes nothing. */
  budget?: MissionGovernor;
}

interface UnifiedRosterResult {
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
  /** What is measured, in what unit, which direction is better. Required for
   *  `optimise`; refused on `ideate`, which has no value signal by design. */
  objective?: Objective;
  /** The coverage key an archive bins elites into. */
  key?: string;
  /** The axes, with `preset:'custom'` only — the OVERRIDE half of a composition. */
  config?: Partial<SwarmConfig>;
  from?: NamedSwarmPreset;
  label?: string;
  branches?: number;
  depth?: number;
  models?: string[];
  // hire / converse
  agent?: string;
  role?: string;
  mission?: string;
  model?: string;
  scope?: 'subordinate' | 'workspace';
  message?: string;
  topic?: string;
  deliverable?: string;
  deadline_hint?: string;
  timeout_seconds?: number;
  event_id?: string;
  keep_history?: boolean;
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
    'task', 'preset', 'objective', 'key', 'config', 'from', 'label', 'branches', 'depth',
    'models', 'budget_usd', 'budget_tokens', 'budget_label',
  ],
  hire: ['agent', 'role', 'mission', 'model', 'scope', 'message', 'timeout_seconds'],
  ask: ['agent', 'message', 'topic', 'timeout_seconds', 'deliverable', 'deadline_hint'],
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
  branches: v.optional(v.number()),
  depth: v.optional(v.number()),
  models: v.optional(v.array(v.string())),
  agent: v.optional(v.string()),
  role: v.optional(v.string()),
  mission: v.optional(v.string()),
  model: v.optional(v.string()),
  scope: v.optional(v.picklist(['subordinate', 'workspace'])),
  message: v.optional(v.string()),
  topic: v.optional(v.string()),
  deliverable: v.optional(v.string()),
  deadline_hint: v.optional(v.string()),
  timeout_seconds: v.optional(v.number()),
  event_id: v.optional(v.string()),
  keep_history: v.optional(v.boolean()),
};

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
 */
function missionScope(
  budget: MissionGovernor | undefined,
  input: AgentsToolInput,
): { governor: MissionGovernor; labels: string[] } | null {
  if (!budget) return null;
  const limits = readMissionLimits(input);
  if (limits) {
    const label = input.budget_label?.trim() || `swarm-${nanoid()}`;
    budget.declare(label, limits);
    return { governor: budget, labels: [label] };
  }
  return budget.scope.length > 0 ? { governor: budget, labels: [...budget.scope] } : null;
}

// ── Swarm dispatch (the configured-search rung) ──────────────────────────────

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
 * `budget_usd` / `budget_tokens` / `budget_label`, and the governed model is what the
 * expansion runs on.
 */
async function runSwarmAction(
  deps: AgentsForkDeps,
  input: AgentsToolInput,
  mode: WorkMode,
  toolOptions: AgentsToolCallOptions | undefined,
  budget?: MissionGovernor,
): Promise<object> {
  if (!input.preset) {
    return badInput('swarm needs `preset` — the shape of the search. optimise measures a number '
      + 'you declare in `objective`; ideate samples in parallel with no value signal; '
      + 'research/audit/redteam bin findings under a coverage `key`; custom states the axes in '
      + '`config` under a `label`.');
  }
  if (!input.task) {
    return badInput('swarm needs `task` — what the search is for, in prose. The measured '
      + 'quantity goes in `objective`, never here.');
  }
  const call = { preset: input.preset, task: input.task };
  if (input.objective) Object.assign(call, { objective: input.objective });
  if (input.key) Object.assign(call, { key: input.key });
  if (input.config) Object.assign(call, { config: input.config });
  if (input.from) Object.assign(call, { from: input.from });
  if (input.label) Object.assign(call, { label: input.label });
  if (input.branches !== undefined) Object.assign(call, { branches: input.branches });
  if (input.depth !== undefined) Object.assign(call, { depth: input.depth });
  if (input.models) Object.assign(call, { models: input.models });

  // Resolution first, per *Presets* — *Validity over the resolved configuration* is
  // stated over the resolved tuple and has no input without it.
  const resolved = resolveSwarm(call);
  if ('reason' in resolved) return resolved;
  // Legality, per *Validity over the resolved configuration*: over the resolved
  // tuple and never over the preset name.
  const illegal = swarmValidity(resolved);
  if (illegal) return illegal;

  // The mission scope, and with it the model-call seam, so an exhausted label stops
  // a search mid-flight rather than after it.
  const mission = missionScope(budget, input);
  let rt: AgentRuntime = deps.rt;
  if (mission) {
    rt = { ...deps.rt, llm: mission.governor.govern(deps.rt.llm, mission.labels) };
  }
  const runDeps: SwarmRunDeps = { rt, model: deps.model, mode };
  const signal = readAbortSignal(toolOptions);
  if (signal) Object.assign(runDeps, { signal });
  // Resolved here rather than at wiring time, so a backend that cannot build a
  // host yet refuses where the refusal is reportable. Assigned only when there is
  // one: an absent key is what runs the loop in this isolate.
  const host = deps.nodeHost?.();
  if (host) Object.assign(runDeps, { host });
  readSpawnStarted(toolOptions)?.();
  const result = await runSwarm(runDeps, resolved);
  if ('reason' in result) return result;
  // The spawn always records. TOKENS are charged as a lump here because a search's
  // expansions and measurements are made from THIS process through the governed
  // `rt.llm`, so nothing has debited them yet. A run that reported no total is
  // charged nothing rather than billed a fabricated zero.
  mission?.governor.debit(result.report.tokens ?? 0, { labels: mission.labels, spawns: 1 });
  const output: JsonObject = parseJsonObject(JSON.stringify(result));
  if (mission) {
    const label = mission.labels[0];
    const snapshot = label ? mission.governor.snapshot(label)[0] : undefined;
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
      description: 'For action=swarm: the shape of the search. optimise = beat a measured number (requires `objective`). ideate = flat parallel sampling with no value signal, which is why it takes no `objective` and returns a set. research/audit/redteam = bin findings into an archive under a coverage `key`. custom = state the axes yourself in `config`, with a `label`.',
    },
    objective: {
      type: 'object',
      description: 'For action=swarm: what is measured. {kind:"scalar", metric, unit, direction:"minimise"|"maximise", scale:"linear"|"log", target, verify:{kind, spec}} and an optional floor:{value, kind:"certificate", proof, best_known_honest}. verify names a REGISTERED instrument and hands it its whole spec — a metric nothing can execute is not an objective, and a script path invented here is refused rather than run. kind:"witness" is a checkable certificate and needs a scalar `proxy` to be searchable; kind:"instanced" (one metric, 2+ instances) and kind:"vector" (2+ metrics) are the two front shapes. Field names are snake_case, like every field on this tool.',
    },
    key: { type: 'string', description: 'For action=swarm with advance:"archive": the coverage descriptor elites are binned into, required there and refused under every other advance. It must name a quantity the objective\'s own verifier REPORTS beside its value, because the cell a candidate lands in is witnessed by the measurement rather than claimed by the candidate — a key naming nothing that instrument reports is refused before any candidate is expanded, and a key that can only say "distinct idea" means the task wants preset:"ideate".' },
    config: { type: 'object', description: 'For action=swarm with preset:"custom" only: the axes — unit, context, expand, score, advance, carry — as the OVERRIDE on `from`\'s shape, or all six when there is no `from`. Prohibited on a named preset, which is a tested path and cannot be refused.' },
    from: {
      type: 'string',
      enum: [...NAMED_SWARM_PRESETS],
      description: 'For action=swarm with preset:"custom": a named preset to start from, so you state only what differs. It does NOT make this a preset run — the record still says custom, which is the point of having both fields.',
    },
    label: { type: 'string', maxLength: 120, description: 'For action=swarm with preset:"custom": required provenance. A composed shape recorded repeatedly under one label is the evidence for a new preset.' },
    branches: { type: 'integer', minimum: 1, description: 'For action=swarm: candidates per expansion. Omit to take the preset\'s own width.' },
    depth: { type: 'integer', minimum: 1, description: 'For action=swarm: how deep the search may go. Omit to take the preset\'s own depth. depth:1 is one measured expansion; deeper selects down a tree with `advance`, scoring each node against your own `objective`. The literature runs 3-7 (ToT <=3, LATS 7, Koh 5). advance:"none" has no selection step, so it fixes depth at 1 and a deeper cap is refused rather than silently flattened.' },
    models: { type: 'array', items: { type: 'string' }, description: 'For action=swarm: per-node model routing — a cheap model for recon, a strong one for synthesis. NOT for diversity: a mixed panel tracks its AVERAGE member, so a weaker model added for variety measurably subtracts. Diversity is unconditional: every node is already given its own angle.' },
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
      description: `Agent name: ${askTargets}. Target for ask/send/dismiss; optional name for hire (auto-generated from the role when omitted) and detail filter for list.`,
    },
    role: { type: 'string', maxLength: 200, description: 'For action=hire: one freeform role/purpose line (e.g. "researcher — competitive landscape").' },
    // Says what a mission is FOR, because the hire rung's context fact makes it
    // load-bearing: this text plus a bounded digest of the caller's recent
    // messages is the subordinate's whole starting knowledge. The sentence is
    // DELEGATION_INHERITANCE.hire.brief — the fork brief's opposite, from the
    // same per-action source, so neither field can be handed the other's rule.
    mission: { type: 'string', maxLength: 20000, description: `For action=hire: the helper's mission — it seeds its identity and runs as its first turn. ${DELEGATION_INHERITANCE.hire.brief}` },
    model: { type: 'string', description: 'For action=hire: optional model spec override (defaults to the workspace model).' },
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
      timeout_seconds: { type: 'number', description: `For a peer ask / hire scope=workspace: seconds to wait for the reply (default and max ${TURN_WALL_CLOCK_ENVELOPE_MS / 1000}, which is one measured agent turn). On timeout the reply still arrives later as an event.` },
      event_id: { type: 'string', description: 'For action=reply: the agent message event id you were given.' },
    });
  }
  if (deps.team) {
    Object.assign(properties, {
      deliverable: { type: 'string', maxLength: 2000, description: 'For ask to a subordinate: what the finished result should be (optional).' },
      deadline_hint: { type: 'string', maxLength: 200, description: 'For ask to a subordinate: optional urgency/deadline hint.' },
      keep_history: { type: 'boolean', description: 'For action=dismiss: keep the subordinate archived with its context (default true). Set false ONLY to permanently wipe its storage.' },
    });
  }
  return properties;
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
function requestedTopic(input: AgentsToolInput): { topic: string } | { error: string } {
  const topic = input.topic?.trim() || 'message';
  return topic === PEER_REPLY_TOPIC
    ? { error: `topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes` }
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
 * read (search cancellation).
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
  if (input.action === 'hire' && team && delegationExhausted(team.delegation)) {
    return delegationDepthRefusal(team.delegation);
  }
  try {
    switch (input.action) {
      case 'swarm':
        return await runSwarmAction(deps.fork!, input, mode, toolOptions, deps.budget);

      case 'hire': {
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
          if (!input.mission || !input.message) return { error: 'hire scope=workspace requires mission and message' };
          const request: Parameters<PeersToolDeps['spawnWorkspace']>[0] = {
            purpose: input.mission,
            message: input.message,
            timeoutMs: askTimeoutMs(input.timeout_seconds),
            mode,
          };
          if (input.agent) Object.assign(request, { name: input.agent });
          return await peers.spawnWorkspace(request);
        }
        if (!team) return { error: 'hiring subordinates is not available on this actor' };
        if (!input.role || !input.mission) return { error: 'hire requires role and mission' };
        const request: Parameters<TeamToolDeps['spawn']>[0] = {
          role: input.role,
          mission: input.mission,
          mode,
        };
        if (input.agent) Object.assign(request, { name: input.agent });
        if (input.model) Object.assign(request, { model: input.model });
        return await team.spawn(request);
      }

      case 'ask': {
        if (!input.agent || !input.message) return { error: 'ask requires agent and message' };
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
          return await peers.ask({
            agent: input.agent, topic: asked.topic, message: input.message,
            timeoutMs: askTimeoutMs(input.timeout_seconds),
            mode,
          });
        }
        return { error: `unknown agent "${input.agent}" — check the roster with action:"list"` };
      }

      case 'send': {
        if (!input.agent || !input.message) return { error: 'send requires agent and message' };
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
        return { error: `unknown agent "${input.agent}" — check the roster with action:"list"` };
      }

      case 'reply':
        if (!peers) return { error: 'reply needs the peer transport, which this actor does not have' };
        if (!input.event_id || !input.message) return { error: 'reply requires event_id and message' };
        return await peers.reply({ eventId: input.event_id, message: input.message });

      case 'list': {
        if (input.agent && team && await isSubordinate(input.agent)) {
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
        if (!team) return { error: 'dismiss applies to subordinates, which this actor does not have' };
        if (!input.agent) return { error: 'dismiss requires agent' };
        return await team.dismiss({
          name: input.agent,
          keepHistory: input.keep_history ?? true,
        });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
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
              'swarm = run a configured search over ephemeral nodes of yourself, whose candidates are measured by your own verifier instead of judged — it takes a preset and an objective.',
            ] : []),
            ...(team || peers ? [
              'hire = create a persistent named helper. ask = hand an agent work and get its answer back. send = fire-and-forget message. list = the unified roster.'
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
        ...swarmProperties(deps),
        ...converseProperties(deps),
      },
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
        return { reason: 'bad_input', error: error instanceof Error ? error.message : String(error) };
      }
      return dispatchAgentsAction(deps, parsed, toolOptions);
    },
  });
}
