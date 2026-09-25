/** Payload visibility gates display and audit storage; trust (separately) gates execution. */

import { createHash, createHmac } from 'node:crypto';
import * as v from 'valibot';
import { evidenceWindow } from '../../utils/evidence-window';
import { REDACTION_ONLY_PATTERNS, SECRET_PATTERNS } from '../../safety/secret-patterns';
import {
  SUBORDINATE_REPORT_HANDOFF_FIELDS,
  type PayloadPolicy, type KinuEvent, type IngressDescriptor, type SubordinateReportHandoff,
} from './types';
import {
  isJsonObject, JsonObjectSchema, parseJsonValue,
  type JsonObject, type JsonValue,
} from '../../utils/json';

/** Lowercased match. */
const SECRET_FIELD_PATTERNS: ReadonlyArray<RegExp> = [
  /^authorization$/i,
  /^cookie$/i,
  /^api[_-]?key$/i,
  /^bearer$/i,
  /^x-api-key$/i,
];

/** Matched as the last separated token so `monkey`/`turkey` are not masked. The split is
 *  case-sensitive (camelCase boundary); only the final comparison is lowercased. */
const SECRET_SUFFIX_TOKENS = new Set(['token', 'key', 'secret', 'password']);

function lastNameToken(name: string): string {
  const tokens = name
    .split(/[_-]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));

  const last = tokens[tokens.length - 1];

  return last === undefined ? '' : last.toLowerCase();
}

export function looksLikeSecretField(name: string): boolean {
  for (const p of SECRET_FIELD_PATTERNS) if (p.test(name)) return true;

  return SECRET_SUFFIX_TOKENS.has(lastNameToken(name));
}

/** Also used by the transcript tool preview, so the two boundaries share one list. */
export function redactPayload(value: JsonValue): JsonValue {
  if (v.is(v.string(), value)) return redactSecrets(value);

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

/** Each pattern with a non-global copy, so a match's mask expands its own groups. */
const REDACTION_PASSES = [...SECRET_PATTERNS, ...REDACTION_ONLY_PATTERNS].map((pattern) => ({
  pattern,
  one: new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '')),
}));

/** Applies `SECRET_PATTERNS` and `REDACTION_ONLY_PATTERNS` per line (a match that is itself a
 *  pattern's `benign` form stays) and masks with `<redacted>`, the marker `redactErrorText` prints. */
export function redactSecrets(text: string): string {
  return text.split('\n').map((line) => {
    let redacted = line;

    for (const { pattern, one } of REDACTION_PASSES) {
      // `benign` judges the match, not the line: prose beside a live key never spares it.
      redacted = redacted.replaceAll(pattern.regex, (match) =>
        pattern.benign?.test(match) === true ? match : match.replace(one, pattern.mask ?? '<redacted>'));
    }

    return redacted;
  }).join('\n');
}

export interface StorageTransform {
  stored: JsonValue;
  opaque_handles?: Array<{ handle: string; size: number; content_type?: string }>;
}

export function applyVisibilityForStorage(
  payload: IngressDescriptor['payload'] | JsonValue,
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
      // The caller writes the side store (e.g. UserDO secret store) before publish.
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

/** Brief budget for variants whose payload is the turn's input; the rest is reachable only via
 *  the spilled reference (`hub/content-spill.ts`). */
export const EVENT_BRIEF_MAX_CHARS = 600;

/** Keeps both ends and states the omitted count in-band, so a partial brief says so. */
function briefWindow(text: string): string {
  return evidenceWindow(text, EVENT_BRIEF_MAX_CHARS);
}

/** Rendered whole: {@link SUBORDINATE_REPORT_HANDOFF_MAX_CHARS} guarantees it fits, and the
 *  handoff has no spill file. */
export function renderSubordinateHandoff(handoff: SubordinateReportHandoff): string {
  let rendered = '';

  for (const field of SUBORDINATE_REPORT_HANDOFF_FIELDS) {
    const entries = handoff[field];

    if (entries === undefined || entries.length === 0) continue;
    rendered += `\n${field}:`;

    for (const entry of entries) rendered += `\n  - ${entry}`;
  }

  return rendered;
}

/** Never includes raw payload bytes for non-`full` visibility. */
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

function storedSize(payload: JsonObject): string {
  const stored = v.safeParse(v.number(), payload.size);

  return stored.success ? String(stored.output) : 'unknown';
}

function briefForVariant(event: KinuEvent): string {
  if (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') {
    const parsed = v.safeParse(JsonObjectSchema, event.payload);
    const visibilityPayload = parsed.success ? parsed.output : {};
    const marker = visibilityPayload._visibility;
    const size = storedSize(visibilityPayload);

    if (marker === 'hash') {
      const digest = visibilityPayload.sha256;

      return `[redacted body: ${v.is(v.string(), digest) ? digest.slice(0, 16) : undefined}... size=${size}]`;
    }

    if (marker === 'hmac') {
      return `[opaque body verified by hmac, size=${size}]`;
    }

    if (marker === 'opaque_handle') {
      // The side store is unreachable to the agent; do not invent a read-back API.
      const handle = v.is(v.string(), visibilityPayload.handle) ? visibilityPayload.handle : 'unknown';

      return `[opaque payload ${handle}: withheld by visibility policy; not readable from this agent]`;
    }

    return '[protected payload unavailable: malformed visibility envelope]';
  }

  switch (event.variant) {
    case 'chat':
      return event.payload.text.slice(0, 200);
    case 'webhook': {
      const p = event.payload;
      const body = JSON.stringify(p.body) ?? 'undefined';
      const full = rest('body', p.body_path, p.body_unsaved);

      return `${p.http_method} body of ${briefWindow(body)}${full}`;
    }

    case 'process_done': {
      const p = event.payload;
      const stderr = p.stderr_excerpt ? ' stderr: ' + p.stderr_excerpt.slice(0, 100) : '';
      const full = rest('stdout', p.full_stdout_handle, p.stdout_unsaved) + rest('stderr', p.full_stderr_handle, p.stderr_unsaved);

      return `${p.command.slice(0, 60)} exit=${p.exit_code}${stderr}${full}`;
    }

    case 'timer': {
      const p = event.payload;

      return p.label ?? (JSON.stringify(p.user_payload) ?? 'undefined').slice(0, 100);
    }

    case 'peer_agent': {
      const p = event.payload;
      const full = rest('message', p.body_path, p.body_unsaved);

      return `${p.topic}: ${briefWindow(JSON.stringify(p.body) ?? 'undefined')}${full}`;
    }

    case 'subordinate_task': {
      // No `inherited_context` prefix: `subordinateBirthMessages` owns the birth context.
      const p = event.payload;
      const deliverable = p.deliverable ? ` [deliverable: ${p.deliverable.slice(0, 100)}]` : '';

      return `${p.kind}: ${briefWindow(p.body)}${deliverable}`;
    }

    case 'subordinate_report': {
      const p = event.payload;
      const task = p.task ? ` [re: ${p.task.slice(0, 80)}]` : '';
      const full = rest('report', p.content_path, p.content_unsaved);

      return `${p.status}${task}: ${briefWindow(p.content)}${full}${renderSubordinateHandoff(p)}`;
    }

    case 'file_changed':
      return `${event.payload.change} ${event.payload.path}`;
    case 'email': {
      const p = event.payload;

      const attachNote = p.attachments?.length > 0
        ? ` [${p.attachments.length} attachment${p.attachments.length === 1 ? '' : 's'}]`
        : '';

      const full = rest('body', p.body_path, p.body_unsaved);

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

function rest(what: string, path: string | undefined, unsaved: string | undefined): string {
  if (path) return ` — full ${what}: ${path}`;

  return unsaved ? ` — full ${what} could not be saved: ${unsaved}` : '';
}