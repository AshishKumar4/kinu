/** Hub types. Spec: docs/ARCHITECTURE.md "Events and ingress". */

import { Data } from 'effect';
import * as v from 'valibot';
import { WorkModeSchema } from '../../types/turn';
import { ScheduleTierSchema } from '../../types/profile';
import { SubagentInheritedContextSchema } from '../../types/subagents';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../../utils/json';
import type { MailWoke } from '../../mail/mailbox-api';

/** Meet-semilattice `external < authenticated < owner < self`; merge only restricts. */
export const TrustSchema = v.picklist(['external', 'authenticated', 'owner', 'self']);

export type TrustLevel = v.InferOutput<typeof TrustSchema>;

export const TRUST_ORDER = {
  external: 0, authenticated: 1, owner: 2, self: 3,
} satisfies Record<TrustLevel, number>;

/** Derived from `(trust, variant)`. `urgent` preempts the step; `normal` injects at the next step
 *  boundary; `background` may roll to the next turn. */
export const PrioritySchema = v.picklist(['urgent', 'normal', 'background']);

export type Priority = v.InferOutput<typeof PrioritySchema>;

export type Phase = 'idle' | 'linear' | 'heads' | 'reactor' | 'merging';

export const PayloadPolicySchema = v.picklist(['full', 'redact', 'hash', 'hmac', 'opaque_handle']);

export type PayloadPolicy = v.InferOutput<typeof PayloadPolicySchema>;

/** `webhook_bearer`: a bearer secret in a header or the path. `computer_cb`: a callback from `computer.exec(...,
 *  {notify_when})`. `email_inbound`: mail through Cloudflare Email Routing to the Worker's `email()`. `subagent`: the
 *  same-workspace facet spine, parent and subagent task and report. */
export const IngressSchema = v.picklist([
  'chat_ws', 'webhook_hmac', 'webhook_bearer', 'webhook_mtls', 'timer_alarm', 'computer_cb', 'peer_async', 'mcp_streamable',
  'email_inbound', 'subagent', 'self_emit', 'reply_request',
]);

export type IngressKind = v.InferOutput<typeof IngressSchema>;

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

export const VariantSchema = v.picklist(EVENT_VARIANTS);

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

const NullableString = v.nullable(v.string());

export const ChatPayloadSchema = v.object({ text: v.string() });

export type ChatPayload = v.InferOutput<typeof ChatPayloadSchema>;

export const WebhookPayloadSchema = v.object({
  webhook_id: v.string(),
  http_method: v.string(),
  http_headers: v.record(v.string(), v.string()),
  body: v.unknown(),
  delivery_id: v.string(),
  /** Set when the body outgrew the brief budget. */
  body_path: v.optional(v.string()),
  /** Set instead of `body_path` when the spill failed. */
  body_unsaved: v.optional(v.string()),
});

export type WebhookPayload = v.InferOutput<typeof WebhookPayloadSchema>;

export const ProcessDonePayloadSchema = v.object({
  process_id: v.string(),
  command: v.string(),
  exit_code: v.number(),
  stdout_excerpt: v.string(),
  stderr_excerpt: v.string(),
  duration_ms: v.number(),
  full_stdout_handle: v.optional(v.string()),
  full_stderr_handle: v.optional(v.string()),
  stdout_unsaved: v.optional(v.string()),
  stderr_unsaved: v.optional(v.string()),
});

export type ProcessDonePayload = v.InferOutput<typeof ProcessDonePayloadSchema>;

export const TimerPayloadSchema = v.object({
  trigger_id: v.string(),
  scheduled_fire_at: v.number(),
  label: v.optional(v.string()),
  user_payload: v.optional(v.unknown()),
  /** The woken turn and everything it spawns debit this label (mission-budget.ts). */
  mission_label: v.optional(v.string()),
  /** What a watcher's check found, which is why it fired (watch.ts): read from outside, never an instruction. */
  watch_brief: v.optional(v.string()),
  /** The provider's delivery a watcher's check answered (`input.delivery`), which keys its fire: a redelivery fires once. */
  watch_delivery: v.optional(v.string()),
  /** The tier its schedule's turns run at (`agent.schedule`'s, a blueprint's). */
  tier: v.optional(ScheduleTierSchema),
});

export type TimerPayload = v.InferOutput<typeof TimerPayloadSchema>;

export const PeerAgentPayloadSchema = v.object({
  from_agent_name: v.string(),
  from_user_id: v.string(),
  topic: v.string(),
  body: JsonValueSchema,
  /** Receiver-side dedupe key: crash redelivery is a no-op; repeated topics are not collapsed. */
  sender_event_id: v.string(),
  reply_expected: v.optional(v.boolean()),
  body_path: v.optional(v.string()),
  body_unsaved: v.optional(v.string()),
  kinu_mode: WorkModeSchema,
});

export type PeerAgentPayload = v.InferOutput<typeof PeerAgentPayloadSchema>;

export const FileChangedPayloadSchema = v.object({
  path: v.string(),
  change: v.picklist(['created', 'modified', 'deleted']),
  size: v.optional(v.number()),
});

export type FileChangedPayload = v.InferOutput<typeof FileChangedPayloadSchema>;

/** `task` starts or replaces an assignment; `message` is injected into the next turn. */
export const SubagentTaskPayloadSchema = v.object({
  from_workspace: v.string(),
  kind: v.picklist(['task', 'message']),
  body: v.string(),
  deliverable: v.optional(v.string()),
  inherited_context: v.optional(SubagentInheritedContextSchema),
  kinu_mode: WorkModeSchema,
  creation_id: v.optional(v.string()),
  message_id: v.optional(v.string()),
  idempotency_key: v.optional(v.string()),
});

export type SubagentTaskPayload = v.InferOutput<typeof SubagentTaskPayloadSchema>;

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

/** `v.object` strips unnamed fields; the total `satisfies` makes a forgotten field a compile error. */
const HandoffPayloadEntries = {
  concerns: v.optional(v.pipe(v.array(v.string()), v.readonly())),
  deviations: v.optional(v.pipe(v.array(v.string()), v.readonly())),
  findings: v.optional(v.pipe(v.array(v.string()), v.readonly())),
  open_work: v.optional(v.pipe(v.array(v.string()), v.readonly())),
} satisfies Record<SubagentReportHandoffField, v.GenericSchema<readonly string[] | undefined>>;

export const SubagentReportPayloadSchema = v.object({
  from_subagent: v.string(),
  status: v.picklist(SUBAGENT_REPORT_STATUSES),
  content: v.string(),
  /** Durable identity on both sides; stated by the sender, since a receiver-minted key would be new on every replay. */
  sequence_id: v.string(),
  task: v.optional(v.string()),
  content_path: v.optional(v.string()),
  content_unsaved: v.optional(v.string()),
  ...HandoffPayloadEntries,
  kinu_mode: WorkModeSchema,
});

export type SubagentReportPayload = v.InferOutput<typeof SubagentReportPayloadSchema>;

const EmailAttachmentMetaSchema = v.object({ filename: v.string(), content_type: v.string(), size: v.number() });

export type EmailAttachmentMeta = v.InferOutput<typeof EmailAttachmentMetaSchema>;

export const EmailPayloadSchema = v.object({
  from: v.string(),
  to: v.string(),
  subject: v.string(),
  body_text: v.string(),
  message_id: NullableString,
  in_reply_to: NullableString,
  references: NullableString,
  /** Bytes never enter the event log. */
  attachments: v.array(EmailAttachmentMetaSchema),
  body_path: v.optional(v.string()),
  body_unsaved: v.optional(v.string()),
  /** Where the Mailbox filed it: `mail.read(thread)` reads it. Input's body is not in the event, only here. */
  mail: v.optional(v.object({ box: v.string(), thread: v.string(), message: v.string() })),
});

export type EmailPayload = v.InferOutput<typeof EmailPayloadSchema>;

export const InternalPayloadSchema = v.object({ kind: v.string(), data: v.unknown() });

export type InternalPayload = v.InferOutput<typeof InternalPayloadSchema>;

export const ReplyRequestPayloadSchema = v.object({
  question: v.string(),
  schema: v.optional(v.unknown()),
  awaiting_event_id: v.string(),
});

export type ReplyRequestPayload = v.InferOutput<typeof ReplyRequestPayloadSchema>;

export const McpChatPayloadSchema = v.object({
  client_id: v.string(), method: v.string(), arguments: v.unknown(), request_id: v.string(),
});

export type McpChatPayload = v.InferOutput<typeof McpChatPayloadSchema>;

export const McpThirdPartyPayloadSchema = v.object({
  client_id: v.string(), client_label: v.string(), method: v.string(), arguments: v.unknown(), request_id: v.string(),
});

export type McpThirdPartyPayload = v.InferOutput<typeof McpThirdPartyPayloadSchema>;

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
