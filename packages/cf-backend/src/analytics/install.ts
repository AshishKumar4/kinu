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
  createCompositeLogger, createConsoleLogger, diagnostics, setDiagnosticsSink,
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
 */
const PUBLISHABLE_TEXT = [
  'workspace', 'agentKind', 'provider', 'model', 'tool', 'source',
  'outcome', 'reason', 'targetKind', 'target', 'actor', 'operation',
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

/** An email address published as itself would be the one leak a name allowlist
 *  cannot catch, because the field is legitimately named. */
function identityValue(raw: string): string {
  return raw.includes('@') ? analyticsDigest(raw) : raw;
}

function opsRow(
  event: LogEventName,
  fields: LogFields,
  code: ErrorCode | '',
): AnalyticsRow<typeof CONTROL_PLANE_OPS_SCHEMA> {
  return {
    actor: identityValue(text(fields, 'actor')),
    kind: 'op',
    // The tail after the first dot: `control_plane.workspace_remove` groups as
    // `workspace_remove`. An explicit `operation` field wins, so a caller whose
    // event name is coarser than its operation can say so.
    operation: text(fields, 'operation', event.slice(CONTROL_PLANE_PREFIX.length)),
    outcome: text(fields, 'outcome', code === '' ? 'ok' : 'failed'),
    code,
    targetKind: text(fields, 'targetKind'),
    reason: text(fields, 'reason'),
    target: identityValue(text(fields, 'target')),
    count: 1,
    durationMs: count(fields, 'durationMs'),
    affected: count(fields, 'affected'),
  };
}

function agentRow(
  event: LogEventName,
  fields: LogFields,
  code: ErrorCode | '',
  workspace: string,
): AnalyticsRow<typeof AGENT_METRICS_SCHEMA> {
  return {
    // A field-supplied workspace wins over the installer's: a UserDO handling
    // one user's several workspaces knows which one a line is about, and the
    // installer only knows the isolate it is in.
    workspace: analyticsDigest(text(fields, 'workspace', workspace)),
    kind: 'event',
    family: eventFamily(event),
    event,
    outcome: text(fields, 'outcome', code === '' ? 'ok' : 'failed'),
    code,
    boundary: boundaryOf(event),
    agentKind: text(fields, 'agentKind'),
    provider: text(fields, 'provider'),
    model: text(fields, 'model'),
    tool: text(fields, 'tool'),
    source: text(fields, 'source'),
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
 * How the sink learns which workspace an isolate's lines belong to.
 *
 * A THUNK, not a string, and this is load-bearing rather than a style choice. The
 * sink is installed in a Durable Object's CONSTRUCTOR, because that is the one
 * point guaranteed to precede every RPC — and at that moment a facet actor may
 * not know its own placement yet: a `SubordinateAgent`'s WORKSPACE is its
 * parent's, and `workspaceName()` throws by design until the parent seeds the
 * identity row. Passing a string made `new SubordinateAgent(...)` throw before
 * seeding, including on a cold activation arriving ahead of the RPC that would
 * have seeded it.
 *
 * THE THUNK MUST BE TOTAL. It is read on the diagnostics path, so a throw there
 * would break the log line it is describing, and reporting the throw would
 * recurse into this same sink. Callers therefore pass something that always has
 * an answer — `() => this.name`, the actor's OWN durable name, which is what
 * identifies the emitter anyway and is digested before it is written.
 */
export type WorkspaceSource = () => string;

/**
 * The Analytics half of the composite. Exported for the tests that assert the
 * projection directly: an instrument nobody asserts on is an instrument nobody
 * notices has stopped, and this one has no return value to check.
 */
export function createAnalyticsLogger(env: AnalyticsEnv, workspace?: WorkspaceSource): Logger {
  const plane = analyticsPlane(env);
  const route = (name: LogEventName, fields: LogFields, code: ErrorCode | ''): void => {
    if (name.startsWith(CONTROL_PLANE_PREFIX)) {
      plane.ops.write(opsRow(name, fields, code));
      return;
    }
    plane.agent.write(agentRow(name, fields, code, workspace === undefined ? '' : workspace()));
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
 * Called at the Worker's `fetch` and `scheduled` entries, and in every Durable
 * Object's activation path. Both are necessary: the entries are where a Worker
 * invocation's window begins, and the Durable Objects are different isolates
 * where the Worker's sink does not exist.
 *
 * IDEMPOTENT PER ISOLATE. A second install would otherwise wrap the composite in
 * another composite — one Analytics row and two identical console lines per event,
 * growing with every invocation. Repeated calls therefore only re-open the write
 * window, which is what a repeated call at an invocation boundary means anyway.
 *
 * The returned function restores the previous sink. Calling it is optional: the
 * window it would end is re-opened by the next install, so skipping it costs a
 * wider write budget rather than correctness.
 */
export function installAnalyticsDiagnostics(
  env: AnalyticsEnv,
  workspace?: WorkspaceSource,
): () => void {
  const plane = analyticsPlane(env);
  plane.window.open();
  if (INSTALLED.has(env)) return () => {};
  INSTALLED.add(env);
  const restore = setDiagnosticsSink(createCompositeLogger([
    createConsoleLogger(),
    createAnalyticsLogger(env, workspace),
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
