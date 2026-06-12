/**
 * LLM-facing tool surface for the EventsHub.
 *
 * Three concerns live here:
 *
 *   1. The catalog of tool names that the hub introduces.
 *   2. The pure function `composeToolSurface(ctx) → string[]` that decides
 *      WHICH tools a given head sees, based on `(head_trust, phase, role)`.
 *      This is the §4 table from the spec, encoded mechanically.
 *   3. Valibot schemas for each tool's parameters. The cf-backend wires the
 *      actual implementations; this module owns the contract.
 *
 * Workers under `external` head trust get a strict read-only + sandboxed
 * subset (no schedule, no register_*, no send_to_agent, no scaffold_*).
 * Reactors always see REACTOR_CONTROL (which is fixed regardless of
 * head trust); targets are scoped by the snapshot.
 */

import * as v from 'valibot';
import {
  TRUST_ORDER, type Phase, type Role, type ToolSurfaceContext, type TrustLevel,
} from './types.js';
import { RevisitConditionSchema } from './reactor.js';

// ── Tool name catalog ────────────────────────────────────────────

/** Workers (the heads that do the actual task work) may see these. */
export const WORKER_TOOLS = {
  // Reply (the one tool that dispatches via current_reply_channel)
  REPLY: 'reply',

  // Triggers (durable scheduling + registration)
  SCHEDULE_AT: 'schedule_at',
  SCHEDULE_CRON: 'schedule_cron',
  CANCEL_SCHEDULED: 'cancel_scheduled',
  LIST_MY_TRIGGERS: 'list_my_triggers',
  REGISTER_EPHEMERAL_WEBHOOK: 'register_ephemeral_webhook',
  LIST_MY_ENDPOINTS: 'list_my_endpoints',

  // Sandbox (one tool, two modes)
  SANDBOX_EXEC: 'sandbox.exec',

  // Cross-agent
  SEND_TO_AGENT: 'send_to_agent',

  // Event lifecycle (deferred handling)
  DEFER_EVENT: 'defer_event',
  DISMISS_EVENT: 'dismiss_event',
  REPLAY_EVENT: 'replay_event',

  // Read
  RECENT_EVENTS: 'recent_events',
  LIST_PENDING_EVENTS: 'list_pending_events',

  // Mutation (owner-only)
  SCAFFOLD_REWRITE: 'scaffold_rewrite',
  FORK_AGENT: 'fork_agent',
  REGISTER_DURABLE_WEBHOOK: 'register_durable_webhook',
  CRAFT_TOOL: 'craft_tool',
  MCP_INVOKE: 'mcp_invoke',

  // Read-only opaque-handle escape
  READ_EXTERNAL_PAYLOAD: 'read_external_payload',
} as const;

/** The fixed reactor toolset. Returned from `composeToolSurface` when role=reactor.
 *  These are NOT typical tools — the reactor commits to a single structured
 *  decision (see ReactorOutputSchema in reactor.ts). Names included here for
 *  documentation + observability. */
export const REACTOR_CONTROL_TOOLS = [
  'read_head_state',
  'abort_head',
  'abort_all_heads',
  'spawn_additional_head',
  'force_merge_now',
  'defer_event',
  'mark_event_handled',
] as const;

/** All builtin tools a worker might see at owner trust. */
const FULL_WORKER_SET: ReadonlyArray<string> = Object.values(WORKER_TOOLS);

const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  WORKER_TOOLS.SCAFFOLD_REWRITE,
  WORKER_TOOLS.FORK_AGENT,
  WORKER_TOOLS.CRAFT_TOOL,
]);

const SCHEDULE_TOOLS: ReadonlySet<string> = new Set([
  WORKER_TOOLS.SCHEDULE_AT,
  WORKER_TOOLS.SCHEDULE_CRON,
  WORKER_TOOLS.CANCEL_SCHEDULED,
  WORKER_TOOLS.REGISTER_EPHEMERAL_WEBHOOK,
]);

const REGISTER_TOOLS: ReadonlySet<string> = new Set([
  WORKER_TOOLS.REGISTER_EPHEMERAL_WEBHOOK,
  WORKER_TOOLS.REGISTER_DURABLE_WEBHOOK,
]);

const CROSS_OWNER_TOOLS: ReadonlySet<string> = new Set([
  WORKER_TOOLS.SEND_TO_AGENT,
]);

const READONLY_FALLBACK: ReadonlyArray<string> = [
  WORKER_TOOLS.RECENT_EVENTS,
  WORKER_TOOLS.LIST_PENDING_EVENTS,
  WORKER_TOOLS.LIST_MY_TRIGGERS,
  WORKER_TOOLS.LIST_MY_ENDPOINTS,
  WORKER_TOOLS.REPLY,
];

// Sandbox subsetting:
//   owner       — full network + persistent fs
//   authenticated — full network + persistent fs (creator-tracked)
//   external    — network=off, fs=ephemeral; see SANDBOX_PROFILE_FOR
// The cf-backend tool implementation reads SANDBOX_PROFILE_FOR to set
// `--network` / volume mounts at exec time.
export function sandboxProfileFor(headTrust: TrustLevel): SandboxProfile {
  switch (headTrust) {
    case 'owner':
    case 'self':
      return { network: 'on', fs: 'persistent', allow_arbitrary_cmd: true };
    case 'authenticated':
      return { network: 'on', fs: 'persistent', allow_arbitrary_cmd: true };
    case 'external':
      return { network: 'off', fs: 'ephemeral', allow_arbitrary_cmd: true };
  }
}

export interface SandboxProfile {
  network: 'on' | 'off';
  fs: 'persistent' | 'ephemeral';
  allow_arbitrary_cmd: boolean;
}

// ── Compose tool surface (the §4 table) ──────────────────────────

/**
 * The §4 table encoded mechanically. NO prompt phrase gates tools. This
 * function decides which tool names the runtime's tool registry exposes
 * to the LLM for a given (head_trust, phase, role).
 *
 * Worker tool surface narrows with lower trust and with later phases.
 * Reactor surface is fixed regardless of trust (targets are scoped via
 * the snapshot).
 */
export function composeToolSurface(ctx: ToolSurfaceContext): ReadonlyArray<string> {
  if (ctx.role === 'reactor') {
    // Reactor always sees the same tool surface; reactor's "decision" is
    // emitted as structured output, not tool calls. The names are
    // documented but the model only outputs the ReactorOutputSchema JSON.
    return REACTOR_CONTROL_TOOLS;
  }

  // Workers ────────────────────────────────────────────────────────

  // External trust: aggressive narrowing. No schedule, no register, no
  // cross-owner, no scaffold/fork/craft, no mcp_invoke.
  if (ctx.head_trust === 'external') {
    return [
      WORKER_TOOLS.REPLY,
      WORKER_TOOLS.RECENT_EVENTS,
      WORKER_TOOLS.LIST_PENDING_EVENTS,
      WORKER_TOOLS.SANDBOX_EXEC, // network=off + ephemeral fs per sandboxProfileFor
      WORKER_TOOLS.DEFER_EVENT,
      WORKER_TOOLS.DISMISS_EVENT,
    ];
  }

  // Merging phase: read-only across all trust levels.
  if (ctx.phase === 'merging') {
    return READONLY_FALLBACK;
  }

  // Authenticated trust: subtract scaffold mutation + cross-owner + durable webhooks.
  if (ctx.head_trust === 'authenticated') {
    const out: string[] = [];
    for (const t of FULL_WORKER_SET) {
      if (MUTATION_TOOLS.has(t)) continue;
      if (CROSS_OWNER_TOOLS.has(t)) continue;
      if (t === WORKER_TOOLS.REGISTER_DURABLE_WEBHOOK) continue;
      // Heads phase: no mutation tools beyond what's already gone.
      if (ctx.phase === 'heads' && MUTATION_TOOLS.has(t)) continue;
      out.push(t);
    }
    return out;
  }

  // Owner trust + self trust: FULL set in LINEAR.
  // Heads phase: subtract mutation tools (scaffold rewrite, fork, craft).
  // Merging phase: read-only (handled above).
  if (ctx.phase === 'heads') {
    return FULL_WORKER_SET.filter(t => !MUTATION_TOOLS.has(t));
  }
  return FULL_WORKER_SET;
}

// ── Tool parameter schemas (Valibot) ─────────────────────────────

export const ScheduleAtParams = v.object({
  at: v.pipe(v.number(), v.integer(), v.minValue(0)),
  label: v.optional(v.pipe(v.string(), v.maxLength(120))),
  payload: v.optional(v.unknown()),
});

export const ScheduleCronParams = v.object({
  cron: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  label: v.optional(v.pipe(v.string(), v.maxLength(120))),
  payload: v.optional(v.unknown()),
});

export const CancelScheduledParams = v.object({
  trigger_id: v.pipe(v.string(), v.minLength(1)),
});

export const RegisterEphemeralWebhookParams = v.object({
  purpose: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ttl_seconds: v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(86400)),
  auth_mode: v.optional(v.union([v.literal('hmac'), v.literal('bearer')])),
});

export const SandboxExecParams = v.object({
  cmd: v.pipe(v.string(), v.minLength(1)),
  mode: v.union([v.literal('blocking'), v.literal('background')]),
  notify_when: v.optional(v.union([
    v.literal('exit'),
    v.pipe(v.string(), v.regex(/^stdout_match:/)), // "stdout_match:<re>"
    v.pipe(v.string(), v.regex(/^timeout:\d+$/)),  // "timeout:<seconds>"
  ])),
  stdin: v.optional(v.string()),
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});

export const SendToAgentParams = v.object({
  receiver_agent_name: v.pipe(v.string(), v.minLength(1)),
  topic: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  body: v.unknown(),
});

export const ReplyParams = v.object({
  content: v.unknown(),
});

export const DeferEventParams = v.object({
  event_id: v.string(),
  revisit_at: RevisitConditionSchema,
});

export const DismissEventParams = v.object({
  event_id: v.string(),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
});

export const ReplayEventParams = v.object({
  event_id: v.string(),
});

export const RecentEventsParams = v.object({
  variant: v.optional(v.string()),
  since: v.optional(v.number()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
});

export const ListPendingEventsParams = v.object({
  min_priority: v.optional(v.union([v.literal('background'), v.literal('normal'), v.literal('urgent')])),
});

// ── Descriptors (name + description + schema) ───────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  schema: v.GenericSchema;
}

export const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  [WORKER_TOOLS.REPLY]: {
    name: WORKER_TOOLS.REPLY,
    description:
      'Send a reply through the channel of the event you are currently handling. ' +
      'The runtime determines the channel mechanically — chat WebSocket, HTTP webhook ' +
      'response, peer-back, or MCP — based on the active event. If there is no reply ' +
      'channel, this call is a no-op and no prose is delivered to the user.',
    schema: ReplyParams,
  },
  [WORKER_TOOLS.SCHEDULE_AT]: {
    name: WORKER_TOOLS.SCHEDULE_AT,
    description:
      'Schedule a one-shot timer event. The Hub will publish a Timer event at the ' +
      'specified unix-ms time. The event\'s payload contains your label + payload field.',
    schema: ScheduleAtParams,
  },
  [WORKER_TOOLS.SCHEDULE_CRON]: {
    name: WORKER_TOOLS.SCHEDULE_CRON,
    description:
      'Schedule a recurring timer event. UTC cron expression. Each firing produces a ' +
      'Timer event. Forking an agent COPIES cron triggers (both fork and parent fire ' +
      'independently); cancel them on the fork if you want only one.',
    schema: ScheduleCronParams,
  },
  [WORKER_TOOLS.CANCEL_SCHEDULED]: {
    name: WORKER_TOOLS.CANCEL_SCHEDULED,
    description:
      'Revoke a previously-scheduled trigger by id. Returns { ok: true } even if the ' +
      'trigger was already revoked (idempotent).',
    schema: CancelScheduledParams,
  },
  [WORKER_TOOLS.LIST_MY_TRIGGERS]: {
    name: WORKER_TOOLS.LIST_MY_TRIGGERS,
    description:
      'List the triggers this agent has registered. Returns id, kind, spec summary, ' +
      'state (active/paused/revoked), next_fire_at, last_fire_at, fire_count.',
    schema: v.object({}),
  },
  [WORKER_TOOLS.REGISTER_EPHEMERAL_WEBHOOK]: {
    name: WORKER_TOOLS.REGISTER_EPHEMERAL_WEBHOOK,
    description:
      'Create a short-lived webhook URL the agent can hand to an external system. ' +
      'TTL is mandatory; the URL is invalidated when the trigger expires. Durable ' +
      'webhooks (for your stable integrations) must be created from the operator UI.',
    schema: RegisterEphemeralWebhookParams,
  },
  [WORKER_TOOLS.LIST_MY_ENDPOINTS]: {
    name: WORKER_TOOLS.LIST_MY_ENDPOINTS,
    description:
      'List the public webhook URLs registered on this agent (both durable and ' +
      'ephemeral). Includes URL, auth mode, and (for ephemeral) TTL remaining.',
    schema: v.object({}),
  },
  [WORKER_TOOLS.SANDBOX_EXEC]: {
    name: WORKER_TOOLS.SANDBOX_EXEC,
    description:
      'Run a command in the agent\'s sandbox. mode="blocking" waits for completion ' +
      'and returns stdout/stderr/exit_code. mode="background" returns immediately with a ' +
      'handle; the Hub publishes a ProcessDone event when the trigger condition ' +
      '(notify_when: "exit" | "stdout_match:<re>" | "timeout:<n>") fires.',
    schema: SandboxExecParams,
  },
  [WORKER_TOOLS.SEND_TO_AGENT]: {
    name: WORKER_TOOLS.SEND_TO_AGENT,
    description:
      'Send a message to another agent. Same-owner messaging is allowed by default; ' +
      'cross-owner requires the receiver to grant access first. Delivery is async ' +
      'via the receiver\'s EventLog; you do not block on receipt.',
    schema: SendToAgentParams,
  },
  [WORKER_TOOLS.DEFER_EVENT]: {
    name: WORKER_TOOLS.DEFER_EVENT,
    description:
      'Push an event to a later turn with an enumerated revisit condition. ' +
      'Conditions: { kind:"at", ts }, { kind:"after_phase", phase:"idle"|"merging" }, ' +
      '{ kind:"after_event", variant, source? }, { kind:"after_seconds", n }. ' +
      'The Hub re-injects the event when the condition is met.',
    schema: DeferEventParams,
  },
  [WORKER_TOOLS.DISMISS_EVENT]: {
    name: WORKER_TOOLS.DISMISS_EVENT,
    description:
      'Explicitly drop an event without acting on it. Audit-logged with reason. ' +
      'Use only when the event is irrelevant; otherwise act on it (acting implicitly ' +
      'marks it handled).',
    schema: DismissEventParams,
  },
  [WORKER_TOOLS.REPLAY_EVENT]: {
    name: WORKER_TOOLS.REPLAY_EVENT,
    description:
      'Re-inject a previously-handled event into the current turn for re-evaluation. ' +
      'Audit-only — produces a new event row with `replay_of` linkage. Useful when ' +
      'you realize an earlier event was mishandled.',
    schema: ReplayEventParams,
  },
  [WORKER_TOOLS.RECENT_EVENTS]: {
    name: WORKER_TOOLS.RECENT_EVENTS,
    description:
      'Query recent events on this agent. Returns id, variant, trust, priority, ' +
      'triggered_by, brief. Use to recall context across turns.',
    schema: RecentEventsParams,
  },
  [WORKER_TOOLS.LIST_PENDING_EVENTS]: {
    name: WORKER_TOOLS.LIST_PENDING_EVENTS,
    description:
      'List events queued for handling but not yet bound to a turn. Useful to ' +
      'understand the backlog you may be asked to react to.',
    schema: ListPendingEventsParams,
  },
};

// ── Trust-gating helper ──────────────────────────────────────────

/** True iff the head trust is at least as high as required. */
export function trustGate(headTrust: TrustLevel, required: TrustLevel): boolean {
  return TRUST_ORDER[headTrust] >= TRUST_ORDER[required];
}
