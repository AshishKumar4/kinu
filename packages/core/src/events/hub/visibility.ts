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
import * as v from 'valibot';
import { evidenceWindow } from '../../prompts/evidence-window';
import type { PayloadPolicy, KinuEvent } from './types';
import {
  isJsonObject, JsonObjectSchema, parseJsonValue,
  type JsonObject, type JsonValue,
} from '../../utils/json';

// ── Secret-shape heuristics for `redact` ─────────────────────────

/** Field names that are always secrets, regardless of position. Lowercased match. */
const SECRET_FIELD_PATTERNS: ReadonlyArray<RegExp> = [
  /^authorization$/i,
  /^cookie$/i,
  /^api[_-]?key$/i,
  /^bearer$/i,
  /^x-api-key$/i,
];

/** Secret suffix words, matched as the last `_`/`-`/camelCase-separated token.
 *  A bare `key$` substring would also mask `monkey`/`turkey`, so the boundary
 *  before the token is required. The split is case-sensitive (a camelCase
 *  boundary is a case transition); only the final comparison is lowercased. */
const SECRET_SUFFIX_TOKENS = new Set(['token', 'key', 'secret', 'password']);

function lastNameToken(name: string): string {
  const tokens = name
    .split(/[_-]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));
  const last = tokens[tokens.length - 1];
  return last === undefined ? '' : last.toLowerCase();
}

function looksLikeSecretField(name: string): boolean {
  for (const p of SECRET_FIELD_PATTERNS) if (p.test(name)) return true;
  return SECRET_SUFFIX_TOKENS.has(lastNameToken(name));
}

/**
 * Recursively redact field values whose names look secret-shaped.
 *
 * Exported because a SECOND boundary needs this exact policy: the transcript's
 * generic tool preview renders tool input, output and errors as raw values, and
 * a tool payload carrying a bearer token is the same shape of accident as an
 * event payload carrying one. One list, two consumers — a near-duplicate
 * heuristic in the UI would drift from this one the first time either is
 * extended.
 */
export function redactPayload(value: JsonValue): JsonValue {
  if (!isJsonObject(value) && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  const redacted: JsonObject = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    redacted[field] = looksLikeSecretField(field)
      ? `<redacted:${field}>`
      : redactPayload(fieldValue);
  }
  return redacted;
}

// ── Storage transform ────────────────────────────────────────────

export interface StorageTransform {
  /** What actually goes into the `payload` column. */
  stored: JsonValue;
  /** Any opaque references created during the transform. */
  opaque_handles?: Array<{ handle: string; size: number; content_type?: string }>;
}

export function applyVisibilityForStorage<T>(
  payload: T,
  policy: PayloadPolicy,
  hmacSecret?: string,
): StorageTransform {
  const serializedPayload = JSON.stringify(payload);
  if (serializedPayload === undefined) {
    throw new Error('event payload must be JSON-serializable');
  }
  const admittedPayload = parseJsonValue(serializedPayload);
  switch (policy) {
    case 'full':
      return { stored: admittedPayload };

    case 'redact':
      return { stored: redactPayload(admittedPayload) };

    case 'hash': {
      const serialized = JSON.stringify(admittedPayload);
      const digest = createHash('sha256').update(serialized).digest('hex');
      return {
        stored: {
          _visibility: 'hash',
          sha256: digest,
          size: serialized.length,
          content_type: detectContentType(admittedPayload),
        },
      };
    }

    case 'hmac': {
      if (!hmacSecret) {
        // Without a secret, hmac collapses to hash. Log via the absence in stored.
        return applyVisibilityForStorage(payload, 'hash');
      }
      const serialized = JSON.stringify(admittedPayload);
      const mac = createHmac('sha256', hmacSecret).update(serialized).digest('hex');
      return {
        stored: {
          _visibility: 'hmac',
          hmac_sha256: mac,
          size: serialized.length,
          content_type: detectContentType(admittedPayload),
        },
      };
    }

    case 'opaque_handle': {
      // Payload itself is replaced; caller is responsible for the side-store
      // write (e.g. UserDO secret store) BEFORE calling publish.
      const serialized = JSON.stringify(admittedPayload);
      const handle = `opaque:${createHash('sha256').update(serialized).digest('hex').slice(0, 16)}`;
      return {
        stored: { _visibility: 'opaque_handle', handle },
        opaque_handles: [{
          handle,
          size: serialized.length,
          content_type: detectContentType(admittedPayload),
        }],
      };
    }
  }
}

function detectContentType(payload: JsonValue): string {
  if (payload === null) return 'null';
  if (v.is(v.string(), payload)) return 'text/plain';
  if (v.is(v.union([v.number(), v.boolean()]), payload)) return 'primitive';
  if (Array.isArray(payload)) return 'array';
  return 'object';
}

// ── LLM rendering ────────────────────────────────────────────────

/** Chat-scale brief budget for the variants whose payload IS the receiving
 *  turn's input (peer messages, subordinate assignments and reports) — not
 *  the 150-char telemetry brief. Content beyond it is only reachable through
 *  the spilled reference (`events/hub/content-spill.ts`). */
export const EVENT_BRIEF_MAX_CHARS = 600;

/**
 * One brief's body — bounded, and honest about it.
 *
 * Every variant whose payload IS the woken turn's input renders through this.
 * A head slice alone is the defect the spill path was built to close from the
 * other side: the agent is woken BY a message, shown its opening, and has no
 * way to tell that what it read was a fragment. `evidenceWindow` keeps both
 * ends and states the omitted count in-band, so the brief says it is partial
 * even in the case the spill could not write a path to the rest.
 */
function briefWindow(text: string): string {
  return evidenceWindow(text, EVENT_BRIEF_MAX_CHARS);
}

/** Compact, human-readable representation of an event for injection into
 *  the LLM context. Never includes raw payload bytes for non-`full`
 *  visibility events. */
export function renderForLLM(event: KinuEvent) {
  return {
    id: event.id,
    variant: event.variant,
    is_self_caused: event.ingress === 'self_emit',
    triggered_by: friendlySource(event),
    brief: briefForVariant(event),
  };
}

function friendlySource(event: KinuEvent): string {
  const parsedPayload = v.safeParse(JsonObjectSchema, event.payload);
  const payload = parsedPayload.success ? parsedPayload.output : {};
  const text = (field: string, fallback: string): string => {
    const value = payload[field];
    return v.is(v.string(), value) ? value : fallback;
  };
  switch (event.ingress) {
    case 'chat_ws':         return 'chat (operator)';
    case 'webhook_hmac':
    case 'webhook_bearer':
    case 'webhook_mtls': {
      return `webhook (${text('webhook_id', 'unknown')})`;
    }
    case 'timer_alarm':     return `schedule (${text('label', 'unlabeled')})`;
    case 'sandbox_cb':
    case 'process_watch':   return `sandbox (${text('command', 'process').slice(0, 40)})`;
    case 'file_watch':      return `file (${text('path', '?')})`;
    case 'peer_async':      return `peer agent (${text('from_agent_name', '?')})`;
    case 'subordinate':
      return event.variant === 'subordinate_report'
        ? `subordinate (${text('from_subordinate', '?')})`
        : `workspace orchestrator (${text('from_workspace', '?')})`;
    case 'email_inbound':   return `email (${text('from', '?')})`;
    case 'mcp_streamable':
      if (event.variant === 'mcp_chat') return `MCP (operator)`;
      return `MCP (${text('client_label', 'third party')})`;
    case 'self_emit':       return `your earlier action`;
    case 'reply_request':   return `operator reply`;
  }
}

function briefForVariant(event: KinuEvent): string {
  // Hash/HMAC/opaque policies replace the payload. Redaction preserves the
  // domain shape and may continue through the variant renderer below.
  if (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') {
    const parsed = v.safeParse(JsonObjectSchema, event.payload);
    const visibilityPayload = parsed.success ? parsed.output : {};
    const marker = visibilityPayload._visibility;
    const size = visibilityPayload.size;
    if (marker === 'hash') {
      const digest = visibilityPayload.sha256;
      return `[redacted body: ${v.is(v.string(), digest) ? digest.slice(0, 16) : undefined}... size=${size}]`;
    }
    if (marker === 'hmac') {
      return `[opaque body verified by hmac, size=${size}]`;
    }
    if (marker === 'opaque_handle') {
      // The payload was replaced with a pointer into a side store the agent
      // cannot reach (applyVisibilityForStorage). Say so — do not invent a
      // read-back API. This line once instructed the model to call
      // `read_external_payload(event_id)`, which existed nowhere.
      const handle = v.is(v.string(), visibilityPayload.handle) ? visibilityPayload.handle : 'unknown';
      return `[opaque payload ${handle}: withheld by visibility policy; not readable from this agent]`;
    }
    return '[protected payload unavailable: malformed visibility envelope]';
  }
  switch (event.variant) {
    case 'chat':
      return event.payload.text.slice(0, 200);
    case 'webhook': {
      // A webhook body IS the woken turn's input, so it gets the chat-scale
      // budget and an address for the rest. The old 200-char head slice of
      // stringified JSON handed the model syntactically invalid JSON with no
      // marker, no count, and nothing to read back.
      const p = event.payload;
      const body = JSON.stringify(p.body) ?? 'undefined';
      const full = p.body_path ? ` — full body: ${p.body_path}` : '';
      return `${p.http_method} body of ${briefWindow(body)}${full}`;
    }
    case 'process_done': {
      const p = event.payload;
      return `${p.command.slice(0, 60)} exit=${p.exit_code}${p.stderr_excerpt ? ' stderr: ' + p.stderr_excerpt.slice(0, 100) : ''}`;
    }
    case 'timer': {
      const p = event.payload;
      return p.label ?? (JSON.stringify(p.user_payload) ?? 'undefined').slice(0, 100);
    }
    case 'peer_agent': {
      // Peer messages are delegated tasks/answers — the whole delivery, so an
      // oversize body names where its full text was spilled.
      const p = event.payload;
      const full = p.body_path ? ` — full message: ${p.body_path}` : '';
      return `${p.topic}: ${briefWindow(JSON.stringify(p.body) ?? 'undefined')}${full}`;
    }
    case 'subordinate_task': {
      // Assignments are the subordinate's whole turn input — chat-scale
      // budget, same as peer messages.
      const p = event.payload;
      const deliverable = p.deliverable ? ` [deliverable: ${p.deliverable.slice(0, 100)}]` : '';
      const inheritedContext = p.inherited_context ? `${p.inherited_context}\n\n` : '';
      return `${inheritedContext}${p.kind}: ${briefWindow(p.body)}${deliverable}`;
    }
    case 'subordinate_report': {
      const p = event.payload;
      const task = p.task ? ` [re: ${p.task.slice(0, 80)}]` : '';
      const full = p.content_path ? ` — full report: ${p.content_path}` : '';
      return `${p.status}${task}: ${briefWindow(p.content)}${full}`;
    }
    case 'file_changed':
      return `${event.payload.change} ${event.payload.path}`;
    case 'email': {
      // Same treatment as a peer message: the mail IS the woken turn's input.
      const p = event.payload;
      const attachNote = p.attachments?.length > 0
        ? ` [${p.attachments.length} attachment${p.attachments.length === 1 ? '' : 's'}]`
        : '';
      const full = p.body_path ? ` — full body: ${p.body_path}` : '';
      return `"${p.subject}"${attachNote}: ${briefWindow(p.body_text)}${full}`;
    }
    case 'internal':
      return event.payload.kind;
    case 'reply_request':
      return event.payload.question.slice(0, 200);
    case 'mcp_chat':
    case 'mcp_third_party': {
      return `${event.payload.method}(...)`;
    }
  }
}
