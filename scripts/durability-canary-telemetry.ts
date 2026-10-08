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

/**
 * An activation the object began on a new script version without logging `actor.startup` (staging 143fc79d, 2026-10-08:
 * the canary's object served its first alarm on the new version at 08:14:15.951Z and logged its next startup at 08:19:16Z,
 * and a step was lost between): the first invocation on each new version, where no startup sits within a minute of it.
 */
function unloggedActivations(rows: readonly TelemetryEvent[], startups: readonly TelemetryEvent[]): TelemetryEvent[] {
  const invocations = rows.filter((row) => row.$metadata.type === 'cf-worker-event' && row.$workers.scriptVersion?.id !== undefined);
  const firsts: TelemetryEvent[] = [];
  const seen = new Set<string>();

  // A version's first invocation only: a rollout flips an object between two versions for seconds (06:31Z, 14 flips).
  for (const current of invocations) {
    const version = `${current.$workers.durableObjectId ?? ''}:${current.$workers.scriptVersion?.id ?? ''}`;

    if (seen.has(version)) continue;
    seen.add(version);

    if (seen.size === 1 || startups.some((startup) => Math.abs(startup.timestamp - current.timestamp) <= 60_000)) continue;
    firsts.push({ ...current, source: { ...current.source, event: 'activation.unlogged_startup' } });
  }

  return firsts;
}

function activationDisruptions(rows: readonly TelemetryEvent[], window: CanaryWindow, touches: readonly CanaryTouch[]) {
  const logged = rows.filter((row) => row.source.event === 'actor.startup');
  const startups = [...logged, ...unloggedActivations(rows, logged)].sort((a, b) => a.timestamp - b.timestamp);
  const disruptions = [];

  for (let index = 1; index < startups.length; index++) {
    const previous = startups[index - 1];
    const current = startups[index];

    if (current.timestamp < window.from || current.timestamp > window.to) continue;
    const next = startups[index + 1];

    const previousRows = rows.filter((row) => row.$workers.durableObjectId === previous.$workers.durableObjectId
      && (current.$metadata.requestId === undefined || row.$metadata.requestId !== current.$metadata.requestId)
      && (row.timestamp >= previous.timestamp && row.timestamp < current.timestamp
        || (previous.$metadata.requestId !== undefined && row.$metadata.requestId === previous.$metadata.requestId)));

    // Fiber recovery can log before onStart, in the same initializing invocation.
    const activationRows = rows.filter((row) => row.$workers.durableObjectId === current.$workers.durableObjectId
      && (next?.$metadata.requestId === undefined || row.$metadata.requestId !== next.$metadata.requestId)
      && (row.timestamp >= current.timestamp && row.timestamp < (next?.timestamp ?? window.to + 1)
        || (current.$metadata.requestId !== undefined && row.$metadata.requestId === current.$metadata.requestId)));

    const previousRequests = new Set(previousRows.map((row) => row.$metadata.requestId).filter((id) => id !== undefined));

    const priorOutcomes = rows.filter((row) => row.$workers.durableObjectId === previous.$workers.durableObjectId
      && row.$metadata.type === 'cf-worker-event' && row.$workers.outcome !== undefined && row.$workers.outcome !== 'ok'
      && ((row.timestamp >= previous.timestamp && row.timestamp < current.timestamp)
        || (row.$metadata.requestId !== undefined && previousRequests.has(row.$metadata.requestId))));

    const oldVersion = previous.$workers.scriptVersion?.id;
    const newVersion = current.$workers.scriptVersion?.id;
    const changedVersion = oldVersion !== undefined && newVersion !== undefined && oldVersion !== newVersion;
    const resumedOnNewBuild = activationRows.filter((row) => row.source.event === 'turn.resumed' && row.source.fields.sameBuild === 'no');

    const resetRows = previousRows.filter(codeUpdated);

    const deploy = changedVersion || resumedOnNewBuild.length > 0 || resetRows.length > 0;

    const invocation = current.$workers.eventType ?? activationRows.find((row) => row.$metadata.type === 'cf-worker-event'
      && row.$metadata.requestId !== undefined && row.$metadata.requestId === current.$metadata.requestId)?.$workers.eventType;

    const request = invocation === 'fetch' || invocation === 'rpc' || invocation === 'jsrpc';
    const own = touches.find((touch) => current.timestamp >= touch.from && current.timestamp <= touch.to);
    const fibers = activationRows.filter((row) => row.source.event === 'fiber.recovered');
    const requestSource = own === undefined ? 'other-or-unattributed-request' : 'driver-touch-by-time';

    disruptions.push({ at: iso(current.timestamp), previousStartupAt: iso(previous.timestamp),
      endedBy: deploy ? 'deploy' : 'eviction',
      evictionOutcomes: deploy ? [] : [...new Set(priorOutcomes.map((row) => row.$workers.outcome ?? 'unavailable'))],
      evictionDetail: deploy || priorOutcomes.length > 0 ? null : 'silent',
      deployEvidence: { changedVersion, oldVersion: oldVersion ?? null, newVersion: newVersion ?? null,
        resumedSameBuildNo: resumedOnNewBuild.map(evidence), codeUpdatedReset: resetRows.map(evidence) },
      resumedBy: { invocation: invocation ?? 'unavailable', alarm: invocation === 'alarm', fiberRecovery: fibers.length > 0,
        request: request ? requestSource : null,
        driverTouch: own ?? null },
      startup: evidence(current), previousNonOkInvocations: priorOutcomes.map(evidence), fibers: fibers.map(evidence) });
  }

  return disruptions;
}

function idleReport(rows: readonly TelemetryEvent[], window: CanaryWindow | null) {
  if (window === null) return null;
  const idle = rows.filter((row) => row.timestamp >= window.from && row.timestamp <= window.to);
  const startups = idle.filter((row) => row.source.event === 'actor.startup');
  const invocations = idle.filter((row) => row.$metadata.type === 'cf-worker-event');
  const alarms = invocations.filter((row) => row.$workers.eventType === 'alarm');

  return { window: { from: iso(window.from), to: iso(window.to) }, target: 0,
    startups: startups.length, alarms: alarms.length, otherInvocations: invocations.length - alarms.length,
    invocations: invocations.length, byType: countBy(invocations.map((row) => row.$workers.eventType ?? 'unavailable'), 0),
    startupEvidence: startups.map(evidence), invocationEvidence: invocations.map(evidence),
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
  const disruptions = activationDisruptions(rows, request.active, request.touches);
  const fiberEvents = active.filter((row) => row.source.event.startsWith('fiber.'));
  const idle = idleReport(rows, request.idle);

  const complete = objects.length > 0 && client.failures.length === 0 && client.acceptedSampling === 1
    && !client.limitations.some((limitation) => limitation.startsWith('Telemetry remains'));

  return { complete, objects, queries: client.queries, sampling: { largestSeen: client.maxSamplingSeen, accepted: client.acceptedSampling,
    sampledOrCappedWindowsAreSubdivided: true }, failures: client.failures, limitations: client.limitations,
    fieldSources: { activation: 'actor.startup fields.workspace + $workers.durableObjectId',
      endedBy: '$workers.scriptVersion.id across startups; turn.resumed fields.sameBuild=no; code-updated reset text; previous $workers.outcome',
      resumedBy: 'startup $workers.eventType (measured jsrpc, not only rpc); fiber.recovered within activation; driver touch windows by time',
      invocationTime: 'cf-worker-event timestamp is the platform row time, not an isolate termination id; successful invocations do not prove eviction.',
      invocationScope: 'Active invocation rows are only alarms and non-ok outcomes; successful active RPCs are not downloaded. All invocation types are queried in the idle window.',
      hosted: hostedResumes.map((row) => ({ actor: row.source.fields.actor, object: row.$workers.durableObjectId ?? null,
        matchesWorkspaceObject: row.$workers.durableObjectId !== undefined && objects.includes(row.$workers.durableObjectId),
        isCanaryHelper: request.helperActors.includes(row.source.fields.actor ?? '') })),
      unavailable: ['The API exposes no activation/eviction id or explicit silent-eviction reason.',
        'Request attribution to the driver is temporal, not a unique driver request-id match.',
        'A lost isolate may print a marker without committing its result; only durable output is observable.'] },
    classificationNotes: {
      endedBy: 'Every startup after the first is one disruption. Deploy wins over eviction; eviction outcome buckets can overlap if the previous activation had multiple non-ok outcomes.',
      resumedBy: 'Alarm and fiber recovery can both apply to one activation. Request includes the measured platform jsrpc type. These are resumption mechanisms, not termination causes.',
    },
    active: { window: { from: iso(request.active.from), to: iso(request.active.to) }, hours,
      startups: active.filter((row) => row.source.event === 'actor.startup').length,
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
    const idleCounts = [{ name: 'idle.startups', count: idle.startups, rows: idle.startupEvidence },
      { name: 'idle.alarm-invocations', count: idle.alarms, rows: idle.invocationEvidence.filter((row) => row.eventType === 'alarm') },
      { name: 'idle.other-invocations', count: idle.otherInvocations, rows: idle.invocationEvidence.filter((row) => row.eventType !== 'alarm') }];

    for (const item of idleCounts) {
      if (item.count === 0) continue;
      findings.push({ name: item.name, kind: 'defect', cause: 'The workspace object was invoked after all work ended and the driver disconnected; target is zero.',
        evidence: item.rows.map((row) => ({ at: row.at, event: row.event, count: 1,
          detail: `${row.eventType ?? 'unknown'} ${row.outcome ?? ''}; RPC ${row.rpcMethods.join(', ')}` })) });
    }
  }

  for (const failure of measured.failures) findings.push({ name: 'telemetry.read-failed', kind: 'measurement', cause: failure, evidence: [] });

  if (!measured.complete) findings.push({ name: 'telemetry.incomplete', kind: 'measurement', cause: measured.limitations.join(' '), evidence: [] });

  return findings;
}
