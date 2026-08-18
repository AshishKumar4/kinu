/**
 * `agents` — the ONE delegation tool. Every helper an actor can spawn or talk
 * to lives behind a single surface where the KIND of helper is a parameter:
 *
 *   fork    — 2–6 ephemeral forks of the calling agent (the heads runtime),
 *             each a full multi-step tool loop on the same workspace, settled
 *             by merge (default) or by the MCTS strategy (settle=mcts).
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
 * The machinery underneath is unchanged surface-for-surface from the former
 * think/team/peers tools: fork dispatches through the StrategyRegistry
 * (heads / mcts strategies untouched), hire/ask/send ride TeamToolDeps'
 * facet substrate, and peer messaging rides PeersToolDeps' EventsHub
 * transport. Which actions exist is decided structurally by which deps the
 * backend wires — see agentsActionsFor.
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
import { FORK_STRATEGY_ID } from '../strategy/heads';
import { readSpawnStarted } from '../jobs/threshold';
import { localMissionPort, readMissionLimits, type MissionGovernor } from '../mission-budget';
import type {
  BuiltinStrategyOptions, StrategyContext, StrategyRegistry,
} from '../strategy/types';
import type { AgentRuntime } from '../types/agent-runtime';
import type { MergeStrategy } from '../heads/types';
import type { WorkMode } from '../prompting/surface';
import { nanoid } from '../utils/nanoid';
import { diagnostics } from '../obs/index';
import {
  delegationDepthRefusal,
  delegationExhausted,
  type DelegationBudget,
  type DelegationDepthRefusal,
} from '../subordinates/depth';
import {
  JsonObjectSchema,
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

const ASK_TIMEOUT_DEFAULT_MS = 120_000;
const ASK_TIMEOUT_MIN_MS = 5_000;
const ASK_TIMEOUT_MAX_MS = 600_000;

function askTimeoutMs(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) return ASK_TIMEOUT_DEFAULT_MS;
  return Math.min(ASK_TIMEOUT_MAX_MS, Math.max(ASK_TIMEOUT_MIN_MS, Math.round(timeoutSeconds * 1000)));
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

// ── Fork (exploration strategy) deps contract ───────────────────────────────

export interface AgentsForkDeps {
  registry: StrategyRegistry;
  rt: AgentRuntime;
  model: LanguageModel;
  /** Build per-strategy infrastructure options the LLM must not set —
   *  e.g. `{ mcts: { session }, heads: { controller, inheritedContext, onPhase } }`.
   *  Called once per fork invocation and deep-merged (one level) under the
   *  caller's options so injected infra survives caller-supplied tuning. */
  defaultOptions?: () => BuiltinStrategyOptions;
}

export interface AgentsToolDeps {
  /** Trusted mode of the turn executing this dispatch. It is host-owned and
   * never appears in the model schema, so a delegated child cannot opt out of
   * a Plan turn's mutation bar. */
  mode: WorkMode;
  /** Ephemeral forks (the heads runtime + MCTS settle). Wired wherever the
   *  backend has an exploration substrate — both backends, subordinates too. */
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
 *  Presence-typed so prompt assembly can ask without building fork deps. */
export function agentsActionsFor(deps: { fork?: object; team?: object; peers?: object }): AgentsToolAction[] {
  const converse = !!deps.team || !!deps.peers;
  const present = {
    fork: !!deps.fork,
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
    ...(deps.fork ? [DELEGATION_RUNGS.fork] : []),
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

/** A single fork spec. Mirrors SplitRequest['heads'][number] minus the infra
 *  the host injects. */
interface ForkSpec {
  task: string;
  rationale: string;
  /** Per-fork model spec (e.g. `codex/gpt-5.5`). Omit to inherit the agent's. */
  model?: string;
  allowedTools?: string[];
}

export interface AgentsToolInput {
  action: AgentsToolAction;
  // fork
  task?: string;
  forks?: ForkSpec[];
  /** How forks are settled. Omit to merge; `mcts` scores them by execution.
   *  Any other registered strategy id stays dispatchable (eval harness path). */
  settle?: string;
  merge_strategy?: MergeStrategy;
  budget?: number;
  wall_clock_ms?: number;
  options?: JsonObject;
  /** Cumulative spend cap for everything this helper transitively spawns.
   *  Nests under the caller's mission scope, so an inner cap can only ever be
   *  tighter than the outer one. Omit for the uncapped default. */
  budget_usd?: number;
  budget_tokens?: number;
  /** Name the sub-ledger. Defaults to a generated label under the caller's
   *  mission; naming it lets a run keep one budget across several calls. */
  budget_label?: string;
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
  fork: [
    'task', 'forks', 'settle', 'merge_strategy', 'budget', 'wall_clock_ms', 'options',
    'budget_usd', 'budget_tokens', 'budget_label',
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

interface MergeableOption {
  [key: string]: BuiltinStrategyOptions[keyof BuiltinStrategyOptions];
}

const MergeableOptionSchema = v.custom<MergeableOption>(
  (input) => !Array.isArray(input) && v.is(v.object({}), input),
);

function mergeableOption(
  value: BuiltinStrategyOptions[keyof BuiltinStrategyOptions],
): MergeableOption | undefined {
  const parsed = v.safeParse(MergeableOptionSchema, value);
  return parsed.success ? parsed.output : undefined;
}

interface HeadsOptionOverlay {
  heads?: ForkSpec[];
  mergeStrategy?: MergeStrategy;
}

/** A fork brief's fields, `strictObject` for the same reason the input is: these
 *  are the surface's only camelCase names, so `allowed_tools` beside the tool's
 *  own snake_case is a mistake the shape itself invites. */
const ForkSpecEntries = {
  task: v.string(),
  rationale: v.string(),
  model: v.optional(v.string()),
  allowedTools: v.optional(v.array(v.string())),
};
const ForkSpecSchema = v.strictObject(ForkSpecEntries);

/** Every input field and its type, declared ONCE. The two policies below read
 *  these same entries — the model-facing parse REFUSES an unrecognised field,
 *  the replay filter DROPS it — so neither can come to declare a field the
 *  other does not. */
const AgentsInputEntries = {
  action: v.picklist(AGENTS_TOOL_ACTIONS),
  task: v.optional(v.string()),
  forks: v.optional(v.array(ForkSpecSchema)),
  settle: v.optional(v.string()),
  merge_strategy: v.optional(v.picklist(['synthesize', 'best_of', 'consensus'])),
  budget: v.optional(v.number()),
  wall_clock_ms: v.optional(v.number()),
  options: v.optional(JsonObjectSchema),
  budget_usd: v.optional(v.number()),
  budget_tokens: v.optional(v.number()),
  budget_label: v.optional(v.string()),
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
 * request had vanished. camelCase for a snake_case field is the EXPECTED mistake
 * here — the tool's own fork briefs are camelCase one level down — so this is a
 * shape the surface provokes rather than an exotic one.
 */
const AgentsToolInputSchema = v.strictObject(AgentsInputEntries);

/**
 * The REPLAY parse, over a durable job row instead of a model's call. A row is
 * history: no model is listening for a correction, and refusing the row would
 * turn an interrupted fork into a hard failure (JobNotResumable) over a field
 * that was ALREADY dropped when the row was first dispatched. So unknown entries
 * are dropped here — which is what makes the re-drive faithful to the run it
 * resumes — and `resumableForkInput` logs the drop rather than repeating it
 * silently.
 */
const StoredAgentsInputSchema = v.object(AgentsInputEntries);

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
  // The briefs, whose own fields are the camelCase half of the same collision.
  const briefs = v.safeParse(v.array(FieldNamesSchema), parsed.output['forks']);
  if (briefs.success) {
    for (const [index, brief] of briefs.output.entries()) {
      for (const field of Object.keys(brief)) {
        if (Object.hasOwn(ForkSpecEntries, field)) continue;
        const meant = nearestField(field, Object.keys(ForkSpecEntries));
        problems.push(`unknown field "forks[${String(index)}].${field}"`
          + (meant
            ? ` — did you mean "${meant}"? A brief's fields are camelCase.`
            : `. A brief takes: ${Object.keys(ForkSpecEntries).join(', ')}.`));
      }
    }
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

/**
 * Background-job resume filter, shared by both backends: durable job rows
 * store the tool KIND + input, and only fork work is safely re-runnable (the
 * MCTS search checkpoint / heads re-run path). Returns the fork input to
 * re-execute, translating rows stored by the pre-unification `think` tool
 * (strategy → settle, heads → forks), or null when the job is not resumable.
 *
 * Rows are TRANSLATED rather than validated as a model call would be. A row was
 * recorded verbatim from whatever the model sent (jobs/runner.ts stores the raw
 * input), so rows written before the strict parse can carry fields it now
 * refuses — and a row is re-driven, not answered, so a refusal there is a fork
 * lost to a spelling nobody can correct any more. Both branches therefore build
 * the resumed call out of the fork fields alone, and anything left over is
 * logged: dropped, as it was dropped on the original dispatch, but no longer
 * silently.
 */
const LegacyForkInputSchema = v.object({
  strategy: v.optional(v.string()),
  task: v.string(),
  heads: v.optional(v.array(ForkSpecSchema)),
  merge_strategy: v.optional(v.picklist(['synthesize', 'best_of', 'consensus'])),
  budget: v.optional(v.number()),
  wall_clock_ms: v.optional(v.number()),
  options: v.optional(JsonObjectSchema),
});

export function resumableForkInput<T>(kind: string, input: T): AgentsToolInput | null {
  if (kind === 'agents') {
    const parsed = v.safeParse(StoredAgentsInputSchema, input);
    if (!parsed.success || parsed.output.action !== 'fork') return null;
    const resumed: AgentsToolInput = { action: 'fork' };
    for (const field of AGENTS_ACTION_FIELDS.fork) {
      const value = parsed.output[field];
      if (value !== undefined) Object.assign(resumed, { [field]: value });
    }
    const carried = new Set(Object.keys(resumed));
    const dropped = fieldNames(input).filter((field) => !carried.has(field));
    if (dropped.length > 0) {
      // Absent from the re-drive, and present in the record of why. Named
      // rather than counted: a resumed fork that lost a cap is only diagnosable
      // if the line says which cap.
      diagnostics.event('agents.resume.fields_dropped', {
        kind, fields: dropped.join(','), count: dropped.length,
      });
    }
    return resumed;
  }
  if (kind !== 'think') return null;
  const parsed = v.safeParse(LegacyForkInputSchema, input);
  if (!parsed.success) return null;
  const legacy = parsed.output;
  const settle = legacy.strategy === undefined || legacy.strategy === FORK_STRATEGY_ID
    ? undefined
    : legacy.strategy;
  const resumed: AgentsToolInput = {
    action: 'fork',
    task: legacy.task,
  };
  if (settle !== undefined) Object.assign(resumed, { settle });
  if (legacy.heads) Object.assign(resumed, { forks: legacy.heads });
  if (legacy.merge_strategy) Object.assign(resumed, { merge_strategy: legacy.merge_strategy });
  if (legacy.budget !== undefined) Object.assign(resumed, { budget: legacy.budget });
  if (legacy.wall_clock_ms !== undefined) Object.assign(resumed, { wall_clock_ms: legacy.wall_clock_ms });
  if (legacy.options) Object.assign(resumed, { options: legacy.options });
  return resumed;
}

interface AgentsToolCallOptions {
  abortSignal?: AbortSignal;
}

function readAbortSignal(options: AgentsToolCallOptions | undefined): AbortSignal | undefined {
  return options?.abortSignal;
}

// ── Fork dispatch (the former think tool, verbatim semantics) ───────────────

/**
 * A fork refusal, reason FIRST — the shape and the vocabulary the `file` tool's
 * refusals already carry (tools/file-tool.ts). `bad_input` is that vocabulary's
 * "the arguments do not describe an operation", which is exactly what a fork
 * with the wrong argument shape is, and it is what makes the refusal land in
 * `refused` rather than indicting the tool in `broke` when the ledger is read
 * back (read-models/tool-failures.ts). A bare `{error}` envelope classified as
 * `returned_error`: a correct refusal counted as a defect.
 */
interface ForkRefusal {
  reason: 'bad_input';
  error: string;
}

function forkRefusal(error: string): ForkRefusal {
  return { reason: 'bad_input', error };
}

/**
 * The forks/settle relationship, enforced in both directions before anything
 * spawns. `forks` is read by exactly ONE settle — merge, whose strategy reads
 * them off options.heads (strategy/heads.ts) — and every other settle runs on
 * `ctx.task` alone. Both halves used to be prose and neither was enforced:
 *
 *   settle=mcts DISCARDED the briefs. The fold below ran unconditionally and
 *   the MCTS strategy never reads that option (strategy/mcts.ts), so briefs
 *   carrying per-fork `model` and `allowedTools` produced toolless codegen on
 *   the task string, returned as an ordinary success.
 *
 *   settle=merge WITHOUT briefs got past the spawn announcement below, so the
 *   call detached into a background job and the strategy's throw arrived as a
 *   wake about spawned work failing — naming `heads`, an option the model has
 *   no field for — for a fork that never spawned.
 *
 * REFUSING rather than seeding the search from the briefs is the deliberate
 * choice: a brief is `task` + `rationale` + `model` + `allowedTools`, and an
 * mcts branch is a single generateText call with no ToolSet and no runtime
 * (cf-backend exploration.ts) under one model the engine resolves for the whole
 * search. Seeding could honour the first two fields and would have to discard
 * the other two — this same defect one level down. What the caller wanted
 * (briefs that run tools and get compared) is settle=merge, and the refusal
 * names it.
 */
function forkSettleRefusal(
  deps: AgentsForkDeps,
  input: AgentsToolInput,
  settle: string,
  strategyId: string,
): ForkRefusal | null {
  const briefs = input.forks?.length ?? 0;
  if (strategyId !== FORK_STRATEGY_ID) {
    const orphaned: string[] = [];
    if (briefs > 0) orphaned.push('`forks`');
    if (input.merge_strategy) orphaned.push('`merge_strategy`');
    if (orphaned.length === 0) return null;
    const named = orphaned.join(' and ');
    const alsoLost = briefs > 0
      ? ', and every per-fork `model` and `allowedTools` goes with the briefs'
      : '';
    return forkRefusal(
      `settle=${settle} reads \`task\` alone — it writes its own competing approaches — so ` +
      `${named} would be discarded here: only settle=merge reads ${orphaned.length > 1 ? 'them' : 'it'}` +
      `${alsoLost}. Either drop ${named} and put everything the search needs in \`task\`, or use ` +
      'settle=merge, where each brief runs as a real fork with its own multi-step tool loop.',
    );
  }
  if (briefs > 0) return null;
  // Never names a settle this registry does not have.
  const alternative = deps.registry.get('mcts')
    ? ' Or use settle=mcts, which takes no `forks` and writes its own competing approaches from `task`.'
    : '';
  return forkRefusal(
    'settle=merge runs the forks you supply and this call supplied none. Pass `forks`: 2-6 briefs, ' +
    'each with its own `task` and `rationale`. Nothing infers the angles for you.' + alternative,
  );
}

/**
 * The mission scope this fork runs under: the caller's, narrowed to a fresh
 * child label when the call declared its own cap. Returns null when there is no
 * governor or no scope at all — the uncapped default, where nothing below this
 * point does any budget work.
 */
function forkMissionScope(
  budget: MissionGovernor | undefined,
  input: AgentsToolInput,
): { governor: MissionGovernor; labels: string[] } | null {
  if (!budget) return null;
  const limits = readMissionLimits(input);
  if (limits) {
    const label = input.budget_label?.trim() || `fork-${nanoid()}`;
    budget.declare(label, limits);
    return { governor: budget, labels: [label] };
  }
  return budget.scope.length > 0 ? { governor: budget, labels: [...budget.scope] } : null;
}

async function runFork(
  deps: AgentsForkDeps,
  input: AgentsToolInput,
  mode: WorkMode,
  toolOptions: AgentsToolCallOptions | undefined,
  budget?: MissionGovernor,
): Promise<object> {
  if (!input.task) return forkRefusal('fork requires task');
  const settle = input.settle ?? 'merge';
  const strategyId = settle === 'merge' ? FORK_STRATEGY_ID : settle;
  const strat = deps.registry.get(strategyId);
  if (!strat) {
    const settles = ['merge', ...deps.registry.list().filter((s) => s.advertised !== false && s.id !== FORK_STRATEGY_ID).map((s) => s.id)];
    return forkRefusal(`Unknown settle "${settle}". Available: ${settles.join(', ')}`);
  }
  const mismatch = forkSettleRefusal(deps, input, settle, strategyId);
  if (mismatch) return mismatch;

  // One-level deep merge: caller tuning sits alongside injected infra
  // (session / controller / onPhase) instead of replacing the whole
  // per-strategy bag.
  const defaults = deps.defaultOptions?.();
  const callerOpts = input.options ?? {};
  const options = defaults instanceof Map
    ? new Map(defaults)
    : new Map(Object.entries(defaults ?? {}));
  for (const [key, value] of Object.entries(callerOpts)) {
    const existing = options.get(key);
    const existingObject = mergeableOption(existing);
    const valueObject = mergeableOption(value);
    options.set(
      key,
      existingObject && valueObject
        ? Object.assign({}, existingObject, valueObject)
        : value,
    );
  }

  // Ergonomic fork input: fold the typed top-level fields into options.heads,
  // preserving the injected controller/context/onPhase. Reached only under the
  // settle that reads them — forkSettleRefusal above is what guarantees it.
  if (input.forks?.length) {
    const headsOptions: HeadsOptionOverlay = {};
    const existingHeads = options.get('heads');
    const existingHeadsObject = mergeableOption(existingHeads);
    if (existingHeadsObject) Object.assign(headsOptions, existingHeadsObject);
    Object.assign(headsOptions, { heads: input.forks });
    if (input.merge_strategy) Object.assign(headsOptions, { mergeStrategy: input.merge_strategy });
    options.set('heads', headsOptions);
  }

  // The fork's mission scope, and with it the model-call seam for everything
  // the exploration reaches a model through: branch evaluation, the judge
  // ensemble, convergence. Metering and enforcement ride the same wrapper, so
  // an exhausted label stops the search mid-flight rather than after it.
  const mission = forkMissionScope(budget, input);
  let rt: AgentRuntime = deps.rt;
  if (mission) {
    rt = {
      ...deps.rt,
      llm: mission.governor.govern(deps.rt.llm, mission.labels),
    };
    if (deps.rt.judgeModel) {
      Object.assign(rt, { judgeModel: mission.governor.govern(deps.rt.judgeModel, mission.labels) });
    }
  }

  const ctx: StrategyContext = {
    task: input.task,
    mode,
    rt,
    model: deps.model,
    // The governed `rt.llm` above covers everything that reaches a model
    // through this process. A head does not: it resolves its own model in its
    // own runtime, so it needs the ledger itself, and that is what this
    // carries. Only present when a budget was actually declared.
    budget: {
      // Unset = strategy default (lets stored agent-config overrides apply).
      maxIterations: input.budget,
      // Only set a wall-clock bound when the caller explicitly asks for one.
      // Every blanket default here has silently killed forks mid-work (a 60s
      // one that a fork's sub-agent cold-start alone could eat, then a 5-minute
      // one that killed a codebase audit). Undefined means the forks run to
      // completion, like the turn that spawned them; spend is the mission
      // governor's ledger, declared below.
      wallClockMs: input.wall_clock_ms,
    },
    options,
  };
  const signal = readAbortSignal(toolOptions);
  if (signal) Object.assign(ctx, { signal });
  if (mission) {
    Object.assign(ctx, {
      mission: { labels: mission.labels, port: localMissionPort(mission.governor) },
    });
  }
  // The spawn is validated and about to be in flight — tell the background
  // wrapper, which detaches the call right now instead of racing a threshold
  // whose wait could only be dead air (withSpawnDetach). Every validation
  // error above returned before this line, so it still lands inline; a
  // failure past it is genuinely the spawned work failing, and arrives as
  // the job's wake. Inline surfaces (codemode `agents.*`, resume re-drives,
  // the raw eval toolset) arm no announcement and run to completion.
  readSpawnStarted(toolOptions)?.();
  try {
    const result = await strat.explore(ctx);
    // The spawn always records. The TOKENS record here only when this seam is
    // the one that has to charge them. Both parallel strategies charge their
    // own: a heads fork debits every step as it makes it, and MCTS debits every
    // rollout as it returns — which is what lets an exhausted budget stop
    // either one mid-flight. Charging their totals again here would
    // double-count them.
    //
    // A fork that reported NO total is charged nothing either, for the opposite
    // reason: an unmeasured fork is not a free one, and a fabricated zero would
    // be indistinguishable from a provider that genuinely reported zero. The
    // spawn row is what says the work happened.
    const CHARGE_NOTHING = 0;
    const lump = result.cost.selfMetered ? CHARGE_NOTHING : result.cost.tokens;
    mission?.governor.debit(lump ?? CHARGE_NOTHING, {
      labels: mission.labels,
      spawns: 1,
    });
    const cost: JsonObject = { durationMs: result.cost.durationMs };
    if (result.cost.tokens !== undefined) Object.assign(cost, { tokens: result.cost.tokens });
    if (result.cost.iterations !== undefined) Object.assign(cost, { iterations: result.cost.iterations });
    if (result.cost.selfMetered !== undefined) Object.assign(cost, { selfMetered: result.cost.selfMetered });
    if (result.cost.filesChanged !== undefined) Object.assign(cost, { filesChanged: result.cost.filesChanged });
    const output: JsonObject = {
      strategy: result.strategy,
      text: result.best.text,
      score: result.best.score,
      cost,
    };
    if (result.trace !== undefined) Object.assign(output, { trace: result.trace });
    if (mission) {
      const label = mission.labels[0];
      const snapshot = label ? mission.governor.snapshot(label)[0] : undefined;
      if (snapshot) {
        Object.assign(output, { mission_budget: parseJsonObject(JSON.stringify(snapshot)) });
      }
    }
    return output;
  } catch (err) {
    return { error: `Fork (settle=${settle}) failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Schema assembly ─────────────────────────────────────────────────────────

/** The JSON-Schema properties an action's fields may be advertised under,
 *  DERIVED from AGENTS_ACTION_FIELDS rather than restated beside it: a property
 *  shown to the model that no action's handler reads does not compile. That is
 *  the advertised-vs-parsed half of the same relation `gate:agents-fields`
 *  checks from the declaration side. */
type SchemaPropertiesFor<Action extends AgentsToolAction> =
  { [Field in (typeof AGENTS_ACTION_FIELDS)[Action][number]]?: JsonObject };

type ForkSchemaProperties = SchemaPropertiesFor<'fork'>;

function forkProperties(deps: AgentsToolDeps): ForkSchemaProperties {
  if (!deps.fork) return {};
  const hasMcts = !!deps.fork.registry.get('mcts');
  const properties: ForkSchemaProperties = {
    // Gains the batch-level role the `context` slot of oh-my-pi (can1357/oh-my-pi,
    // the hard fork — upstream pi has no sub-agents at all) has: shared
    // background stated ONCE rather than copied into every fork's brief. Still
    // literally the task — settle=mcts reads only this field (mcts/engine.ts
    // runs on ctx.task and never looks at `forks`) — so the wording has to
    // carry both, and "the concrete task the forks explore together" carried
    // neither past the word `task` itself.
    task: { type: 'string', description: 'For action=fork: the task the forks explore together and the context they share — the goal, the constraints that hold for every fork, and any interface they must agree on. State it here once rather than repeating it in each fork.' },
    forks: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      // Both halves of the relationship, on the field the model fills, because
      // both are now enforced: a brief is only ever RUN by settle=merge, and
      // handing briefs to any other settle is refused instead of silently
      // discarded (forkSettleRefusal).
      description: 'For action=fork: the parallel forks to spawn. Required for settle=merge, the settle that runs them — each brief becomes a real agent with its own multi-step tool loop over this workspace. Refused under settle=mcts, which reads `task` alone and writes its own branches, so briefs handed to it would be discarded rather than run.',
      items: {
        type: 'object',
        required: ['task', 'rationale'],
        properties: {
          // 16 words of guidance ("Be concrete." / "Why this angle matters.")
          // for the most failure-prone artifact in the system. What a brief
          // must carry follows from what a fork can SEE, and that sentence now
          // comes from DELEGATION_INHERITANCE.fork.brief — the same per-action
          // source the rung composes — because the two disagreed: this field
          // said a fork "sees this workspace but not this conversation" while
          // the comment above it said the parent's completed turns ARE its
          // inherited context, which is what the code does. A fork does not see
          // this turn as it continues, and never a sibling's work
          // (heads/controller.ts spawns them with no channel between them), so
          // the acceptance criterion still has to be in the brief: nothing else
          // can tell the fork it is done.
          task: { type: 'string', description: `What this fork explores, complete on its own: the files or surfaces to look at, what to change or find out, and the observable result that means it is done. ${DELEGATION_INHERITANCE.fork.brief}` },
          rationale: { type: 'string', description: 'Why this angle matters — one line, read at the merge to weigh what came back.' },
          // The field said how to set it and never what setting it is FOR, so
          // a first-class capability read as a knob. The caveat belongs on the
          // parameter rather than in the prompt: mixed panels track their
          // AVERAGE member, not their spread (Self-MoA, arXiv 2502.00674), so
          // a weaker model added for variety measurably subtracts — which is
          // exactly the mistake "put different models on it" invites.
          model: {
            type: 'string',
            description: "Per-fork model spec (e.g. 'codex/gpt-5.5'). Omit to inherit this agent's. Set it to put a different vendor on a genuinely open question — a panel is only as good as its average member, so a weaker model chosen for variety costs more than it buys.",
          },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this fork may invoke.' },
        },
      },
    },
    // Three distinct behaviours whose names alone do not give them away, and
    // whose semantics lived only in buildMergePrompt (heads/controller.ts) —
    // instructions addressed to the merge model, not to the caller choosing
    // between them. Same three behaviours, stated for the audience that picks.
    merge_strategy: {
      type: 'string',
      enum: ['synthesize', 'best_of', 'consensus'],
      description: 'For action=fork: how the merge reads the forks. Default synthesize — one narrative, disagreements reconciled in favour of the stronger evidence. best_of takes the strongest fork whole. consensus reports what the forks agreed on and hands back each disagreement as an open question, which is what you want when the split itself is the answer you need.',
    },
    budget: { type: 'integer', minimum: 1, maximum: 200, description: 'For action=fork: max iterations.' },
    wall_clock_ms: {
      type: 'integer', minimum: 1000,
      description: 'For action=fork: abort the forks after this many ms. Omit unless the work is genuinely time-boxed — forks run to completion by default, and a deadline cuts them off mid-work.',
    },
    options: { type: 'object', description: 'For action=fork: advanced per-settle tuning. Most callers leave unset.' },
    // The opt-in cumulative cap. Offered on fork, where the host genuinely owns
    // the exploration's model calls and can therefore enforce it; a subordinate
    // runs on its own storage, so `hire` is gated at the spawn seam instead of
    // being handed a cap nothing could hold it to.
    budget_usd: {
      type: 'number', minimum: 0,
      description: 'For action=fork: cumulative USD cap for everything this fork transitively spends — its exploration, its judging, and anything it spawns. Enforced by the host, not by the fork. Omit for no cap.',
    },
    budget_tokens: {
      type: 'integer', minimum: 1,
      description: 'For action=fork: cumulative token cap, same transitive scope as budget_usd.',
    },
    budget_label: {
      type: 'string', maxLength: 120,
      description: 'For action=fork: name the sub-ledger so several fork calls share one cumulative budget. Omit for a fresh one per call.',
    },
  };
  if (hasMcts) {
    properties.settle = {
      type: 'string',
      enum: ['merge', 'mcts'],
      // Settle decides the ARGUMENTS and the mechanism, not just the ending,
      // and the mechanism is measurably different: a merge fork is a real agent
      // holding HEAD_BUILTIN_TOOLS (heads/head-tools.ts) narrowed by its own
      // allowedTools, an mcts branch is one generateText call with no ToolSet
      // that is handed tools as DATA for codegen and scored by execution
      // (cf-backend exploration.ts). "They settle into one answer" implied the
      // tool loop belonged to both.
      description: 'For action=fork: how forks are settled — which decides what the call takes. Default merge — every brief in `forks` (required there) runs as a real agent with its own multi-step tool loop on this workspace, and their findings merge back into this turn. mcts takes no `forks`: it reads `task` alone and writes its own competing approaches, each a single proposal with no tool loop of its own, scored against the others by execution.',
    };
  }
  return properties;
}

type ConverseSchemaProperties = SchemaPropertiesFor<Exclude<AgentsToolAction, 'fork'>>;

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
      timeout_seconds: { type: 'number', description: 'For a peer ask / hire scope=workspace: seconds to wait for the reply (default 120, max 600). On timeout the reply still arrives later as an event.' },
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
 * read (fork cancellation).
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
  // creates or wakes an agent, not just fork. `list`, `dismiss` and `reply`
  // spend nothing and stay available so a stopped run can still wind itself up.
  if (input.action === 'fork' || input.action === 'hire' || input.action === 'ask' || input.action === 'send') {
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
      case 'fork':
        return await runFork(deps.fork!, input, mode, toolOptions, deps.budget);

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
                + 'hire a subordinate here instead (omit scope), or fork.',
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
            ...(deps.fork ? ['fork = spawn 2–6 ephemeral forks of yourself that settle back into this turn.'] : []),
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
        ...forkProperties(deps),
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
        // Reason FIRST, the vocabulary a fork refusal already uses: a call the
        // parse refused is bad input, not a tool that broke.
        return { reason: 'bad_input', error: error instanceof Error ? error.message : String(error) };
      }
      return dispatchAgentsAction(deps, parsed, toolOptions);
    },
  });
}
