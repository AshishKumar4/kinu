import { Telemetry, gapStats, readToken, type Filter, type TelemetryEvent } from './prod-logs';
import type { CanaryFinding } from './durability-canary-ledger';

const EVENT_LIMIT = 2000;

const HOUR_MS = 3_600_000;

const eq = (key: string, value: string): Filter => ({ key, operation: 'eq', value, type: 'string' });

const iso = (at: number): string => new Date(at).toISOString();

export interface CanaryTouch {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

export interface CanaryWindow {
  readonly from: number;
  readonly to: number;
}

function identity(event: TelemetryEvent): string {
  return event.$metadata.id ?? `${String(event.timestamp)}:${event.$metadata.requestId ?? ''}:${event.source.event}:${event.$metadata.type ?? ''}`;
}

function unique(events: readonly TelemetryEvent[]): TelemetryEvent[] {
  return [...new Map(events.map((event) => [identity(event), event])).values()].sort((a, b) => a.timestamp - b.timestamp);
}

function evidence(event: TelemetryEvent) {
  const name = event.source.event === '' ? event.$metadata.type ?? 'unknown' : event.source.event;
  const cause = event.source.cause === '' ? event.source.fields.cause ?? event.$metadata.error ?? null : event.source.cause;

  return { at: iso(event.timestamp), event: name,
    object: event.$workers.durableObjectId ?? null, eventType: event.$workers.eventType ?? null,
    outcome: event.$workers.outcome ?? null, version: event.$workers.scriptVersion?.id ?? null,
    requestId: event.$metadata.requestId ?? null, actor: event.source.fields.actor ?? null,
    sameBuild: event.source.fields.sameBuild ?? null, midStep: event.source.fields.midStep ?? null,
    fiber: event.source.fields.fiber ?? null, cause,
    rpcMethods: event.$workers.event?.rpcMethods ?? (event.$workers.event?.rpcMethod === undefined ? [] : [event.$workers.event.rpcMethod]) };
}

function countBy(keys: readonly string[], hours: number) {
  const counts = new Map<string, number>();

  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);

  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([cause, count]) => ({ cause, count,
    perActiveHour: hours > 0 ? count / hours : null }));
}

function codeUpdated(row: TelemetryEvent): boolean {
  return [row.source.cause, row.source.message, row.$metadata.message, row.$metadata.error]
    .some((text) => text?.includes('Durable Object reset because its code was updated') === true);
}

class CanaryTelemetry {
  readonly failures: string[] = [];
  readonly limitations: string[] = [];
  queries = 0;
  maxSamplingSeen = 1;
  acceptedSampling = 1;

  constructor(private readonly worker: string, private readonly token: string) {}

  async rows(filters: readonly Filter[], window: CanaryWindow): Promise<TelemetryEvent[]> {
    if (window.from >= window.to) return [];
    const client = new Telemetry(this.token, { worker: this.worker, ...window });

    try {
      this.queries++;
      const result = await client.events(filters, EVENT_LIMIT);
      this.maxSamplingSeen = Math.max(this.maxSamplingSeen, result.sampling);
      const incomplete = result.sampling > 1 || result.events.length >= EVENT_LIMIT;

      if (incomplete && window.to - window.from > 1000) {
        const middle = Math.floor((window.from + window.to) / 2);

        const [left, right] = await Promise.all([
          this.rows(filters, { from: window.from, to: middle }), this.rows(filters, { from: middle, to: window.to }),
        ]);

        return unique([...left, ...right]);
      }

      this.acceptedSampling = Math.max(this.acceptedSampling, result.sampling);

      if (incomplete) this.limitations.push(`Telemetry remains sampled or capped in ${iso(window.from)} .. ${iso(window.to)}.`);

      return result.events;
    } catch (error) {
      this.failures.push(`Telemetry ${iso(window.from)} .. ${iso(window.to)}: ${String(error)}`);

      return [];
    }
  }
}

/** One activation by its ordinal (`core/src/identity/activations.ts`); `at` is null for one only a gap in the ordinals shows. */
export interface CanaryActivation {
  readonly ordinal: number;
  readonly at: number | null;
  readonly version: string | null;
}

/**
 * The workspace's activations: the ring the driver read at its last touch, or, when it could not, the ordinals on the
 * startup rows telemetry kept, each gap standing for an activation whose row was lost. Never a count of rows.
 */
export function canaryActivations(ring: readonly CanaryActivation[] | null, startups: readonly TelemetryEvent[]): CanaryActivation[] {
  if (ring !== null) return [...ring].sort((a, b) => a.ordinal - b.ordinal);
  const seen = new Map<number, CanaryActivation>();

  for (const row of startups) {
    const ordinal = row.source.fields.activation;

    if (ordinal !== undefined && !seen.has(ordinal)) seen.set(ordinal, { ordinal, at: row.timestamp, version: row.$workers.scriptVersion?.id ?? null });
  }

  const ordinals = [...seen.keys()];

  if (ordinals.length === 0) return [];
  const [low, high] = [Math.min(...ordinals), Math.max(...ordinals)];

  return Array.from({ length: high - low + 1 }, (_, offset) => seen.get(low + offset) ?? { ordinal: low + offset, at: null, version: null });
}

function inWindow(activations: readonly CanaryActivation[], index: number, window: CanaryWindow): boolean {
  const at = activations[index]?.at ?? null;

  if (at !== null) return at >= window.from && at <= window.to;
  const before = activations.slice(0, index).reverse().find((activation) => activation.at !== null)?.at ?? Number.NEGATIVE_INFINITY;
  const after = activations.slice(index + 1).find((activation) => activation.at !== null)?.at ?? Number.POSITIVE_INFINITY;

  return before <= window.to && after >= window.from;
}

/** The rows that tell how `current` began and how the one before it ended. */
function activationRows(rows: readonly TelemetryEvent[], at: {
  readonly previous: CanaryActivation; readonly current: CanaryActivation; readonly nextAt: number;
  readonly currentRow: TelemetryEvent | undefined; readonly previousRow: TelemetryEvent | undefined;
}) {
  if (at.current.at === null) return { before: [], during: [], priorOutcomes: [] };
  const from = at.previous.at ?? Number.NEGATIVE_INFINITY;
  const to = at.current.at;
  const sameRequest = (row: TelemetryEvent, other: TelemetryEvent | undefined) => other?.$metadata.requestId !== undefined && row.$metadata.requestId === other.$metadata.requestId;
  const before = rows.filter((row) => !sameRequest(row, at.currentRow) && ((row.timestamp >= from && row.timestamp < to) || sameRequest(row, at.previousRow)));
  // Fiber recovery can log before onStart, in the same initializing invocation.
  const during = rows.filter((row) => (row.timestamp >= to && row.timestamp < at.nextAt) || sameRequest(row, at.currentRow));
  const requests = new Set(before.map((row) => row.$metadata.requestId).filter((id) => id !== undefined));

  const priorOutcomes = rows.filter((row) => row.$metadata.type === 'cf-worker-event' && row.$workers.outcome !== undefined && row.$workers.outcome !== 'ok'
    && ((row.timestamp >= from && row.timestamp < to) || (row.$metadata.requestId !== undefined && requests.has(row.$metadata.requestId))));

  return { before, during, priorOutcomes };
}

/** Whether a deploy ended the activation before `current`: a new build, a resume on one, or the code-updated reset. */
function deployEvidence(previous: CanaryActivation, current: CanaryActivation, before: readonly TelemetryEvent[], during: readonly TelemetryEvent[]) {
  const changedVersion = previous.version !== null && current.version !== null && previous.version !== current.version;
  const resumedOnNewBuild = during.filter((row) => row.source.event === 'turn.resumed' && row.source.fields.sameBuild === 'no');
  const resetRows = before.filter(codeUpdated);

  return { changedVersion, resumedOnNewBuild, resetRows, deploy: changedVersion || resumedOnNewBuild.length > 0 || resetRows.length > 0 };
}

function activationDisruptions(rows: readonly TelemetryEvent[], activations: readonly CanaryActivation[], window: CanaryWindow, touches: readonly CanaryTouch[]) {
  const disruptions = [];
  const startupRow = (ordinal: number) => rows.find((row) => row.source.event === 'actor.startup' && row.source.fields.activation === ordinal);

  for (let index = 1; index < activations.length; index++) {
    if (!inWindow(activations, index, window)) continue;
    const previous = activations[index - 1];
    const current = activations[index];
    const currentRow = startupRow(current.ordinal);

    const { before, during, priorOutcomes } = activationRows(rows, {
      previous, current, nextAt: activations[index + 1]?.at ?? window.to + 1, currentRow, previousRow: startupRow(previous.ordinal),
    });

    const { changedVersion, resumedOnNewBuild, resetRows, deploy } = deployEvidence(previous, current, before, during);

    const invocation = currentRow?.$workers.eventType ?? during.find((row) => row.$metadata.type === 'cf-worker-event'
      && row.$metadata.requestId !== undefined && row.$metadata.requestId === currentRow?.$metadata.requestId)?.$workers.eventType;

    const request = invocation === 'fetch' || invocation === 'rpc' || invocation === 'jsrpc';
    const own = current.at === null ? undefined : touches.find((touch) => (current.at ?? 0) >= touch.from && (current.at ?? 0) <= touch.to);
    const fibers = during.filter((row) => row.source.event === 'fiber.recovered');
    const endedBy = deploy ? 'deploy' : 'eviction';
    const requestSource = own === undefined ? 'other-or-unattributed-request' : 'driver-touch-by-time';

    disruptions.push({ ordinal: current.ordinal, at: current.at === null ? null : iso(current.at), previousStartupAt: previous.at === null ? null : iso(previous.at),
      endedBy: current.at === null && !deploy ? 'unknown' : endedBy,
      evictionOutcomes: deploy ? [] : [...new Set(priorOutcomes.map((row) => row.$workers.outcome ?? 'unavailable'))],
      evictionDetail: deploy || priorOutcomes.length > 0 || current.at === null ? null : 'silent',
      deployEvidence: { changedVersion, oldVersion: previous.version, newVersion: current.version,
        resumedSameBuildNo: resumedOnNewBuild.map(evidence), codeUpdatedReset: resetRows.map(evidence) },
      resumedBy: { invocation: invocation ?? 'unavailable', alarm: invocation === 'alarm', fiberRecovery: fibers.length > 0,
        request: request ? requestSource : null,
        driverTouch: own ?? null },
      startup: currentRow === undefined ? null : evidence(currentRow), previousNonOkInvocations: priorOutcomes.map(evidence), fibers: fibers.map(evidence) });
  }

  return disruptions;
}

function idleReport(rows: readonly TelemetryEvent[], activations: readonly CanaryActivation[], window: CanaryWindow | null) {
  if (window === null) return null;
  const idle = rows.filter((row) => row.timestamp >= window.from && row.timestamp <= window.to);
  const startups = activations.filter((_, index) => inWindow(activations, index, window));
  const invocations = idle.filter((row) => row.$metadata.type === 'cf-worker-event');
  const alarms = invocations.filter((row) => row.$workers.eventType === 'alarm');

  return { window: { from: iso(window.from), to: iso(window.to) }, target: 0,
    startups: startups.length, alarms: alarms.length, otherInvocations: invocations.length - alarms.length,
    invocations: invocations.length, byType: countBy(invocations.map((row) => row.$workers.eventType ?? 'unavailable'), 0),
    startupEvidence: startups.map((activation) => ({ ordinal: activation.ordinal, at: activation.at === null ? null : iso(activation.at), version: activation.version })),
    invocationEvidence: invocations.map(evidence),
    unfinishedArms: idle.filter((row) => row.source.event === 'wake.unfinished_arms').map((row) => ({ at: iso(row.timestamp),
      arms: Object.entries(row.source.fields).filter(([, on]) => on === true).map(([arm]) => arm) })) };
}

export interface CanaryTelemetryRequest {
  readonly worker: string;
  readonly workspace: string;
  readonly observed: CanaryWindow;
  readonly active: CanaryWindow;
  readonly idle: CanaryWindow | null;
  readonly touches: readonly CanaryTouch[];
  readonly helperActors: readonly string[];
  /** The ring the driver read at its last touch; null when it could not. */
  readonly activations: readonly CanaryActivation[] | null;
}

export async function measureCanaryTelemetry(request: CanaryTelemetryRequest) {
  const client = new CanaryTelemetry(request.worker, await readToken());
  const namedStartups = await client.rows([eq('event', 'actor.startup'), eq('fields.workspace', request.workspace)], request.observed);
  const objects = [...new Set(namedStartups.flatMap((row) => row.$workers.durableObjectId === undefined ? [] : [row.$workers.durableObjectId]))];

  if (objects.length === 0) client.limitations.push('No actor.startup row resolved the workspace durableObjectId; object invocations and idle wakes are unmeasured.');

  const relatedResumes = await client.rows([eq('event', 'turn.resumed'), eq('fields.workspace', request.workspace)], request.observed);

  const groups = await Promise.all(objects.map(async (object) => {
    const scope = [eq('$workers.durableObjectId', object)];

    const filters: readonly Filter[][] = [
      [...scope, eq('$metadata.type', 'cf-worker-event'), { key: '$workers.outcome', operation: 'neq', value: 'ok', type: 'string' }],
      [...scope, eq('$metadata.type', 'cf-worker-event'), eq('$workers.eventType', 'alarm')],
      [...scope, eq('event', 'turn.resumed')],
      [...scope, eq('event', 'turn.recovery_settled')],
      [...scope, { key: 'event', operation: 'includes', value: 'fiber.', type: 'string' }],
      [...scope, eq('event', 'wake.unfinished_arms')],
      [...scope, { key: '$metadata.message', operation: 'includes', value: 'code was updated', type: 'string' }],
      [...scope, { key: '$metadata.error', operation: 'includes', value: 'code was updated', type: 'string' }],
    ];

    const activeRows = await Promise.all(filters.map((filter) => client.rows(filter, request.observed)));
    const idleRows = request.idle === null ? [] : await client.rows([...scope, eq('$metadata.type', 'cf-worker-event')], request.idle);

    return [...activeRows.flat(), ...idleRows];
  }));

  const rows = unique([...namedStartups, ...relatedResumes, ...groups.flat()]);
  const active = rows.filter((row) => row.timestamp >= request.active.from && row.timestamp <= request.active.to);
  const resumes = active.filter((row) => row.source.event === 'turn.resumed');

  const hostedResumes = resumes.filter((row) => row.source.fields.actor !== undefined
    && row.source.fields.actor !== request.workspace && row.source.fields.actor !== 'main');

  if (hostedResumes.length === 0) client.limitations.push('No hosted turn.resumed row was observed; attribution of hired-actor recovery to the workspace durableObjectId is unverified.');

  const offObject = relatedResumes.filter((row) => row.$workers.durableObjectId === undefined || !objects.includes(row.$workers.durableObjectId));

  if (offObject.length > 0) client.limitations.push(`${String(offObject.length)} workspace-named turn.resumed rows lack the workspace durableObjectId; they are included in turn counts but their activation cannot be classified.`);

  if (namedStartups.some((row) => row.$workers.scriptVersion?.id === undefined)) client.limitations.push('Some startups lack scriptVersion.id; version-change deploy detection is unavailable on those boundaries.');

  if (namedStartups.some((row) => row.$workers.eventType === undefined)) client.limitations.push('Some startups lack their triggering eventType; the first invocation may be unclassifiable.');

  const hours = (request.active.to - request.active.from) / HOUR_MS;
  const activations = canaryActivations(request.activations, namedStartups);

  if (request.activations === null) client.limitations.push('The activation ring could not be read; activations come from the ordinals on surviving startup rows, a gap for each lost one.');

  const disruptions = activationDisruptions(rows, activations, request.active, request.touches);
  const fiberEvents = active.filter((row) => row.source.event.startsWith('fiber.'));
  const idle = idleReport(rows, activations, request.idle);

  const complete = objects.length > 0 && client.failures.length === 0 && client.acceptedSampling === 1
    && !client.limitations.some((limitation) => limitation.startsWith('Telemetry remains'));

  return { complete, objects, queries: client.queries, sampling: { largestSeen: client.maxSamplingSeen, accepted: client.acceptedSampling,
    sampledOrCappedWindowsAreSubdivided: true }, failures: client.failures, limitations: client.limitations,
    fieldSources: { activation: 'the workspace activation ring (ordinal, started_at, version), else actor.startup fields.activation; object id from actor.startup fields.workspace',
      endedBy: '$workers.scriptVersion.id across startups; turn.resumed fields.sameBuild=no; code-updated reset text; previous $workers.outcome',
      resumedBy: 'startup $workers.eventType (measured jsrpc, not only rpc); fiber.recovered within activation; driver touch windows by time',
      invocationTime: 'cf-worker-event timestamp is the platform row time, not an isolate termination id; successful invocations do not prove eviction.',
      invocationScope: 'Active invocation rows are only alarms and non-ok outcomes; successful active RPCs are not downloaded. All invocation types are queried in the idle window.',
      hosted: hostedResumes.map((row) => ({ actor: row.source.fields.actor, object: row.$workers.durableObjectId ?? null,
        matchesWorkspaceObject: row.$workers.durableObjectId !== undefined && objects.includes(row.$workers.durableObjectId),
        isCanaryHelper: request.helperActors.includes(row.source.fields.actor ?? '') })),
      unavailable: ['The API exposes no explicit silent-eviction reason.',
        'Request attribution to the driver is temporal, not a unique driver request-id match.',
        'A lost isolate may print a marker without committing its result; only durable output is observable.'] },
    classificationNotes: {
      endedBy: 'Every activation after the first is one disruption. Deploy wins over eviction; eviction outcome buckets can overlap if the previous activation had multiple non-ok outcomes.',
      resumedBy: 'Alarm and fiber recovery can both apply to one activation. Request includes the measured platform jsrpc type. These are resumption mechanisms, not termination causes.',
    },
    active: { window: { from: iso(request.active.from), to: iso(request.active.to) }, hours,
      startups: activations.filter((_, index) => inWindow(activations, index, request.active)).length,
      disruptions: disruptions.length, perActiveHour: hours > 0 ? disruptions.length / hours : null,
      endedBy: countBy(disruptions.flatMap((row) => {
        if (row.endedBy === 'deploy') return ['deploy'];

        if (row.evictionOutcomes.length === 0) return ['eviction.silent'];

        return row.evictionOutcomes.map((outcome) => `eviction.${outcome}`);
      }), hours),
      resumedBy: countBy(disruptions.flatMap((row) => [
        ...row.resumedBy.alarm ? ['alarm'] : [], ...row.resumedBy.fiberRecovery ? ['fiber recovery'] : [],
        ...row.resumedBy.request === null ? [] : [`request.${row.resumedBy.request}`],
        ...row.resumedBy.invocation === 'unavailable' ? ['unavailable'] : [],
      ]), hours), rows: disruptions,
      turnResumed: { count: resumes.length,
        bySameBuild: countBy(resumes.map((row) => row.source.fields.sameBuild ?? 'unavailable'), hours),
        byMidStep: countBy(resumes.map((row) => String(row.source.fields.midStep ?? 'unavailable')), hours),
        bySameBuildAndMidStep: countBy(resumes.map((row) => `${row.source.fields.sameBuild ?? 'unavailable'}/midStep=${String(row.source.fields.midStep ?? 'unavailable')}`), hours),
        evidence: resumes.map(evidence) },
      recoverySettled: active.filter((row) => row.source.event === 'turn.recovery_settled').map(evidence),
      fibers: { recovered: fiberEvents.filter((row) => row.source.event === 'fiber.recovered').length,
        recoveryFailed: fiberEvents.filter((row) => row.source.event === 'fiber.recovery_failed').length,
        jobLaneRedriven: fiberEvents.filter((row) => row.source.event === 'fiber.job_lane_redriven').length,
        evidence: fiberEvents.map(evidence) },
      alarmCadence: gapStats(active.filter((row) => row.$metadata.type === 'cf-worker-event' && row.$workers.eventType === 'alarm').map((row) => row.timestamp)),
      codeUpdatedResets: active.filter(codeUpdated).map(evidence),
      alarmAndNonOkInvocations: countBy(active.filter((row) => row.$metadata.type === 'cf-worker-event')
        .map((row) => `${row.$workers.eventType ?? 'unavailable'}/${row.$workers.outcome ?? 'unavailable'}`), hours) }, idle };
}

export type CanaryTelemetryMeasurement = Awaited<ReturnType<typeof measureCanaryTelemetry>>;

export function telemetryFindings(measured: CanaryTelemetryMeasurement): CanaryFinding[] {
  const findings: CanaryFinding[] = [];

  for (const cause of measured.active.endedBy) {
    const rows = measured.active.rows.filter((row) => {
      if (row.endedBy === 'deploy') return cause.cause === 'deploy';

      if (cause.cause === 'eviction.silent') return row.evictionDetail === 'silent';

      return row.evictionOutcomes.some((outcome) => cause.cause === `eviction.${outcome}`);
    });

    findings.push({ name: `disruption.${cause.cause}`, kind: 'disruption', cause: `${String(cause.count)} disruptions, ${String(cause.perActiveHour)} per active hour.`,
      evidence: rows.map((row) => ({ at: row.at, event: 'actor.startup', count: 1,
        detail: `${row.previousStartupAt} -> ${row.at}; resumed ${JSON.stringify(row.resumedBy)}; previous outcomes ${JSON.stringify(row.previousNonOkInvocations)}` })) });
  }

  for (const failure of measured.active.fibers.evidence.filter((row) => row.event === 'fiber.recovery_failed')) findings.push({
    name: 'fiber.recovery-failed', kind: 'defect', cause: failure.cause ?? 'Fiber recovery failed without a usable cause field.',
    evidence: [{ at: failure.at, event: failure.event, count: 1, detail: failure.fiber ?? 'fiber unavailable' }],
  });
  const idle = measured.idle;

  if (idle !== null) {
    const cause = 'The workspace object was invoked after all work ended and the driver disconnected; target is zero.';

    if (idle.startups > 0) {
      findings.push({ name: 'idle.startups', kind: 'defect', cause,
        evidence: idle.startupEvidence.map((activation) => ({ at: activation.at, event: 'activation', count: 1, detail: `ordinal ${String(activation.ordinal)} on ${activation.version ?? 'an unnamed build'}` })) });
    }

    const invoked = [{ name: 'idle.alarm-invocations', count: idle.alarms, rows: idle.invocationEvidence.filter((row) => row.eventType === 'alarm') },
      { name: 'idle.other-invocations', count: idle.otherInvocations, rows: idle.invocationEvidence.filter((row) => row.eventType !== 'alarm') }];

    for (const item of invoked) {
      if (item.count === 0) continue;
      findings.push({ name: item.name, kind: 'defect', cause,
        evidence: item.rows.map((row) => ({ at: row.at, event: row.event, count: 1,
          detail: `${row.eventType ?? 'unknown'} ${row.outcome ?? ''}; RPC ${row.rpcMethods.join(', ')}` })) });
    }
  }

  for (const failure of measured.failures) findings.push({ name: 'telemetry.read-failed', kind: 'measurement', cause: failure, evidence: [] });

  if (!measured.complete) findings.push({ name: 'telemetry.incomplete', kind: 'measurement', cause: measured.limitations.join(' '), evidence: [] });

  return findings;
}
