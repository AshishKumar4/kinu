/**
 * Diagnostics sink: console first (it replaces, so console must stay), then Analytics Engine.
 * Publishes only allowlisted field names, never the cause chain. A DO is its own isolate, so this
 * must be installed in each; DO-side measured rows go through `record.ts` instead.
 */
import { ERROR_CODES, type ErrorCode, type KinuError } from '../error';
import {
  createCompositeLogger, createConsoleLogger, diagnostics, setDiagnosticsSink,
  type LogEventName, type LogFields, type Logger,
} from '../log';
import * as v from 'valibot';
import { boundaryOf, eventFamily } from './boundaries';
import { analyticsDigest, assertPublishableNames } from './privacy';
import { AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA, type AnalyticsRow } from './schemas';
import { FiniteNumber, analyticsPlane, type AnalyticsEnv } from './writer';

/** Routes to the ops dataset; the tail after the prefix becomes the `operation` slot. */
const CONTROL_PLANE_PREFIX = 'control_plane.';

/**
 * The privacy mechanism: a field not named here is never written. `outcome`, `reason` and `code`
 * are additionally checked against their vocabulary, since a right name can carry prose.
 */
const PUBLISHABLE_TEXT = [
  'workspace', 'agentKind', 'provider', 'model', 'tool', 'source',
  'outcome', 'reason', 'code', 'targetKind', 'target', 'actor', 'operation',
] as const;

const PUBLISHABLE_NUMBERS = [
  'durationMs', 'ttftMs', 'steps', 'toolCalls', 'affected',
] as const;

assertPublishableNames('the diagnostics sink allowlist', [
  ...PUBLISHABLE_TEXT,
  ...PUBLISHABLE_NUMBERS,
]);

type PublishableText = (typeof PUBLISHABLE_TEXT)[number];

type PublishableNumber = (typeof PUBLISHABLE_NUMBERS)[number];

/** A non-string is dropped, not stringified: `"undefined"` would read as a real dimension value. */
function text(fields: LogFields, name: PublishableText, fallback = ''): string {
  const held = v.safeParse(v.string(), fields[name]);

  return held.success ? held.output : fallback;
}

function count(fields: LogFields, name: PublishableNumber): number {
  const held = v.safeParse(FiniteNumber, fields[name]);

  return held.success ? held.output : 0;
}

/** One snake_case token. A type check on the slot, not a secret scrubber: prose is rejected. */
const CLASSIFICATION = /^[a-z][a-z0-9_]{0,31}$/;

function classification(fields: LogFields, name: PublishableText, fallback = ''): string {
  const held = text(fields, name);

  return CLASSIFICATION.test(held) ? held : fallback;
}

/** A member of `ERROR_CODES` or `''`; a `diagnostics.failure`'s own code wins over the field. */
function errorCode(fields: LogFields, reported: ErrorCode | ''): ErrorCode | '' {
  if (reported !== '') return reported;
  const held = text(fields, 'code');

  return ERROR_CODES.find((candidate) => candidate === held) ?? '';
}

/** Digests email addresses; already-digested actor values pass through unchanged. */
function identityValue(raw: string): string {
  return raw.includes('@') ? analyticsDigest(raw) : raw;
}

function opsRow(
  event: LogEventName,
  fields: LogFields,
  reported: ErrorCode | '',
): AnalyticsRow<typeof CONTROL_PLANE_OPS_SCHEMA> {
  const code = errorCode(fields, reported);

  return {
    actor: identityValue(text(fields, 'actor')),
    kind: 'op',
    operation: text(fields, 'operation', event.slice(CONTROL_PLANE_PREFIX.length)),
    outcome: classification(fields, 'outcome', code === '' ? 'ok' : 'failed'),
    code,
    targetKind: text(fields, 'targetKind'),
    reason: classification(fields, 'reason'),
    target: identityValue(text(fields, 'target')),
    count: 1,
    durationMs: count(fields, 'durationMs'),
    affected: count(fields, 'affected'),
  };
}

function agentRow(
  event: LogEventName,
  fields: LogFields,
  reported: ErrorCode | '',
): AnalyticsRow<typeof AGENT_METRICS_SCHEMA> {
  const code = errorCode(fields, reported);

  return {
    // No isolate-level default: co-located DOs share the module-global sink.
    workspace: analyticsDigest(text(fields, 'workspace')),
    kind: 'event',
    family: eventFamily(event),
    event,
    outcome: classification(fields, 'outcome', code === '' ? 'ok' : 'failed'),
    code,
    boundary: boundaryOf(event),
    agentKind: text(fields, 'agentKind'),
    provider: text(fields, 'provider'),
    model: text(fields, 'model'),
    tool: text(fields, 'tool'),
    source: text(fields, 'source'),
    reason: classification(fields, 'reason'),
    count: 1,
    durationMs: count(fields, 'durationMs'),
    ttftMs: count(fields, 'ttftMs'),
    steps: count(fields, 'steps'),
    toolCalls: count(fields, 'toolCalls'),
    // Token usage and delivery attempts arrive only through typed `record.ts` writers.
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    neurons: 0,
    usd: 0,
    priced: 0,
    attempts: 0,
  };
}

function createAnalyticsLogger(env: AnalyticsEnv): Logger {
  const plane = analyticsPlane(env);

  const route = (name: LogEventName, fields: LogFields, code: ErrorCode | ''): void => {
    if (name.startsWith(CONTROL_PLANE_PREFIX)) {
      plane.ops.write(opsRow(name, fields, code));

      return;
    }

    plane.agent.write(agentRow(name, fields, code));
  };

  return {
    event(name: LogEventName, fields?: LogFields): void {
      route(name, fields ?? {}, '');
    },
    failure(name: LogEventName, error: KinuError, fields?: LogFields): void {
      route(name, fields ?? {}, error.code);
    },
  };
}

/** Keyed on the env object, which identifies an isolate from here. */
const INSTALLED = new WeakSet<AnalyticsEnv>();

/**
 * Install the composite sink once per isolate (idempotent) and open a write window. The platform
 * cap is per invocation, so non-entry seams call `openAnalyticsWindow` themselves.
 */
export function installAnalyticsDiagnostics(env: AnalyticsEnv): () => void {
  const plane = analyticsPlane(env);
  plane.window.open();

  if (INSTALLED.has(env)) return () => {};

  INSTALLED.add(env);

  const restore = setDiagnosticsSink(createCompositeLogger([
    createConsoleLogger(),
    createAnalyticsLogger(env),
  ]));

  diagnostics.event('analytics.sink_installed', {
    agentMetrics: env.AGENT_METRICS !== undefined,
    feedbackMarkers: env.FEEDBACK_MARKERS !== undefined,
    controlPlaneOps: env.CONTROL_PLANE_OPS !== undefined,
  });

  return () => {
    INSTALLED.delete(env);
    restore();
  };
}
