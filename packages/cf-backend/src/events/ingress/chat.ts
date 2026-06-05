/**
 * Chat ingress — WebSocket frames → ChatMessageEvent via EventLog.publish.
 *
 * The agent's onChatMessage handler (Think framework) calls
 * `publishChatMessage(...)`. The hub takes over from there: builds a turn,
 * routes through TurnRunner, and dispatches replies via the bound
 * ws_session ReplyChannel.
 *
 * No turn loop here. The chat WS is just one of many ingresses.
 */

import type {
  EventLog, ReplyChannelStore, ReplyChannelKind, ChatPayload, EventId,
} from '@proteus/core';

export interface ChatIngressDeps {
  log: EventLog;
  replies: ReplyChannelStore;
}

export interface IncomingChat {
  text: string;
  attachments?: ChatPayload['attachments'];
  session_id: string;       // WebSocket session id used as reply-channel holder
  operator_user_id: string; // From browser auth middleware
  now: number;
}

export interface ChatIngressResult {
  event_id: EventId;
  admitted: boolean;
  reply_channel_id: string | null;
}

/** Publish a chat event AND open a WS reply channel for it. */
export function publishChatMessage(
  deps: ChatIngressDeps,
  msg: IncomingChat,
): ChatIngressResult {
  const payload: ChatPayload = {
    text: msg.text,
    attachments: msg.attachments,
  };

  // Open a ReplyChannel before publishing so the event row's reply_channel
  // ref is correct. ws_session TTL=0 (bound to socket lifetime).
  const reply_channel_id = deps.replies.open({
    event_id: 'pending',           // patched after publish — see below
    kind: 'ws_session' as ReplyChannelKind,
    holder_addr: msg.session_id,
    payload_policy: 'full',
  }, msg.now);

  const { id, admitted } = deps.log.publish({
    descriptor: {
      ingress: 'chat_ws',
      variant: 'chat',
      payload,
      operator_user_id: msg.operator_user_id,
      session_id: msg.session_id,
    },
    now: msg.now,
    reply_channel: reply_channel_id ? {
      id: reply_channel_id,
      kind: 'ws_session',
    } : undefined,
  });

  return { event_id: id, admitted, reply_channel_id };
}
