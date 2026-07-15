/**
 * Payload visibility — orthogonal to trust.
 *
 * Trust gates EXECUTION (what tools the receiving head can call).
 * Visibility gates DISPLAY + AUDIT STORAGE (what gets persisted and what
 * the LLM sees in its context).
 *
 *   full           — store and render as-is
 *   redact         — store as-is, render with secret-shaped fields masked
 *   hash           — store sha256+size+content-type only
 *   hmac           — store hmac (proves identity without revealing content)
 *   opaque_handle  — store a pointer to a separate secret store
 *
 * Two operations:
 *
 *   `applyVisibilityForStorage(payload, policy, secret?)` — called once at
 *   ingress before INSERT. Determines what actually goes into agent_log.
 *
 *   `renderForLLM(event)` — called per LLM step when building context.
 *   Returns a string suitable for the synthetic `pending_events.poll` tool
 *   result, never raw JSON.
 */

import { createHash, createHmac } from 'node:crypto';
import type { PayloadPolicy, ProteusEvent } from './types.js';

// ── Secret-shape heuristics for `redact` ─────────────────────────

/** Field names whose values are likely secrets. Lowercased match. */
const SECRET_FIELD_PATTERNS: ReadonlyArray<RegExp> = [
  /^authorization$/i,
  /^cookie$/i,
  /^(.*_)?token$/i,
  /^(.*_)?key$/i,
  /^(.*_)?secret$/i,
  /^password$/i,
  /^api[_-]?key$/i,
  /^bearer$/i,
  /^x-api-key$/i,
];

function looksLikeSecretField(name: string): boolean {
  for (const p of SECRET_FIELD_PATTERNS) if (p.test(name)) return true;
  return false;
}

/** Recursively redact field values whose names look secret-shaped. */
function redactPayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = looksLikeSecretField(k) ? `<redacted:${k}>` : redactPayload(v);
  }
  return out;
}

// ── Storage transform ────────────────────────────────────────────

export interface StorageTransform {
  /** What actually goes into the `payload` column. */
  stored: unknown;
  /** Any opaque references created during the transform. */
  opaque_handles?: Array<{ handle: string; size: number; content_type?: string }>;
}

export function applyVisibilityForStorage(
  payload: unknown,
  policy: PayloadPolicy,
  hmacSecret?: string,
): StorageTransform {
  switch (policy) {
    case 'full':
      return { stored: payload };

    case 'redact':
      return { stored: redactPayload(payload) };

    case 'hash': {
      const serialized = JSON.stringify(payload);
      const digest = createHash('sha256').update(serialized).digest('hex');
      return {
        stored: {
          _visibility: 'hash',
          sha256: digest,
          size: serialized.length,
          content_type: detectContentType(payload),
        },
      };
    }

    case 'hmac': {
      if (!hmacSecret) {
        // Without a secret, hmac collapses to hash. Log via the absence in stored.
        return applyVisibilityForStorage(payload, 'hash');
      }
      const serialized = JSON.stringify(payload);
      const mac = createHmac('sha256', hmacSecret).update(serialized).digest('hex');
      return {
        stored: {
          _visibility: 'hmac',
          hmac_sha256: mac,
          size: serialized.length,
          content_type: detectContentType(payload),
        },
      };
    }

    case 'opaque_handle': {
      // Payload itself is replaced; caller is responsible for the side-store
      // write (e.g. UserDO secret store) BEFORE calling publish.
      const handle = `opaque:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
      return {
        stored: { _visibility: 'opaque_handle', handle },
        opaque_handles: [{
          handle,
          size: JSON.stringify(payload).length,
          content_type: detectContentType(payload),
        }],
      };
    }
  }
}

function detectContentType(payload: unknown): string {
  if (payload === null || payload === undefined) return 'null';
  if (typeof payload === 'string') return 'text/plain';
  if (typeof payload === 'number' || typeof payload === 'boolean') return 'primitive';
  if (Array.isArray(payload)) return 'array';
  return 'object';
}

// ── LLM rendering ────────────────────────────────────────────────

/** Compact, human-readable representation of an event for injection into
 *  the LLM context. Never includes raw payload bytes for non-`full`
 *  visibility events. */
export function renderForLLM(event: ProteusEvent): {
  id: string;
  variant: string;
  is_self_caused: boolean;
  triggered_by: string;
  brief: string;
} {
  return {
    id: event.id,
    variant: event.variant,
    is_self_caused: event.ingress === 'self_emit',
    triggered_by: friendlySource(event),
    brief: briefForVariant(event),
  };
}

function friendlySource(event: ProteusEvent): string {
  switch (event.ingress) {
    case 'chat_ws':         return 'chat (operator)';
    case 'webhook_hmac':
    case 'webhook_bearer':
    case 'webhook_mtls': {
      const wh = (event.payload as { webhook_id?: string }).webhook_id ?? 'unknown';
      return `webhook (${wh})`;
    }
    case 'timer_alarm':     return `schedule (${(event.payload as { label?: string }).label ?? 'unlabeled'})`;
    case 'sandbox_cb':
    case 'process_watch':   return `sandbox (${(event.payload as { command?: string }).command?.slice(0, 40) ?? 'process'})`;
    case 'file_watch':      return `file (${(event.payload as { path?: string }).path ?? '?'})`;
    case 'peer_async':      return `peer agent (${(event.payload as { from_agent_name?: string }).from_agent_name ?? '?'})`;
    case 'subordinate':
      return event.variant === 'subordinate_report'
        ? `subordinate (${(event.payload as { from_subordinate?: string }).from_subordinate ?? '?'})`
        : `workspace orchestrator (${(event.payload as { from_workspace?: string }).from_workspace ?? '?'})`;
    case 'email_inbound':   return `email (${(event.payload as { from?: string }).from ?? '?'})`;
    case 'mcp_streamable':
      if (event.variant === 'mcp_chat') return `MCP (operator)`;
      return `MCP (${(event.payload as { client_label?: string }).client_label ?? 'third party'})`;
    case 'self_emit':       return `your earlier action`;
    case 'reply_request':   return `operator reply`;
  }
}

function briefForVariant(event: ProteusEvent): string {
  // `full` visibility events keep payload visible; non-`full` show a redacted
  // / hashed brief. The render function always returns a string short enough
  // for direct prompt injection.
  if (event.payload_visibility !== 'full') {
    const v = event.payload as { _visibility?: string; sha256?: string; size?: number };
    if (v && v._visibility === 'hash') {
      return `[redacted body: ${v.sha256?.slice(0, 16)}... size=${v.size}]`;
    }
    if (v && v._visibility === 'hmac') {
      return `[opaque body verified by hmac, size=${v.size}]`;
    }
    if (v && v._visibility === 'opaque_handle') {
      return `[opaque handle: use read_external_payload(event_id) if authorized]`;
    }
    // `redact` keeps the structure visible.
  }
  switch (event.variant) {
    case 'chat':
      return (event.payload as { text: string }).text.slice(0, 200);
    case 'webhook':
      return `${(event.payload as { http_method: string }).http_method} body of ${
        JSON.stringify((event.payload as { body: unknown }).body).slice(0, 200)
      }`;
    case 'process_done': {
      const p = event.payload as { command: string; exit_code: number; stderr_excerpt: string };
      return `${p.command.slice(0, 60)} exit=${p.exit_code}${p.stderr_excerpt ? ' stderr: ' + p.stderr_excerpt.slice(0, 100) : ''}`;
    }
    case 'timer': {
      const p = event.payload as { label?: string; user_payload?: unknown };
      return p.label ?? JSON.stringify(p.user_payload).slice(0, 100);
    }
    case 'peer_agent': {
      // Peer messages are delegated tasks/answers — a chat-scale budget, not
      // the 150-char telemetry brief, so the receiving turn sees the request.
      const p = event.payload as { topic: string; body: unknown };
      return `${p.topic}: ${JSON.stringify(p.body).slice(0, 600)}`;
    }
    case 'subordinate_task': {
      // Assignments are the subordinate's whole turn input — chat-scale
      // budget, same as peer messages.
      const p = event.payload as {
        kind: string;
        body: string;
        deliverable?: string;
        inherited_context?: string;
      };
      const deliverable = p.deliverable ? ` [deliverable: ${p.deliverable.slice(0, 100)}]` : '';
      const inheritedContext = p.inherited_context ? `${p.inherited_context}\n\n` : '';
      return `${inheritedContext}${p.kind}: ${p.body.slice(0, 600)}${deliverable}`;
    }
    case 'subordinate_report': {
      const p = event.payload as { status: string; content: string; task?: string };
      const task = p.task ? ` [re: ${p.task.slice(0, 80)}]` : '';
      return `${p.status}${task}: ${p.content.slice(0, 600)}`;
    }
    case 'file_changed':
      return `${(event.payload as { change: string; path: string }).change} ${
        (event.payload as { path: string }).path
      }`;
    case 'email': {
      const p = event.payload as { subject: string; body_text: string; attachments?: unknown[] };
      const attachNote = p.attachments && p.attachments.length > 0
        ? ` [${p.attachments.length} attachment${p.attachments.length === 1 ? '' : 's'}]`
        : '';
      return `"${p.subject}"${attachNote}: ${p.body_text.slice(0, 300)}`;
    }
    case 'internal':
      return `${(event.payload as { kind: string }).kind}`;
    case 'reply_request':
      return (event.payload as { question: string }).question.slice(0, 200);
    case 'mcp_chat':
    case 'mcp_third_party': {
      const p = event.payload as { method: string };
      return `${p.method}(...)`;
    }
  }
}
