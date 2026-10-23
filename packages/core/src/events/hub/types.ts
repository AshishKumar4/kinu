/** Hub types. Spec: docs/ARCHITECTURE.md "Events and ingress". */

import { Data } from 'effect';
import type { WorkMode } from '../../types/turn';
import type { SubagentInheritedContext } from '../../types/subagents';
import type { JsonObject, JsonValue } from '../../utils/json';
import type { MailWoke } from '../../mail/mailbox-api';

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
  | 'computer_cb'      // callback from computer.exec(..., {notify_when})
  | 'peer_async'
  | 'mcp_streamable'
  | 'email_inbound'   // inbound mail via Cloudflare Email Routing → Worker email()
  | 'subagent'     // same-workspace facet spine: parent↔subagent task/report
  | 'self_emit'
  | 'reply_request';

/** Single source for both the route picklist and the type, so a new variant reaches every surface. */
export const EVENT_VARIANTS = [
  'chat',
  'webhook',
  'process_done',
  'timer',
  'peer_agent',
  'subagent_task',    // parent → subagent assignment / conversational injection
  'subagent_report',
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

export type ReplyChannelKind = 'peer_back' | 'email_thread';

export interface ReplyChannelRef {
  id: ReplyChannelId;
  kind: ReplyChannelKind;
}

export type ReplyChannelState = 'open' | 'replied' | 'expired' | 'aborted';

export interface ReplyChannelRow {
  id: ReplyChannelId;
  event_id: EventId;
  kind: ReplyChannelKind;
  holder_addr: string;
  ttl_expires_at: number;
  state: ReplyChannelState;
  created_at: number;
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
  /** What a watcher's check found, which is why it fired (watch.ts): read from outside, never an instruction. */
  watch_brief?: string;
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
export interface SubagentTaskPayload {
  from_workspace: string;
  kind: 'task' | 'message';
  body: string;
  deliverable?: string;
  inherited_context?: SubagentInheritedContext;
  kinu_mode: WorkMode;
  creation_id?: string;
  message_id?: string;
  idempotency_key?: string;
}

/** One declaration read by the event schema, `report` tool, codemode and dispatcher. */
export const SUBAGENT_REPORT_STATUSES = ['progress', 'completed', 'blocked'] as const;

export type SubagentReportStatus = (typeof SUBAGENT_REPORT_STATUSES)[number];

/** Fields a parent acts on; single tuple so what the model is offered is what the parent sees. All
 *  optional. */
export const SUBAGENT_REPORT_HANDOFF_FIELDS = [
  'concerns', 'deviations', 'findings', 'open_work',
] as const;

export type SubagentReportHandoffField = (typeof SUBAGENT_REPORT_HANDOFF_FIELDS)[number];

export type SubagentReportHandoff = {
  readonly [Field in SubagentReportHandoffField]?: readonly string[];
};

/** Enforced at the tool call (actionable), never at render: the brief renders the handoff whole.
 *  Matches {@link EVENT_BRIEF_MAX_CHARS}. */
export const SUBAGENT_REPORT_HANDOFF_MAX_CHARS = 600;

export interface SubagentReportPayload extends SubagentReportHandoff {
  from_subagent: string;
  status: SubagentReportStatus;
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
  /** Where the Mailbox filed it: `mail.read(thread)` reads it. Input's body is not in the event, only here. */
  mail?: { box: string; thread: string; message: string };
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
  | (ReadableEventBase & { variant: 'subagent_task'; payload: SubagentTaskPayload })
  | (ReadableEventBase & { variant: 'subagent_report'; payload: SubagentReportPayload })
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
      ingress: 'computer_cb';
      variant: 'process_done';
      payload: ProcessDonePayload;
      launching_head_trust: TrustLevel;  // captured at computer.exec time
    }
  | {
      ingress: 'computer_cb';
      variant: 'file_changed';
      payload: FileChangedPayload;
      launching_head_trust: TrustLevel;  // captured at computer.exec time
    }
  | {
      ingress: 'peer_async';
      variant: 'peer_agent';
      payload: PeerAgentPayload;
      same_owner: boolean;
    }
  | {
      // One trust domain: possession of the worker-side stub is the authorization.
      ingress: 'subagent';
      variant: 'subagent_task';
      payload: SubagentTaskPayload;
    }
  | {
      ingress: 'subagent';
      variant: 'subagent_report';
      payload: SubagentReportPayload;
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
      /** The verified owner's instruction, or untrusted input (docs/MAIL.md §3). */
      sender_class: MailWoke;
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

export type TriggerKind =
  | 'webhook_durable'
  | 'webhook_ephemeral'
  | 'timer_oneshot'
  | 'timer_cron';

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

export class IngressRejectedError extends Data.TaggedError('IngressRejectedError')<{ readonly message: string }> {
  constructor(public readonly ingress: IngressKind | 'invalid_combination', public readonly reason: string) {
    super({ message: `Ingress ${ingress} rejected: ${reason}` });
  }
}
