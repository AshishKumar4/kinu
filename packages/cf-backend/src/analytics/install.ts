/**
 * The diagnostics sink adapter: core's dotted events, fanned into Analytics
 * Engine without leaving Workers Logs.
 *
 * ## Why a composite and not a replacement
 *
 * `setDiagnosticsSink` REPLACES. A host that installed a bare Analytics sink would
 * silently stop writing to `console`, and `console` is the destination a person
 * actually reaches for during an incident: it is in Workers Logs within seconds,
 * it carries the whole rendered cause chain, and it needs no binding, no
 * credential and no SQL API token. Analytics Engine is the opposite trade — three
 * months of history, aggregatable, and no free text at all. Neither substitutes
 * for the other, so the sink is `console` first and Analytics second.
 *
 * ## Why the field allowlist is the privacy mechanism
 *
 * `Logger.event(name, fields)` takes `LogFields`, whose reserved-key ban is a
 * TYPE — erased before anything runs. So this sink does not scrub values; it
 * publishes from a CLOSED SET OF NAMES, and `assertPublishableNames` proves at
 * module load that none of them is reserved. A field this file does not name never
 * reaches Analytics at all, and still reaches Workers Logs through the console
 * member, so a call site loses nothing by reporting more than the allowlist.
 *
 * THE CAUSE CHAIN IS DELIBERATELY NOT WRITTEN. `Logger.failure` carries a rendered
 * chain, and an upstream error's message is unbounded and possibly carries a
 * credential — the same reason `obs/cf-tracer.ts` refuses to put error text on a
 * span. What crosses into Analytics is the CLASSIFICATION, which is a closed set
 * of nine words and is what an aggregate wanted anyway.
 *
 * The allowlist alone cannot enforce that, because a caller can put the chain in
 * a field the allowlist WANTS — `reason` — and the name is then correct while the
 * value is prose. So the three classification slots, `outcome`, `reason` and
 * `code`, are checked against their VOCABULARY as well as their name: see
 * `CLASSIFICATION` and `errorCode` below.
 *
 * ## Why this is not sufficient on its own
 *
 * A Durable Object is a different isolate from the Worker that routes to it, with
 * its own module-level state, so a sink installed in `fetch` is NOT installed
 * inside `OrchestratorAgent`. That is why the turn, model, tool and first-token
 * rows do not come through here at all: they call `record.ts` with an environment
 * in hand, which is correct in any isolate. This path carries the events whose
 * call sites have no environment in reach — a free function inside the capability
 * gate, a pure frame check in the RPC gate, a provider's fetch wrapper — and it
 * must therefore be installed in every isolate those run in.
 */
import {
  ERROR_CODES, createCompositeLogger, createConsoleLogger, diagnostics, setDiagnosticsSink,
  type ErrorCode, type KinuError, type LogEventName, type LogFields, type Logger,
} from '@kinu.run/core/obs';
import * as v from 'valibot';
import { boundaryOf, eventFamily } from './boundaries';
import { analyticsDigest, assertPublishableNames } from './privacy';
import { AGENT_METRICS_SCHEMA, CONTROL_PLANE_OPS_SCHEMA, type AnalyticsRow } from './schemas';
import { FiniteNumber, analyticsPlane, type AnalyticsEnv } from './writer';

/** Event names under this prefix are control-plane operations and land on the
 *  audit dataset. The prefix is the routing contract with the control plane: it
 *  emits `control_plane.<operation>` and the tail becomes the `operation` slot. */
const CONTROL_PLANE_PREFIX = 'control_plane.';

/**
 * String fields a diagnostic may publish into Analytics, and the slot each lands
 * in. A field absent from this map is not written — that is the whole privacy
 * mechanism, and it is why the map is exhaustive rather than a default with
 * exceptions.
 *
 * `actor` and `target` are digested rather than published: the control plane
 * already digests its actor, and digesting an already-digested value would break
 * its filter, so a value that looks like an ADDRESS is digested and anything else
 * is passed through. That guard is here rather than at the caller because this is
 * the last point before a three-month dataset an admin UI renders, and an address
 * arriving from any future call site would be unrecoverable.
 *
 * `outcome`, `reason` and `code` are read through the closed-vocabulary readers
 * below rather than as text: being NAMED correctly is not the same as being
 * VALUED correctly, and those three slots hold a classification.
 */
const PUBLISHABLE_TEXT = [
  'workspace', 'agentKind', 'provider', 'model', 'tool', 'source',
  'outcome', 'reason', 'code', 'targetKind', 'target', 'actor', 'operation',
] as const;

/** Numeric fields a diagnostic may publish, by slot name. */
const PUBLISHABLE_NUMBERS = [
  'durationMs', 'ttftMs', 'steps', 'toolCalls', 'affected',
] as const;

assertPublishableNames('the diagnostics sink allowlist', [
  ...PUBLISHABLE_TEXT,
  ...PUBLISHABLE_NUMBERS,
]);

type PublishableText = (typeof PUBLISHABLE_TEXT)[number];
type PublishableNumber = (typeof PUBLISHABLE_NUMBERS)[number];

/**
 * An allowlisted string field, or the fallback.
 *
 * PARSED rather than `typeof`-narrowed, and a non-string is DROPPED rather than
 * stringified: `String(undefined)` is the word "undefined", and a dataset full of
 * that reads like a real dimension value.
 */
function text(fields: LogFields, name: PublishableText, fallback = ''): string {
  const held = v.safeParse(v.string(), fields[name]);
  return held.success ? held.output : fallback;
}

/** An allowlisted numeric field, or 0. Finiteness is part of the contract: AE
 *  stores a double, and `NaN` is not one. */
function count(fields: LogFields, name: PublishableNumber): number {
  const held = v.safeParse(FiniteNumber, fields[name]);
  return held.success ? held.output : 0;
}

/**
 * The grammar of a classification: one lowercase snake_case token.
 *
 * This is NOT a value scrubber, and the distinction is why it may exist beside
 * the name allowlist. A scrubber has to recognise a secret, and the lesson of
 * `RESERVED_LOG_FIELDS` is that you cannot. This recognises the declared TYPE of
 * a slot: `outcome` and `reason` hold a closed vocabulary, and prose is not a
 * member of one.
 *
 * It exists because a caller can reach an allowlisted name with the wrong KIND
 * of value, which the allowlist cannot see because the name is right. The
 * control plane published `reason: row.detail`, and on a thrown failure that
 * detail is a rendered cause chain whose head is an upstream exception message —
 * clamped to the slot's 48 bytes and kept for three months. The chain belongs in
 * the durable audit row, which stores it; what crosses into Analytics is the
 * word.
 */
const CLASSIFICATION = /^[a-z][a-z0-9_]{0,31}$/;

/** An allowlisted classification field, or the fallback. A value that is not a
 *  classification reads as one that was not supplied, so the row keeps the
 *  meaning its event name gives it instead of carrying a fragment of prose. */
function classification(fields: LogFields, name: PublishableText, fallback = ''): string {
  const held = text(fields, name);
  return CLASSIFICATION.test(held) ? held : fallback;
}

/**
 * The `code` slot: a member of core's `ERROR_CODES`, or nothing.
 *
 * A `diagnostics.failure`'s own code always wins, because it came from a
 * `KinuError` rather than from an untyped field map. The field is read only for
 * `diagnostics.event`, where a call site has already classified a failure it did
 * not throw — the control plane's audit marker is that case: the action failed
 * inside another Durable Object and arrives here as an outcome, not an error.
 */
function errorCode(fields: LogFields, reported: ErrorCode | ''): ErrorCode | '' {
  if (reported !== '') return reported;
  const held = text(fields, 'code');
  return ERROR_CODES.find((candidate) => candidate === held) ?? '';
}

/** An email address published as itself would be the one leak a name allowlist
 *  cannot catch, because the field is legitimately named. */
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
    // The tail after the first dot: `control_plane.workspace_remove` groups as
    // `workspace_remove`. An explicit `operation` field wins, so a caller whose
    // event name is coarser than its operation can say so.
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
    // THE ONLY SOURCE IS THE LINE ITSELF. There is deliberately no isolate-level
    // default: `setDiagnosticsSink` is module-global, Cloudflare co-locates
    // Durable Objects in one isolate, and the first actor to install would own
    // the default for every actor that landed beside it. A default here does not
    // attribute a row, it MIS-attributes it, and AE's per-index sampling
    // isolation goes wrong with it. A line that knows which workspace it is
    // about says so; one that does not is honestly unattributed.
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
    // A diagnostic never carries a token report — that arrives through
    // `record.ts` with a typed `Usage` — so these are structurally zero here
    // rather than optimistically read from an untyped field map.
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    neurons: 0,
    usd: 0,
    priced: 0,
  };
}

/**
 * The Analytics half of the composite.
 *
 * Private, because `installAnalyticsDiagnostics` is the only way production ever
 * builds one and a second door onto a global sink is a second thing to keep
 * consistent. The projection it performs has no return value to check, so it is
 * asserted the way production reaches it: install the composite, emit through
 * core's `diagnostics` seam, read the data point.
 */
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

/** Isolates that already have the composite installed. Keyed on the environment
 *  object, which is what identifies an isolate from in here. */
const INSTALLED = new WeakSet<AnalyticsEnv>();

/**
 * Install the composite sink for this isolate and open a write window.
 *
 * Called once per isolate. The Worker's `fetch` and `scheduled` entries and every
 * Durable Object's constructor call it, because a Durable Object is a different
 * isolate and the Worker's sink does not exist inside one.
 *
 * INSTALLING IS NOT THE SAME AS OPENING A WINDOW, and conflating them is what
 * left three Durable Objects writing on one 250-point budget per activation. A
 * constructor runs once per activation; the platform's cap is per INVOCATION. So
 * this opens a window as a convenience for the Worker entries, where the two
 * coincide, and every other invocation seam calls `openAnalyticsWindow` directly.
 *
 * IDEMPOTENT PER ISOLATE. A second install would otherwise wrap the composite in
 * another composite — one Analytics row and two identical console lines per event,
 * growing with every invocation.
 *
 * The returned function restores the previous sink. Calling it is optional: the
 * window it would end is re-opened by the next install, so skipping it costs a
 * wider write budget rather than correctness.
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
