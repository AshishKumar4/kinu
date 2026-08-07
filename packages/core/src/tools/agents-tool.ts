/**
 * `agents` — the ONE delegation tool. Every helper an actor can spawn or talk
 * to lives behind a single surface where the KIND of helper is a parameter:
 *
 *   fork    — 2–6 ephemeral forks of the calling agent (the heads runtime),
 *             each a full multi-step tool loop on the same workspace, settled
 *             by merge (default) or by the MCTS strategy (settle=mcts).
 *   staff   — a persistent named subordinate that keeps its own context
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
 * (heads / mcts strategies untouched), staff/ask/send ride TeamToolDeps'
 * facet substrate, and peer messaging rides PeersToolDeps' EventsHub
 * transport. Which actions exist is decided structurally by which deps the
 * backend wires — see agentsActionsFor.
 */
import { tool, jsonSchema } from 'ai';
import type { LanguageModel, ToolSet } from 'ai';
import {
  AGENTS_TOOL_ACTIONS,
  BUILTIN_TOOL_SPECS,
  DELEGATION_CONVERSE,
  DELEGATION_FRAME,
  DELEGATION_RUNGS,
  type AgentsToolAction,
} from './registry.js';
import { FORK_STRATEGY_ID } from '../strategy/heads.js';
import type { StrategyContext, StrategyRegistry } from '../strategy/types.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { MergeStrategy } from '../heads/types.js';

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

export interface TeamToolDeps {
  /** The workspace's subordinate roster (dismissed entries excluded). */
  list(): Promise<SubordinateRosterEntry[]>;
  /** Create a durable subordinate; its first turn is the mission. */
  spawn(input: {
    name?: string;
    role: string;
    mission: string;
    model?: string;
    /** Trusted caller attribution. The model tool omits this, so its spawns
     * remain orchestrator-created; the interactive UI RPC supplies `user`. */
    createdBy?: 'orchestrator' | 'user';
  }): Promise<{
    name: string; displayName: string;
  }>;
  /** Enqueue a task on the subordinate (drained as its next turn). */
  assign(input: { name: string; task: string; deliverable?: string; deadlineHint?: string }): Promise<{
    ok: true; name: string;
  }>;
  /** Roster row + live snapshot for one subordinate, or the whole roster. */
  status(input: { name?: string }): Promise<unknown>;
  /** Conversational injection into the subordinate's next turn. */
  message(input: { name: string; content: string }): Promise<{ ok: true; name: string }>;
  /** Retire a subordinate. Default is ARCHIVE (facet + context kept, no
   *  longer addressed); storage is wiped only on explicit keepHistory=false. */
  dismiss(input: { name: string; keepHistory?: boolean }): Promise<{
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
  | { status: 'replied'; from: string; reply: unknown }
  | { status: 'no_reply'; note: string }
  | { status: 'rejected'; reason: string };

export type PeerReplyOutcome = { ok: true } | { ok: false; error: string };

export type PeerSpawnOutcome = { agent: string; created: boolean } & PeerAskOutcome;

export interface PeersToolDeps {
  /** The owner's other workspaces' agents this one may address (self excluded). */
  listPeers(): Promise<Array<{ name: string; displayName?: string }>>;
  /** Send-and-await: deliver a message and wait for the peer's reply. */
  ask(input: { agent: string; topic: string; message: string; timeoutMs: number }): Promise<PeerAskOutcome>;
  /** Fire-and-forget: deliver a message without waiting for a reply. */
  send(input: { agent: string; topic: string; message: string }): Promise<PeerSendOutcome>;
  /** Answer a peer message event received this (or an earlier) turn. */
  reply(input: { eventId: string; message: string }): Promise<PeerReplyOutcome>;
  /** Create (or reuse by name) a specialist workspace, message its agent, await the result. */
  spawnWorkspace(input: { name?: string; purpose: string; message: string; timeoutMs: number }): Promise<PeerSpawnOutcome>;
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

// ── Fork (exploration strategy) deps contract ───────────────────────────────

export interface AgentsForkDeps {
  registry: StrategyRegistry;
  rt: AgentRuntime;
  model: LanguageModel;
  /** Build per-strategy infrastructure options the LLM must not set —
   *  e.g. `{ mcts: { session }, heads: { controller, inheritedContext, onPhase } }`.
   *  Called once per fork invocation and deep-merged (one level) under the
   *  caller's options so injected infra survives caller-supplied tuning. */
  defaultOptions?: () => Record<string, unknown>;
}

export interface AgentsToolDeps {
  /** Ephemeral forks (the heads runtime + MCTS settle). Wired wherever the
   *  backend has an exploration substrate — both backends, subordinates too. */
  fork?: AgentsForkDeps;
  /** Persistent subordinates — workspace-orchestrator only. */
  team?: TeamToolDeps;
  /** Cross-workspace peer messaging — workspace-orchestrator only. */
  peers?: PeersToolDeps;
}

/** Which actions this deps set structurally supports. The single gating rule
 *  shared by the tool schema, the system prompt's Delegation section and the
 *  `agents.*` codemode namespace.
 *  Presence-typed so prompt assembly can ask without building fork deps. */
export function agentsActionsFor(deps: { fork?: unknown; team?: unknown; peers?: unknown }): AgentsToolAction[] {
  const converse = !!deps.team || !!deps.peers;
  const present: Record<AgentsToolAction, boolean> = {
    fork: !!deps.fork,
    staff: converse,
    ask: converse,
    send: converse,
    reply: !!deps.peers,
    list: converse,
    dismiss: !!deps.team,
  };
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
    ...(deps.team || deps.peers ? [DELEGATION_RUNGS.staff] : []),
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
  allowedSandboxes?: string[];
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
  merge_model?: string;
  budget?: number;
  wall_clock_ms?: number;
  options?: Record<string, unknown>;
  // staff / converse
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Background-job resume filter, shared by both backends: durable job rows
 * store the tool KIND + input, and only fork work is safely re-runnable (the
 * MCTS search checkpoint / heads re-run path). Returns the fork input to
 * re-execute, translating rows stored by the pre-unification `think` tool
 * (strategy → settle, heads → forks), or null when the job is not resumable.
 */
export function resumableForkInput(kind: string, input: unknown): AgentsToolInput | null {
  if (kind === 'agents') {
    return isPlainObject(input) && input.action === 'fork' ? input as unknown as AgentsToolInput : null;
  }
  if (kind !== 'think' || !isPlainObject(input)) return null;
  const legacy = input as {
    strategy?: string; task?: string; heads?: ForkSpec[];
    merge_strategy?: MergeStrategy; merge_model?: string;
    budget?: number; wall_clock_ms?: number; options?: Record<string, unknown>;
  };
  if (typeof legacy.task !== 'string') return null;
  const settle = legacy.strategy === undefined || legacy.strategy === FORK_STRATEGY_ID
    ? undefined
    : legacy.strategy;
  return {
    action: 'fork',
    task: legacy.task,
    ...(settle !== undefined ? { settle } : {}),
    ...(legacy.heads ? { forks: legacy.heads } : {}),
    ...(legacy.merge_strategy ? { merge_strategy: legacy.merge_strategy } : {}),
    ...(legacy.merge_model ? { merge_model: legacy.merge_model } : {}),
    ...(legacy.budget !== undefined ? { budget: legacy.budget } : {}),
    ...(legacy.wall_clock_ms !== undefined ? { wall_clock_ms: legacy.wall_clock_ms } : {}),
    ...(legacy.options ? { options: legacy.options } : {}),
  };
}

function readAbortSignal(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== 'object' || !('abortSignal' in options)) return undefined;
  const signal = (options as { abortSignal?: unknown }).abortSignal;
  return typeof signal === 'object' && signal !== null && 'aborted' in signal && 'addEventListener' in signal
    ? signal as AbortSignal
    : undefined;
}

// ── Fork dispatch (the former think tool, verbatim semantics) ───────────────

async function runFork(
  deps: AgentsForkDeps,
  input: AgentsToolInput,
  toolOptions: unknown,
): Promise<unknown> {
  if (!input.task) return { error: 'fork requires task' };
  const settle = input.settle ?? 'merge';
  const strategyId = settle === 'merge' ? FORK_STRATEGY_ID : settle;
  const strat = deps.registry.get(strategyId);
  if (!strat) {
    const settles = ['merge', ...deps.registry.list().filter((s) => s.advertised !== false && s.id !== FORK_STRATEGY_ID).map((s) => s.id)];
    return { error: `Unknown settle "${settle}". Available: ${settles.join(', ')}` };
  }

  // One-level deep merge: caller tuning sits alongside injected infra
  // (session / controller / onPhase) instead of replacing the whole
  // per-strategy bag.
  const defaults = deps.defaultOptions?.() ?? {};
  const callerOpts = input.options ?? {};
  const options: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(callerOpts)) {
    const d = options[k];
    options[k] = isPlainObject(d) && isPlainObject(v) ? { ...d, ...v } : v;
  }

  // Ergonomic fork input: fold the typed top-level fields into options.heads,
  // preserving the injected controller/context/onPhase.
  if (input.forks) {
    options.heads = {
      ...(isPlainObject(options.heads) ? options.heads : {}),
      heads: input.forks,
      ...(input.merge_strategy ? { mergeStrategy: input.merge_strategy } : {}),
      ...(input.merge_model ? { mergeModel: input.merge_model } : {}),
    };
  }

  const ctx: StrategyContext = {
    task: input.task,
    rt: deps.rt,
    model: deps.model,
    signal: readAbortSignal(toolOptions),
    budget: {
      // Unset = strategy default (lets stored agent-config overrides apply).
      maxIterations: input.budget,
      // Only set a wall-clock bound when the caller explicitly asks for one.
      // A blanket 60s default silently killed forks mid-work (each fork's
      // sub-agent cold-start alone could eat it); leaving it undefined lets
      // heads fall through to DEFAULT_HEAD_BUDGET (5 min).
      wallClockMs: input.wall_clock_ms,
    },
    options,
  };
  try {
    const result = await strat.explore(ctx);
    return {
      strategy: result.strategy,
      text: result.best.text,
      score: result.best.score,
      trace: result.trace,
      cost: result.cost,
    };
  } catch (err) {
    return { error: `Fork (settle=${settle}) failed: ${(err as Error).message}` };
  }
}

// ── Schema assembly ─────────────────────────────────────────────────────────

type SchemaProps = Record<string, unknown>;

function forkProperties(deps: AgentsToolDeps): SchemaProps {
  if (!deps.fork) return {};
  const hasMcts = !!deps.fork.registry.get('mcts');
  return {
    task: { type: 'string', description: 'For action=fork: the concrete task the forks explore together.' },
    forks: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      description: 'For action=fork: the parallel forks to spawn. Required when settling by merge.',
      items: {
        type: 'object',
        required: ['task', 'rationale'],
        properties: {
          task: { type: 'string', description: 'What this fork explores. Be concrete.' },
          rationale: { type: 'string', description: 'Why this angle matters.' },
          model: { type: 'string', description: "Per-fork model spec (e.g. 'codex/gpt-5.5'). Omit to inherit." },
          allowedSandboxes: { type: 'array', items: { type: 'string' }, description: 'Sandbox namespaces this fork may use.' },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this fork may invoke.' },
        },
      },
    },
    ...(hasMcts ? {
      settle: {
        type: 'string',
        enum: ['merge', 'mcts'],
        description: 'For action=fork: how forks are settled. Default merge — the forks\' findings merge back into this turn. mcts scores competing approaches against each other by execution instead.',
      },
    } : {}),
    merge_strategy: {
      type: 'string',
      enum: ['synthesize', 'best_of', 'consensus'],
      description: 'For action=fork: how to combine fork findings. Default synthesize.',
    },
    merge_model: { type: 'string', description: 'For action=fork: model spec for the merge LLM. Omit to inherit.' },
    budget: { type: 'integer', minimum: 1, maximum: 200, description: 'For action=fork: max iterations.' },
    wall_clock_ms: { type: 'integer', minimum: 1000, description: 'For action=fork: wall-clock cap in ms.' },
    options: { type: 'object', description: 'For action=fork: advanced per-settle tuning. Most callers leave unset.' },
  };
}

function converseProperties(deps: AgentsToolDeps): SchemaProps {
  if (!deps.team && !deps.peers) return {};
  const askTargets = deps.team && deps.peers
    ? 'a subordinate here or a peer workspace agent (subordinate names win a collision)'
    : deps.team ? 'a subordinate' : 'a peer workspace agent';
  return {
    agent: {
      type: 'string',
      description: `Agent name: ${askTargets}. Target for ask/send/dismiss; optional name for staff (auto-generated from the role when omitted) and detail filter for list.`,
    },
    role: { type: 'string', maxLength: 200, description: 'For action=staff: one freeform role/purpose line (e.g. "researcher — competitive landscape").' },
    mission: { type: 'string', maxLength: 20000, description: "For action=staff: the helper's mission — it seeds its identity and runs as its first turn." },
    model: { type: 'string', description: 'For action=staff: optional model spec override (defaults to the workspace model).' },
    ...(deps.peers ? {
      scope: {
        type: 'string',
        enum: ['subordinate', 'workspace'],
        description: 'For action=staff: subordinate (default) staffs THIS workspace; workspace creates (or reuses by name) a specialist workspace of its own, sends `message` to it, and awaits the result.',
      },
    } : {}),
    message: {
      type: 'string', maxLength: 20000,
      description: 'The work or note for ask/send, the answer for reply, or the first delegated task for staff scope=workspace.',
    },
    ...(deps.peers ? {
      topic: { type: 'string', maxLength: 80, description: 'Optional short label for a peer ask/send (default "message").' },
      timeout_seconds: { type: 'number', description: 'For a peer ask / staff scope=workspace: seconds to wait for the reply (default 120, max 600). On timeout the reply still arrives later as an event.' },
      event_id: { type: 'string', description: 'For action=reply: the agent message event id you were given.' },
    } : {}),
    ...(deps.team ? {
      deliverable: { type: 'string', maxLength: 2000, description: 'For ask to a subordinate: what the finished result should be (optional).' },
      deadline_hint: { type: 'string', maxLength: 200, description: 'For ask to a subordinate: optional urgency/deadline hint.' },
      keep_history: { type: 'boolean', description: 'For action=dismiss: keep the subordinate archived with its context (default true). Set false ONLY to permanently wipe its storage.' },
    } : {}),
  };
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
  toolOptions?: unknown,
): Promise<unknown> {
  const actions = agentsActionsFor(deps);
  const team = deps.team;
  const peers = deps.peers;
  const isSubordinate = async (name: string): Promise<boolean> => {
    if (!team) return false;
    try {
      return (await team.list()).some((entry) => entry.name === name);
    } catch {
      return false;
    }
  };

  if (!actions.includes(input.action)) {
    return { error: `action "${input.action}" is not available here. Available: ${actions.join(', ')}` };
  }
  try {
    const topic = input.topic?.trim() || 'message';
    if (topic === PEER_REPLY_TOPIC) {
      return { error: `topic "${PEER_REPLY_TOPIC}" is reserved for transport reply envelopes` };
    }
    switch (input.action) {
      case 'fork':
        return await runFork(deps.fork!, input, toolOptions);

      case 'staff': {
        if ((input.scope ?? 'subordinate') === 'workspace') {
          if (!peers) return { error: 'staff scope=workspace needs the peer transport, which this actor does not have' };
          if (!input.mission || !input.message) return { error: 'staff scope=workspace requires mission and message' };
          return await peers.spawnWorkspace({
            ...(input.agent ? { name: input.agent } : {}),
            purpose: input.mission,
            message: input.message,
            timeoutMs: askTimeoutMs(input.timeout_seconds),
          });
        }
        if (!team) return { error: 'staffing subordinates is not available on this actor' };
        if (!input.role || !input.mission) return { error: 'staff requires role and mission' };
        return await team.spawn({
          ...(input.agent ? { name: input.agent } : {}),
          role: input.role,
          mission: input.mission,
          ...(input.model ? { model: input.model } : {}),
        });
      }

      case 'ask': {
        if (!input.agent || !input.message) return { error: 'ask requires agent and message' };
        if (team && await isSubordinate(input.agent)) {
          await team.assign({
            name: input.agent,
            task: input.message,
            ...(input.deliverable ? { deliverable: input.deliverable } : {}),
            ...(input.deadline_hint ? { deadlineHint: input.deadline_hint } : {}),
          });
          return {
            status: 'working',
            agent: input.agent,
            note: 'Assigned. The subordinate\'s report arrives as an event that wakes you.',
          };
        }
        if (peers) {
          return await peers.ask({
            agent: input.agent, topic, message: input.message,
            timeoutMs: askTimeoutMs(input.timeout_seconds),
          });
        }
        return { error: `unknown agent "${input.agent}" — check the roster with action:"list"` };
      }

      case 'send': {
        if (!input.agent || !input.message) return { error: 'send requires agent and message' };
        if (team && await isSubordinate(input.agent)) {
          await team.message({ name: input.agent, content: input.message });
          return { status: 'delivered', agent: input.agent };
        }
        if (peers) {
          return await peers.send({ agent: input.agent, topic, message: input.message });
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
        return {
          ...(subordinates ? { subordinates } : {}),
          ...(peerRoster ? { peers: peerRoster } : {}),
          ...(empty ? { note: 'No helper agents yet — create one with action:"staff".' } : {}),
        };
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
              'staff = create a persistent named helper. ask = hand an agent work and get its answer back. send = fire-and-forget message. list = the unified roster.',
            ] : []),
            ...(peers ? ['reply = answer an incoming agent message event.'] : []),
            ...(team ? ['dismiss = retire a subordinate (archived by default — its context is kept).'] : []),
          ].join(' '),
        },
        ...forkProperties(deps),
        ...converseProperties(deps),
      },
    }),
    execute: async (input: AgentsToolInput, toolOptions?: unknown) =>
      dispatchAgentsAction(deps, input, toolOptions),
  });
}
