/**
 * Proteus EventsHub — shared types.
 *
 * The whole hub traffics in `ProteusEvent`. New entry points add new variants
 * to the discriminated union; older code keeps working because every variant
 * shares the same `BaseEvent` skeleton.
 *
 * Trust is a four-valued meet-semilattice. Two distinct uses:
 *  - **event trust** stamped at ingress, immutable post-insert
 *  - **head trust** recomputed per LLM step as `min(trust of causal_set)`
 *
 * Tool surface composes from `(headTrust, phase, role)` as a pure function —
 * never via prompt instructions. The runtime is the gate.
 *
 * See docs/ARCHITECTURE.md — "Events and ingress" for the authoritative spec.
 */

// ── Trust ────────────────────────────────────────────────────────

/** Meet-semilattice: `external < authenticated < owner < self`. Merge never
 *  grants, only restricts. */
export type TrustLevel = 'external' | 'authenticated' | 'owner' | 'self';

export const TRUST_ORDER: Record<TrustLevel, number> = {
  external: 0, authenticated: 1, owner: 2, self: 3,
};

// ── Priority ─────────────────────────────────────────────────────

/** Three levels, assigned by the Hub from `(trust, variant)` — never
 *  read from payload. `urgent` preempts the current step; `normal` injects
 *  at the next step boundary; `background` can roll to the next turn. */
export type Priority = 'urgent' | 'normal' | 'background';

// ── Phase ────────────────────────────────────────────────────────

/** Turn phase. Transitions persisted in `agent_log` rows of `kind='phase'`. */
export type Phase = 'idle' | 'linear' | 'heads' | 'reactor' | 'merging';

// ── Visibility ───────────────────────────────────────────────────

/** Payload visibility / storage policy. Orthogonal to trust:
 *  trust gates *execution*; visibility gates *display* + *audit storage*. */
export type PayloadPolicy =
  | 'full'           // store + render as-is
  | 'redact'         // store-as-is, render with secret-shaped fields masked
  | 'hash'           // store sha256 + size + content-type only
  | 'hmac'           // store hmac (proves identity without revealing content)
  | 'opaque_handle'; // store an opaque pointer to a separate secret store

// ── Ingress ──────────────────────────────────────────────────────

/** The codepath that converted an external signal into an event row.
 *  The *only* place trust is derived (see `trust.ts`). */
export type IngressKind =
  | 'chat_ws'         // operator UI over the authenticated app session
  | 'webhook_hmac'    // HMAC-SHA256(timestamp || '.' || body)
  | 'webhook_bearer'  // bearer secret in header or path
  | 'webhook_mtls'    // client certificate
  | 'timer_alarm'     // DO alarm fired
  | 'sandbox_cb'      // callback from sandbox.exec(..., {notify_when})
  | 'process_watch'   // process lifecycle (start/exit) — kept distinct from sandbox_cb
  | 'file_watch'      // sandbox filesystem change
  | 'peer_async'      // receiver-side write from a peer agent
  | 'mcp_streamable'  // MCP tool call from external client
  | 'email_inbound'   // inbound mail via Cloudflare Email Routing → Worker email()
  | 'subordinate'     // same-workspace facet spine: parent↔subordinate task/report
  | 'self_emit'       // emitted by a tool during the agent's own turn
  | 'reply_request';  // operator confirmation reply

// ── Event variants ───────────────────────────────────────────────

export type EventVariant =
  | 'chat'             // operator message via chat_ws
  | 'webhook'          // external HTTP push
  | 'process_done'     // sandbox process completion
  | 'timer'            // alarm fired
  | 'peer_agent'       // cross-agent message
  | 'subordinate_task'    // parent → subordinate assignment / conversational injection
  | 'subordinate_report'  // subordinate → parent progress/completion report
  | 'file_changed'     // sandbox FS event
  | 'email'            // inbound email (Mission Inbox)
  | 'internal'         // tool-emitted within the agent's own turn
  | 'reply_request'    // pending owner-confirmation question
  | 'mcp_chat'         // owner-authenticated MCP call
  | 'mcp_third_party'; // third-party MCP call

// ── Causality / identity ─────────────────────────────────────────

export type EventId = string;     // ULID, monotonic per DO
export type TraceId = string;     // root event id; constant down the causal chain
export type TurnId = string;
export type HeadId = string;
export type TriggerId = string;
export type ReplyChannelId = string;

// ── ReplyChannel ─────────────────────────────────────────────────

/** Reply-channel kinds. The single `reply()` LLM tool dispatches on this. */
export type ReplyChannelKind =
  | 'ws_session'    // open WebSocket — streams tokens
  | 'http_pending'  // held-open HTTP request — 30s TTL
  | 'peer_back'     // async reply to a peer agent — 24h TTL
  | 'mcp_pending'   // open MCP HTTP request — 60s TTL
  | 'email_thread'  // reply lands back on the inbound email's thread — 24h TTL
  | 'none';         // event has no reply channel (timer, file_watch, etc.)

export interface ReplyChannelRef {
  id: ReplyChannelId;
  kind: ReplyChannelKind;
}

export type ReplyChannelState = 'open' | 'replied' | 'expired' | 'aborted';

export interface ReplyChannelRow {
  id: ReplyChannelId;
  event_id: EventId;
  kind: ReplyChannelKind;
  holder_addr: string;                 // DO id / socket id / outbound URL
  ttl_expires_at: number;
  payload_policy: PayloadPolicy;
  state: ReplyChannelState;
  reply_payload: unknown | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
}

// ── Event payloads (per variant) ─────────────────────────────────

export interface ChatPayload {
  text: string;
}

export interface WebhookPayload {
  webhook_id: string;
  http_method: string;
  http_headers: Record<string, string>;
  body: unknown;
  delivery_id: string;
}

export interface ProcessDonePayload {
  process_id: string;
  command: string;
  exit_code: number;
  stdout_excerpt: string;
  stderr_excerpt: string;
  duration_ms: number;
  full_stdout_handle?: string;
  full_stderr_handle?: string;
}

export interface TimerPayload {
  trigger_id: TriggerId;
  scheduled_fire_at: number;
  label?: string;
  user_payload?: unknown;
  /** The mission budget this schedule spends against, when it declared one.
   *  Carried on the event so the woken turn — and everything it forks or
   *  staffs — debits the same durable ledger (mission-budget.ts). */
  mission_label?: string;
}

export interface PeerAgentPayload {
  from_agent_name: string;
  from_user_id: string;
  topic: string;
  body: unknown;
  /** Sender-side outbox row id — the receiver-side dedupe key, so redelivery
   *  after a crash is a no-op and repeated topics are NOT collapsed. */
  sender_event_id: string;
  /** True when the sender opened an ask (send-and-await) and holds a
   *  reply waiter — the receiver should answer via its peer-back channel. */
  reply_expected?: boolean;
  /** Workspace path holding the fully serialized `body`, set at ingress when
   *  the body outgrows the brief budget. The brief's slice plus this path is
   *  the reference-plus-digest pair the receiving turn reads back. */
  body_path?: string;
}

export interface FileChangedPayload {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  size?: number;
}

/** Parent workspace → subordinate facet. `task` starts/replaces an
 *  assignment; `message` is a conversational injection into its next turn. */
export interface SubordinateTaskPayload {
  from_workspace: string;
  kind: 'task' | 'message';
  body: string;
  deliverable?: string;
  deadline_hint?: string;
  inherited_context?: string;
}

export type SubordinateReportStatus = 'progress' | 'completed' | 'blocked';

/** Subordinate facet → parent workspace. Reports drain into the
 *  orchestrator's next turn on the standard reactor rail. */
export interface SubordinateReportPayload {
  from_subordinate: string;
  status: SubordinateReportStatus;
  content: string;
  /** The assignment this report answers, when one is active. */
  task?: string;
  /** Workspace path holding the full `content`, set at admission when the
   *  report outgrows the brief budget — without it the parent's turn would
   *  see only the brief's slice and the rest would be unreachable. */
  content_path?: string;
}

export interface EmailAttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
}

export interface EmailPayload {
  /** Envelope sender (SMTP MAIL FROM) — the address the trust gate verified. */
  from: string;
  /** The agent address the mail arrived at (envelope RCPT TO). */
  to: string;
  subject: string;
  /** Top-of-thread text with quoted history stripped. */
  body_text: string;
  /** RFC 5322 Message-ID of the inbound mail — threading + dedupe anchor. */
  message_id: string | null;
  in_reply_to: string | null;
  /** Raw References header (space-separated message ids). */
  references: string | null;
  /** Attachment metadata only — bytes never enter the event log. */
  attachments: EmailAttachmentMeta[];
}

export interface InternalPayload {
  kind: string;
  data: unknown;
}

export interface ReplyRequestPayload {
  question: string;
  schema?: unknown;       // Valibot schema if structured
  awaiting_event_id: EventId;
}

export interface McpChatPayload {
  client_id: string;
  method: string;
  arguments: unknown;
  request_id: string;
}

export interface McpThirdPartyPayload {
  client_id: string;
  client_label: string;
  method: string;
  arguments: unknown;
  request_id: string;
}

// ── Discriminated union over events ──────────────────────────────

/** A persisted event row's typed view. The runtime layer reads `kind='event'`
 *  rows from `agent_log` and projects to this shape. */
export interface BaseEvent {
  id: EventId;
  trace_id: TraceId;
  caused_by: EventId | null;
  ingress: IngressKind;
  variant: EventVariant;
  trust: TrustLevel;
  priority: Priority;
  payload_visibility: PayloadPolicy;
  received_at: number;
  schema_version: number;
  reply_channel: ReplyChannelRef | null;
  dedupe_key: string | null;
}

export type ProteusEvent =
  | (BaseEvent & { variant: 'chat'; payload: ChatPayload })
  | (BaseEvent & { variant: 'webhook'; payload: WebhookPayload })
  | (BaseEvent & { variant: 'process_done'; payload: ProcessDonePayload })
  | (BaseEvent & { variant: 'timer'; payload: TimerPayload })
  | (BaseEvent & { variant: 'peer_agent'; payload: PeerAgentPayload })
  | (BaseEvent & { variant: 'subordinate_task'; payload: SubordinateTaskPayload })
  | (BaseEvent & { variant: 'subordinate_report'; payload: SubordinateReportPayload })
  | (BaseEvent & { variant: 'file_changed'; payload: FileChangedPayload })
  | (BaseEvent & { variant: 'email'; payload: EmailPayload })
  | (BaseEvent & { variant: 'internal'; payload: InternalPayload })
  | (BaseEvent & { variant: 'reply_request'; payload: ReplyRequestPayload })
  | (BaseEvent & { variant: 'mcp_chat'; payload: McpChatPayload })
  | (BaseEvent & { variant: 'mcp_third_party'; payload: McpThirdPartyPayload });

// ── Ingress descriptor (the only way to construct events) ────────

/** What an ingress hands to `EventLog.publish`. The Log derives trust,
 *  priority, visibility from this — those fields are never accepted as
 *  parameters. */
export type IngressDescriptor =
  | {
      ingress: 'chat_ws';
      variant: 'chat';
      payload: ChatPayload;
      operator_user_id: string;
      session_id: string;
    }
  | {
      ingress: 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls';
      variant: 'webhook';
      payload: WebhookPayload;
      auth_outcome: 'verified';   // ingress only calls publish AFTER auth
      webhook_id: string;
    }
  | {
      ingress: 'timer_alarm';
      variant: 'timer';
      payload: TimerPayload;
      trigger_creator_trust: TrustLevel; // recorded on trigger row at creation
    }
  | {
      ingress: 'sandbox_cb';
      variant: 'process_done' | 'file_changed';
      payload: ProcessDonePayload | FileChangedPayload;
      launching_head_trust: TrustLevel;  // captured at sandbox.exec time
    }
  | {
      ingress: 'process_watch';
      variant: 'process_done';
      payload: ProcessDonePayload;
      launching_head_trust: TrustLevel;
    }
  | {
      ingress: 'file_watch';
      variant: 'file_changed';
      payload: FileChangedPayload;
      launching_head_trust: TrustLevel;
    }
  | {
      ingress: 'peer_async';
      variant: 'peer_agent';
      payload: PeerAgentPayload;
      same_owner: boolean;
      receiver_grant_present: boolean;   // for cross-owner peers
    }
  | {
      // Same-workspace facet spine — the parent DO and its subordinate facets
      // are one trust domain (one owner, one storage shard), so no grant
      // machinery: possession of the worker-side stub IS the authorization.
      ingress: 'subordinate';
      variant: 'subordinate_task' | 'subordinate_report';
      payload: SubordinateTaskPayload | SubordinateReportPayload;
    }
  | {
      ingress: 'mcp_streamable';
      variant: 'mcp_chat' | 'mcp_third_party';
      payload: McpChatPayload | McpThirdPartyPayload;
    }
  | {
      ingress: 'email_inbound';
      variant: 'email';
      payload: EmailPayload;
      /** How the sender passed the gate — the ingress only calls publish AFTER
       *  verifying the envelope sender against the owner's verified email or
       *  the agent's email_route allowlist. Unknown senders never publish. */
      sender_class: 'owner' | 'allowlisted';
    }
  | {
      ingress: 'self_emit';
      variant: 'internal';
      payload: InternalPayload;
      emitting_head_trust: TrustLevel;
    }
  | {
      ingress: 'reply_request';
      variant: 'reply_request';
      payload: ReplyRequestPayload;
    };

// ── Reactor decision (orthogonal axes + legality) ────────────────

export type HeadOp =
  | { kind: 'keep' }
  | { kind: 'abort_one'; head_id: HeadId; reason: string }
  | { kind: 'abort_all'; reason: string }
  | { kind: 'add'; spec: SpawnHeadSpec }
  | { kind: 'merge_now'; reason: string };

export type EventOp =
  | { kind: 'handle' }
  | { kind: 'defer'; revisit_at: RevisitCondition }
  | { kind: 'drop'; reason: string };

export interface ReactorDecision {
  head_op: HeadOp;
  event_op: EventOp;
  reasoning: string;       // 3-5 sentence CoT; recorded for offline eval
}

/** Mechanically-enforceable predicate on (head_op, event_op). See §5.2. */
export function isLegalDecision(d: ReactorDecision, ctx: {
  reactor_head_trust: TrustLevel;
  events_trust_class: TrustLevel; // trust of the event(s) being reacted to
  current_phase: Phase;
}): boolean {
  // `drop` requires reactor head trust >= authenticated AND event trust = external.
  if (d.event_op.kind === 'drop') {
    if (TRUST_ORDER[ctx.reactor_head_trust] < TRUST_ORDER.authenticated) return false;
    if (ctx.events_trust_class !== 'external') return false;
  }
  // `abort_one`, `abort_all`, `add` require `eventOp: handle` (you can't
  // defer/drop while also acting on heads in response to the event).
  if (d.head_op.kind === 'abort_one' || d.head_op.kind === 'abort_all' || d.head_op.kind === 'add') {
    if (d.event_op.kind !== 'handle') return false;
  }
  // `merge_now` permits handle or defer but not drop.
  if (d.head_op.kind === 'merge_now' && d.event_op.kind === 'drop') return false;
  // `add` after merge has begun is rejected.
  if (d.head_op.kind === 'add' && ctx.current_phase === 'merging') return false;
  return true;
}

// ── Spawn / revisit specs ────────────────────────────────────────

export interface SpawnHeadSpec {
  task: string;
  rationale: string;
  bound_event_ids: EventId[];
  budget?: { max_steps?: number; max_tokens?: number };
}

/** Enumerated revisit conditions. No free-form predicates — the Hub must
 *  be able to index and evaluate these without an LLM. */
export type RevisitCondition =
  | { kind: 'at'; ts: number }
  | { kind: 'after_phase'; phase: 'idle' | 'merging' }
  | { kind: 'after_event'; variant: EventVariant; source?: string }
  | { kind: 'after_seconds'; n: number };       // n capped at 3600

// ── agent_log row (storage shape) ────────────────────────────────

/** The kinds of rows in `agent_log`. Discriminated by `kind`. */
export type AgentLogKind =
  | 'event'             // a ProteusEvent
  | 'phase'             // phase transition
  | 'step'              // one LLM step
  | 'tool_call'         // a tool invocation
  | 'tool_result'       // its result
  | 'reactor_decision'  // a reactor's output
  | 'reply_attempt';    // an attempt to deliver a reply

export interface AgentLogRow {
  id: string;
  kind: AgentLogKind;
  turn_id: TurnId | null;
  step_idx: number | null;
  parent_id: string | null;
  trace_id: TraceId;
  ingress: IngressKind | null;
  variant: EventVariant | null;
  trust: TrustLevel | null;
  priority: Priority | null;
  payload_visibility: PayloadPolicy | null;
  payload: unknown;
  received_at: number;
  schema_version: number;
  dedupe_key: string | null;
}

// ── Trigger registry ─────────────────────────────────────────────

export type TriggerKind =
  | 'webhook_durable'
  | 'webhook_ephemeral'
  | 'timer_oneshot'
  | 'timer_cron'
  | 'process_watch'
  | 'file_watch'
  | 'peer_inbox'
  | 'mcp_route'
  | 'email_route';   // per-agent inbound-email allowlist (owner is always allowed)

export interface TriggerRow {
  id: TriggerId;
  kind: TriggerKind;
  /** Defining configuration; shape depends on kind. */
  spec: Record<string, unknown>;
  /** Trust at creation time. Inherited by timer/scheduled events. */
  creator_trust: TrustLevel;
  /** Fork policy override; null → use default per kind. */
  fork_policy: 'copy' | 'sever' | 'share' | null;
  state: 'active' | 'paused' | 'revoked';
  created_at: number;
  paused_at: number | null;
  revoked_at: number | null;
  /** Per-trigger rate limits (events/minute). */
  rate_limit_per_min: number;
  /** Next scheduled fire time for timer-like triggers, epoch ms. */
  next_fire_at: number | null;
  /** Last time this trigger fired, epoch ms. */
  last_fire_at: number | null;
  /** Number of times this trigger has fired. */
  fire_count: number;
}

// ── Tool surface composition ─────────────────────────────────────

export type Role = 'worker' | 'reactor';

export interface ToolSurfaceContext {
  head_trust: TrustLevel;
  phase: Phase;
  role: Role;
}

// ── Phase transitions / errors ───────────────────────────────────

export class TrustViolationError extends Error {
  constructor(public readonly attempted: TrustLevel, public readonly required: TrustLevel) {
    super(`Trust violation: have ${attempted}, need ${required}`);
    this.name = 'TrustViolationError';
  }
}

export class IngressRejectedError extends Error {
  constructor(public readonly ingress: IngressKind, public readonly reason: string) {
    super(`Ingress ${ingress} rejected: ${reason}`);
    this.name = 'IngressRejectedError';
  }
}
