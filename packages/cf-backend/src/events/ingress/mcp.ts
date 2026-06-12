/**
 * MCP ingress — Model Context Protocol tool calls → mcp_chat / mcp_third_party
 * events via EventLog.publish.
 *
 * The Proteus MCP server exposes a curated set of tools to external clients.
 * Each invocation maps to one event:
 *
 *   mcp_chat         — owner-authenticated client (operator's IDE)
 *   mcp_third_party  — any other authenticated client
 *
 * Auth happens at the MCP transport layer (bearer / OAuth) BEFORE this
 * handler runs. By the time we publish, we know which mode applies.
 *
 * The reply goes via `mcp_pending` channel (60s TTL).
 */

import {
  type EventLog, type ReplyChannelStore, type ReplyChannelKind,
  type McpChatPayload, type McpThirdPartyPayload,
} from '@proteus/core';

export interface McpIngressDeps {
  log: EventLog;
  replies: ReplyChannelStore;
}

export interface McpInvocation {
  client_id: string;
  client_label: string;
  /** Mapped at the MCP transport: 'owner' if the operator's session,
   *  'third_party' otherwise. */
  client_kind: 'owner' | 'third_party';
  method: string;             // e.g. "tools/call"
  arguments: unknown;
  request_id: string;
  request_addr: string;       // for reply routing
  now: number;
}

const MCP_REPLY_TTL_MS = 60_000;

export function publishMcpInvocation(
  deps: McpIngressDeps,
  inv: McpInvocation,
): { event_id: string; admitted: boolean; reply_channel_id: string | null } {
  const reply_channel_id = deps.replies.open({
    event_id: 'pending',
    kind: 'mcp_pending' as ReplyChannelKind,
    holder_addr: inv.request_addr,
    payload_policy: 'full',
    ttl_ms_override: MCP_REPLY_TTL_MS,
  }, inv.now);

  if (inv.client_kind === 'owner') {
    const payload: McpChatPayload = {
      client_id: inv.client_id,
      method: inv.method,
      arguments: inv.arguments,
      request_id: inv.request_id,
    };
    const { id, admitted } = deps.log.publish({
      descriptor: {
        ingress: 'mcp_streamable',
        variant: 'mcp_chat',
        payload,
      },
      now: inv.now,
      reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'mcp_pending' } : undefined,
    });
    return { event_id: id, admitted, reply_channel_id };
  }

  // third party
  const payload: McpThirdPartyPayload = {
    client_id: inv.client_id,
    client_label: inv.client_label,
    method: inv.method,
    arguments: inv.arguments,
    request_id: inv.request_id,
  };
  const { id, admitted } = deps.log.publish({
    descriptor: {
      ingress: 'mcp_streamable',
      variant: 'mcp_third_party',
      payload,
    },
    now: inv.now,
    reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'mcp_pending' } : undefined,
  });
  return { event_id: id, admitted, reply_channel_id };
}
