/** Hub types. Spec: docs/ARCHITECTURE.md "Events and ingress". */

import type { WorkMode } from '../../types/turn';
import type { SubordinateInheritedContext } from '../../types/subordinates';
import type { JsonObject, JsonValue } from '../../utils/json';

/** Meet-semilattice `external < authenticated < owner < self`; merge only restricts. */
export type TrustLevel = 'external' | 'authenticated' | 'owner' | 'self';

export const TRUST_ORDER = {
  external: 0, authenticated: 1, owner: 2, self: 3,
} satisfies Record<TrustLevel, number>;

/** Derived from `(trust, variant)`. `urgent` preempts the step; `normal` injects at the next step
 *  boundary; `background` may roll to the next turn. */
export type Priority = 'urgent' | 'normal' | 'background';

export type Phase = 'idle' | 'linear' | 'heads' | 'reactor' | 'merging';

export type PayloadPolicy =
  | 'full'
  | 'redact'
  | 'hash'
  | 'hmac'
  | 'opaque_handle';

export type IngressKind =
  | 'chat_ws'
  | 'webhook_hmac'
  | 'webhook_bearer'  // bearer secret in header or path
  | 'webhook_mtls'
  | 'timer_alarm'
  | 'sandbox_cb'      // callback from sandbox.exec(..., {notify_when})
  | 'process_watch'
  | 'file_watch'
  | 'peer_async'
  | 'mcp_streamable'
  | 'email_inbound'   // inbound mail via Cloudflare Email Routing → Worker email()
  | 'subordinate'     // same-workspace facet spine: parent↔subordinate task/report
  | 'self_emit'
  | 'reply_request';

/** Single source for both the route picklist and the type, so a new variant reaches every surface. */
export const EVENT_VARIANTS = [
  'chat',
  'webhook',
  'process_done',
  'timer',
  'peer_agent',
  'subordinate_task',    // parent → subordinate assignment / conversational injection
  'subordinate_report',
  'file_changed',
  'email',
  'internal',
  'reply_request',
  'mcp_chat',
  'mcp_third_party',
] as const;

export type EventVariant = (typeof EVENT_VARIANTS)[number];

export type EventId = string;     // ULID, monotonic per DO

export type TraceId = string;     // root event id; constant down the causal chain

export type TurnId = string;

export type HeadId = string;

export type TriggerId = string;

export type ReplyChannelId = string;

export type ReplyChannelKind =
  | 'ws_session'
  | 'http_pending'
  | 'peer_back'
  | 'mcp_pending'
  | 'email_thread'
  | 'none';

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
  reply_payload: JsonValue | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
}

export interface ChatPayload {
  text: string;
}

export interface WebhookPayload {
  webhook_id: string;
  http_method: string;
  http_headers: Record<string, string>;
  body: unknown;
  delivery_id: string;
  /** Set when the body outgrew the brief budget. */
  body_path?: string;
  /** Set instead of `body_path` when the spill failed. */
  body_unsaved?: string;
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
  stdout_unsaved?: string;
  stderr_unsaved?: string;
}

export interface TimerPayload {
  trigger_id: TriggerId;
  scheduled_fire_at: number;
  label?: string;
  user_payload?: unknown;
  /** The woken turn and everything it spawns debit this label (mission-budget.ts). */
  mission_label?: string;
}

export interface PeerAgentPayload {
  from_agent_name: string;
  from_user_id: string;
  topic: string;
  body: JsonValue;
  /** Receiver-side dedupe key: crash redelivery is a no-op; repeated topics are not collapsed. */
  sender_event_id: string;
  reply_expected?: boolean;
  body_path?: string;
  body_unsaved?: string;
  kinu_mode: WorkMode;
}

export interface FileChangedPayload {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  size?: number;
}

/** `task` starts or replaces an assignment; `message` is injected into the next turn. */
export interface SubordinateTaskPayload {
  from_workspace: string;
  kind: 'task' | 'message';
  body: string;
  deliverable?: string;
  inherited_context?: SubordinateInheritedContext;
  kinu_mode: WorkMode;
  creation_id?: string;
  message_id?: string;
}

/** One declaration read by the event schema, `report` tool, codemode and dispatcher. */
export const SUBORDINATE_REPORT_STATUSES = ['progress', 'completed', 'blocked'] as const;

export type SubordinateReportStatus = (typeof SUBORDINATE_REPORT_STATUSES)[number];

/** Fields a parent acts on; single tuple so what the model is offered is what the parent sees. All
 *  optional. */
export const SUBORDINATE_REPORT_HANDOFF_FIELDS = [
  'concerns', 'deviations', 'findings', 'open_work',
] as const;

export type SubordinateReportHandoffField = (typeof SUBORDINATE_REPORT_HANDOFF_FIELDS)[number];

export type SubordinateReportHandoff = {
  readonly [Field in SubordinateReportHandoffField]?: readonly string[];
};

/** Enforced at the tool call (actionable), never at render: the brief renders the handoff whole.
 *  Matches {@link EVENT_BRIEF_MAX_CHARS}. */
export const SUBORDINATE_REPORT_HANDOFF_MAX_CHARS = 600;

export interface SubordinateReportPayload extends SubordinateReportHandoff {
  from_subordinate: string;
  status: SubordinateReportStatus;
  content: string;
  /** Durable identity on both sides; stated by the sender, since a receiver-minted key would be new
   *  on every replay. */
  sequence_id: string;
  task?: string;
  content_path?: string;
  content_unsaved?: string;
  kinu_mode: WorkMode;
}

export interface EmailAttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
}

export interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  body_text: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  /** Bytes never enter the event log. */
  attachments: EmailAttachmentMeta[];
  body_path?: string;
  body_unsaved?: string;
}

export interface InternalPayload {
  kind: string;
  data: unknown;
}

export interface ReplyRequestPayload {
  question: string;
  schema?: unknown;
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

type ReadableEventBase = BaseEvent & { payload_visibility: 'full' | 'redact' };

export type ReadableKinuEvent =
  | (ReadableEventBase & { variant: 'chat'; payload: ChatPayload })
  | (ReadableEventBase & { variant: 'webhook'; payload: WebhookPayload })
  | (ReadableEventBase & { variant: 'process_done'; payload: ProcessDonePayload })
  | (ReadableEventBase & { variant: 'timer'; payload: TimerPayload })
  | (ReadableEventBase & { variant: 'peer_agent'; payload: PeerAgentPayload })
  | (ReadableEventBase & { variant: 'subordinate_task'; payload: SubordinateTaskPayload })
  | (ReadableEventBase & { variant: 'subordinate_report'; payload: SubordinateReportPayload })
  | (ReadableEventBase & { variant: 'file_changed'; payload: FileChangedPayload })
  | (ReadableEventBase & { variant: 'email'; payload: EmailPayload })
  | (ReadableEventBase & { variant: 'internal'; payload: InternalPayload })
  | (ReadableEventBase & { variant: 'reply_request'; payload: ReplyRequestPayload })
  | (ReadableEventBase & { variant: 'mcp_chat'; payload: McpChatPayload })
  | (ReadableEventBase & { variant: 'mcp_third_party'; payload: McpThirdPartyPayload });

/** Replaced payloads are typed apart so routing code cannot treat a digest as the event body. */
export type ProtectedKinuEvent = BaseEvent & {
  payload_visibility: 'hash' | 'hmac' | 'opaque_handle';
  payload: JsonValue;
};

export type KinuEvent = ReadableKinuEvent | ProtectedKinuEvent;

/** Trust, priority and visibility are derived from this, never accepted as parameters. */
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
      auth_outcome: 'verified';
      webhook_id: string;
    }
  | {
      ingress: 'timer_alarm';
      variant: 'timer';
      payload: TimerPayload;
      trigger_creator_trust: TrustLevel;
    }
  | {
      ingress: 'sandbox_cb';
      variant: 'process_done';
      payload: ProcessDonePayload;
      launching_head_trust: TrustLevel;  // captured at sandbox.exec time
    }
  | {
      ingress: 'sandbox_cb';
      variant: 'file_changed';
      payload: FileChangedPayload;
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
      receiver_grant_present: boolean;
    }
  | {
      // One trust domain: possession of the worker-side stub is the authorization.
      ingress: 'subordinate';
      variant: 'subordinate_task';
      payload: SubordinateTaskPayload;
    }
  | {
      ingress: 'subordinate';
      variant: 'subordinate_report';
      payload: SubordinateReportPayload;
    }
  | {
      ingress: 'mcp_streamable';
      variant: 'mcp_chat';
      payload: McpChatPayload;
    }
  | {
      ingress: 'mcp_streamable';
      variant: 'mcp_third_party';
      payload: McpThirdPartyPayload;
    }
  | {
      ingress: 'email_inbound';
      variant: 'email';
      payload: EmailPayload;
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

/** No free-form predicates: the Hub evaluates these without an LLM. */
export type RevisitCondition =
  | { kind: 'at'; ts: number }
  | { kind: 'after_phase'; phase: 'idle' | 'merging' }
  | { kind: 'after_event'; variant: EventVariant; source?: string }
  | { kind: 'after_seconds'; n: number };       // n capped at 3600

export type AgentLogKind =
  | 'event'
  | 'phase'
  | 'step'
  | 'tool_call'
  | 'tool_result'
  | 'reactor_decision'
  | 'reply_attempt';

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
  spec: JsonObject;
  /** Inherited by timer events. */
  creator_trust: TrustLevel;
  /** Null uses the per-kind default. */
  fork_policy: 'copy' | 'sever' | 'share' | null;
  state: 'active' | 'paused' | 'revoked';
  created_at: number;
  paused_at: number | null;
  revoked_at: number | null;
  rate_limit_per_min: number;
  next_fire_at: number | null;
  last_fire_at: number | null;
  fire_count: number;
}

export type Role = 'worker' | 'reactor';

export interface ToolSurfaceContext {
  head_trust: TrustLevel;
  phase: Phase;
  role: Role;
}

export class IngressRejectedError extends Error {
  constructor(public readonly ingress: IngressKind | 'invalid_combination', public readonly reason: string) {
    super(`Ingress ${ingress} rejected: ${reason}`);
    this.name = 'IngressRejectedError';
  }
}
