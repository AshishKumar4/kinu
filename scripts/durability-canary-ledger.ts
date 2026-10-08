import * as v from 'valibot';
import { decodeModelMessageValues, type RunEvent } from '../packages/core/src/index';
import { helperAddress, ROOT } from '../evals/src/helper-address';
import type { KinuPublicSession, PublicBackgroundJob, PublicMessage } from '../evals/src/session';
import { CANARY_PREFIX, canaryMarker, type CanaryLoad } from './canary-script';

export interface CanaryFinding {
  readonly name: string;
  /** `limitation`: what the canary cannot observe from outside; it names the gap and fails nothing. */
  readonly kind: 'defect' | 'disruption' | 'measurement' | 'limitation';
  readonly cause: string;
  readonly evidence: readonly { readonly at: string | null; readonly event: string; readonly count: number; readonly detail: string }[];
}

interface MarkerWitness {
  readonly marker: string;
  readonly at: string | null;
  readonly runId: string | null;
}

interface HelperRecord {
  readonly name: string;
  readonly actor: string | null;
  readonly status: string;
  readonly events: readonly RunEvent[];
  readonly failure: string | null;
}

export interface CanaryLedger {
  readonly events: readonly RunEvent[];
  readonly history: readonly PublicMessage[];
  readonly jobs: readonly PublicBackgroundJob[];
  readonly helpers: readonly HelperRecord[];
  readonly roster: Awaited<ReturnType<KinuPublicSession['subordinates']>>;
  readonly agents: Awaited<ReturnType<KinuPublicSession['agents']>>;
  readonly swarms: Awaited<ReturnType<KinuPublicSession['swarmRuns']>>;
}

async function helperEvents(session: KinuPublicSession, child: {
  readonly name: string; readonly status: string; readonly actorReference: { readonly actorId: string } | null;
}): Promise<RunEvent[]> {
  const address = helperAddress(ROOT, child);
  const events: RunEvent[] = [];

  for (let cursor: { after: string } | undefined; ;) {
    const requestPage = cursor === undefined ? { limit: 200 } : { limit: 200, cursor };
    const pageOfRuns = await session.inspect({ ...address, path: [...address.path], view: 'runs', page: requestPage });

    if (pageOfRuns.view !== 'runs') throw new Error(`helper ${child.name}: ${pageOfRuns.view === 'missing' ? pageOfRuns.error : 'runs unavailable'}`);

    for (const run of pageOfRuns.page.items) {
      for (let since = 0; ;) {
        const page = await session.inspect({ ...address, path: [...address.path], view: 'events', runId: run.runId, query: { since, limit: 500 } });

        if (page.view !== 'events') throw new Error(`helper ${child.name}: ${page.view === 'missing' ? page.error : 'events unavailable'}`);
        events.push(...page.page.items);

        if (page.page.status === 'end') break;
        since = page.page.next;
      }
    }

    if (pageOfRuns.page.status === 'end') return events;
    cursor = pageOfRuns.page.next;
  }
}

export async function readCanaryLedger(session: KinuPublicSession): Promise<CanaryLedger> {
  const events = await session.runEvents();

  const [history, jobs, roster, agents, swarms] = await Promise.all([
    session.history(), session.backgroundJobs(), session.subordinates(), session.agents(), session.swarmRuns(),
  ]);

  const helpers: HelperRecord[] = [];

  for (let cursor: { after: string } | undefined; ;) {
    const page = cursor === undefined ? { limit: 200 } : { limit: 200, cursor };
    const children = await session.inspect({ path: [], view: 'children', page });

    if (children.view !== 'children') throw new Error(`helper roster: ${children.view === 'missing' ? children.error : 'children unavailable'}`);

    for (const child of children.page.items) {
      if (child.lifetime !== 'task') continue;

      try {
        helpers.push({ name: child.name, actor: child.actorReference?.actorId ?? null, status: child.status,
          events: await helperEvents(session, child), failure: null });
      } catch (error) {
        helpers.push({ name: child.name, actor: child.actorReference?.actorId ?? null, status: child.status,
          events: [], failure: String(error) });
      }
    }

    if (children.page.status === 'end') break;
    cursor = children.page.next;
  }

  return { events, history, jobs, helpers, roster, agents, swarms };
}

function shellWitnesses(events: readonly RunEvent[]): MarkerWitness[] {
  return events.flatMap((event) => event.type !== 'tool_call_end' || event.name !== 'shell' ? [] :
    [...JSON.stringify(event.result ?? null).matchAll(/KINU_CANARY_(?:ROOT|HELPER|NODE|JOB)_STEP_\d+/g)]
      .map(([marker]) => ({ marker, at: event.timestamp, runId: event.runId })));
}

function answers(events: readonly RunEvent[], marker: string): MarkerWitness[] {
  const witnesses: MarkerWitness[] = [];

  for (const event of events) {
    if (event.type !== 'step_finish') continue;

    for (const message of decodeModelMessageValues(event.messages ?? [])) {
      if (message.role !== 'assistant') continue;

      const texts = v.is(v.string(), message.content) ? [message.content]
        : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []);

      for (const text of texts) {
        for (const found of text.matchAll(new RegExp(`\\b${marker}\\b`, 'g'))) {
          witnesses.push({ marker: found[0], at: event.timestamp, runId: event.runId });
        }
      }
    }
  }

  return witnesses;
}

function markers(expected: readonly string[], witnesses: readonly MarkerWitness[]) {
  const counts = new Map<string, MarkerWitness[]>();

  for (const witness of witnesses) {
    const rows = counts.get(witness.marker) ?? [];
    rows.push(witness);
    counts.set(witness.marker, rows);
  }

  return {
    expected: expected.length,
    seen: expected.filter((marker) => counts.has(marker)).length,
    missing: expected.filter((marker) => !counts.has(marker)),
    duplicated: [...counts].filter(([, rows]) => rows.length > 1).map(([marker, rows]) => ({ marker, count: rows.length, evidence: rows })),
    unexpected: [...counts.keys()].filter((marker) => !expected.includes(marker)),
    counts: [...counts].map(([marker, rows]) => ({ marker, count: rows.length, at: rows.map((row) => row.at) })),
  };
}

function runs(events: readonly RunEvent[], done: readonly MarkerWitness[]) {
  return events.filter((event) => event.type === 'run_start').map((start) => {
    const ends = events.filter((event) => event.runId === start.runId && event.type === 'run_end');
    const end = ends.at(-1);

    return { runId: start.runId, start: start.timestamp, end: end?.timestamp ?? null,
      reason: end?.type === 'run_end' ? end.reason ?? null : null, ends: ends.length,
      completedEnds: ends.filter((event) => event.type === 'run_end' && event.reason === 'completed').length,
      done: done.filter((witness) => witness.runId === start.runId).length };
  });
}

const SwarmResult = v.object({
  candidates: v.array(v.object({ id: v.string(), artifact: v.string(), incomplete: v.nullable(v.string()) })),
});

function swarmCandidates(ledger: CanaryLedger) {
  const results = ledger.events.flatMap((event) => event.type === 'tool_call_end' && event.name === 'agents' ? [event.result] : []);

  for (const job of ledger.jobs) {
    if (job.kind !== 'agents' || job.result == null) continue;
    results.push(JSON.parse(job.result));
  }

  const candidates = new Map<string, { id: string; artifact: string; incomplete: string | null }>();

  for (const result of results) {
    const parsed = v.safeParse(SwarmResult, result);

    if (!parsed.success) continue;

    for (const candidate of parsed.output.candidates) candidates.set(candidate.id, candidate);
  }

  return [...candidates.values()].map((candidate) => ({ id: candidate.id, result: candidate.artifact,
    incomplete: candidate.incomplete, done: [...candidate.artifact.matchAll(/\bKINU_CANARY_NODE_DONE\b/g)].length }));
}

export function measureCanaryLedger(ledger: CanaryLedger, load: CanaryLoad) {
  const rootDone = answers(ledger.events, `${CANARY_PREFIX}_ROOT_DONE`);
  const rootRuns = runs(ledger.events, rootDone);

  const helperRecords = ledger.helpers.filter((helper) => helper.failure !== null || helper.events.some((event) =>
    event.type === 'run_start' && event.userMessage?.includes(`${CANARY_PREFIX} helper`) === true));

  const helpers = helperRecords.map((helper) => {
    const done = answers(helper.events, `${CANARY_PREFIX}_HELPER_DONE`);

    return { name: helper.name, actor: helper.actor, status: helper.status, failure: helper.failure,
      runs: runs(helper.events, done), done: { count: done.length, evidence: done },
      markers: markers(Array.from({ length: load.helperSteps }, (_, step) => canaryMarker('helper', step)), shellWitnesses(helper.events)) };
  });

  const expectedJobs = Array.from({ length: load.jobs }, (_, step) => canaryMarker('job', step));

  const jobs = ledger.jobs.filter((job) => job.kind === 'shell' && (expectedJobs.some((marker) => job.label?.includes(marker) === true)
    || job.result?.includes(`${CANARY_PREFIX}_JOB_STEP_`) === true));

  const jobWitnesses = jobs.flatMap((job) => [...(job.result ?? '').matchAll(/KINU_CANARY_JOB_STEP_\d+/g)]
    .map(([marker]) => ({ marker, at: job.settledAt == null ? null : new Date(job.settledAt).toISOString(), runId: null })));

  const nodes = swarmCandidates(ledger);

  const rootReceived = ledger.history.filter((message) => message.role !== 'assistant').flatMap((message) =>
    [...message.text.matchAll(/\bKINU_CANARY_HELPER_DONE\b/g)].map(() => ({ id: message.id ?? null, role: message.role })));

  const helperDone = helpers.flatMap((helper) => helper.done.evidence);

  // A report that lands while the root's turn runs rides its next step as a non-durable message (Inbox.prepareStep):
  // no root row records it, so the root's rows can neither count nor miss it.
  const absorbedMidTurn = helperDone.filter((witness) => witness.at !== null && rootRuns.some((run) =>
    Date.parse(run.start) <= Date.parse(witness.at ?? '') && (run.end === null || Date.parse(witness.at ?? '') <= Date.parse(run.end))));

  const rootFinalRuns = rootRuns.filter((run) => run.done > 0);

  const ended = rootFinalRuns.some((run) => run.reason === 'completed') && helperDone.length > 0
    && helpers.every((helper) => helper.runs.some((run) => run.done > 0 && run.reason === 'completed'))
    && jobs.length >= load.jobs && jobs.every((job) => job.status !== 'running' && job.status !== 'serving')
    && ledger.jobs.every((job) => job.status !== 'running' && job.status !== 'serving')
    && !ledger.agents.some((agent) => agent.activity === 'working') && nodes.length >= 5;

  const completionTimes = [
    ...rootFinalRuns.flatMap((run) => run.end === null ? [] : [Date.parse(run.end)]),
    ...helperDone.flatMap((witness) => witness.at === null ? [] : [Date.parse(witness.at)]),
    ...ledger.jobs.flatMap((job) => job.settledAt == null ? [] : [job.settledAt]),
  ];

  const missingJobTimes = ledger.jobs.some((job) => job.settledAt == null);
  const finishedAt = ended && !missingJobTimes && completionTimes.length > 0 ? Math.max(...completionTimes) : null;

  return {
    ended, finishedAt,
    root: { runsOpened: rootRuns.length, runs: rootRuns, completedDoneRuns: rootFinalRuns.filter((run) => run.reason === 'completed').length,
      completedEnds: rootFinalRuns.reduce((sum, run) => sum + run.completedEnds, 0),
      done: { count: rootDone.length, evidence: rootDone },
      markers: markers(Array.from({ length: load.steps }, (_, step) => canaryMarker('root', step)), shellWitnesses(ledger.events).filter((witness) => witness.marker.includes('_ROOT_'))) },
    helper: { found: helpers.length, helpers, resultReceivedByRoot: { count: rootReceived.length, source: 'root history, non-assistant messages', evidence: rootReceived },
      absorbedMidTurn,
      ingressRuns: ledger.events.filter((event) => event.type === 'run_start' && event.userMessage?.includes(`${CANARY_PREFIX}_HELPER_DONE`) === true)
        .map((event) => ({ runId: event.runId, at: event.timestamp })) },
    jobs: { planned: load.jobs, found: jobs.length, completed: jobs.filter((job) => job.status === 'completed').length,
      markers: markers(expectedJobs, jobWitnesses), rows: jobs,
      otherJobs: ledger.jobs.filter((job) => !jobs.includes(job)), settledTimestampsAvailable: !missingJobTimes },
    swarm: { expectedNodes: 5, nodes, done: nodes.reduce((sum, node) => sum + node.done, 0), runs: ledger.swarms },
    roster: ledger.roster, agents: ledger.agents,
  };
}

export type CanaryMeasurement = ReturnType<typeof measureCanaryLedger>;

function markerFindings(owner: string, measured: CanaryMeasurement['root']['markers']): CanaryFinding[] {
  const findings: CanaryFinding[] = [];

  if (measured.missing.length > 0) findings.push({ name: `${owner}.steps-lost`, kind: 'defect', cause: 'No committed shell output contains these planned markers.',
    evidence: [{ at: null, event: 'tool_call_end/result', count: measured.missing.length, detail: measured.missing.join(', ') }] });

  if (measured.duplicated.length > 0) findings.push({ name: `${owner}.step-bought-twice`, kind: 'defect',
    cause: `${String(measured.duplicated.length)} planned markers were printed more than once.`,
    evidence: measured.duplicated.flatMap((duplicate) => duplicate.evidence.map((witness) => ({ at: witness.at,
      event: 'tool_call_end/result', count: 1, detail: `${witness.marker} observed ${String(duplicate.count)} times` }))) });

  if (measured.unexpected.length > 0) findings.push({ name: `${owner}.unplanned-steps`, kind: 'defect', cause: 'Shell output contains markers outside the planned load.',
    evidence: [{ at: null, event: 'tool_call_end/result', count: measured.unexpected.length, detail: measured.unexpected.join(', ') }] });

  return findings;
}

export function ledgerFindings(measured: CanaryMeasurement): CanaryFinding[] {
  const findings = [...markerFindings('root', measured.root.markers), ...markerFindings('jobs', measured.jobs.markers)];

  const once = (name: string, count: number, event: string, evidence: readonly MarkerWitness[]) => {
    if (count === 1) return;
    findings.push({ name, kind: 'defect', cause: `Expected exactly one intact result; observed ${String(count)}.`,
      evidence: evidence.length === 0 ? [{ at: null, event, count, detail: 'result absent' }]
        : evidence.map((witness) => ({ at: witness.at, event, count, detail: witness.marker })) });
  };

  once('root.result-not-exactly-once', measured.root.done.count, 'step_finish/assistant', measured.root.done.evidence);
  once('root.completed-run-count', measured.root.completedDoneRuns, 'run_end', measured.root.done.evidence);
  once('root.completed-end-count', measured.root.completedEnds, 'run_end', measured.root.done.evidence);
  const delivered = measured.helper.resultReceivedByRoot.count + measured.helper.ingressRuns.length;

  if (delivered === 0 && measured.helper.absorbedMidTurn.length > 0) {
    findings.push({ name: 'helper.result-absorbed-mid-turn', kind: 'limitation',
      cause: 'The helper finished while the root turn ran, so its report rode a step as a non-durable message that no root row records.',
      evidence: measured.helper.absorbedMidTurn.map((witness) => ({ at: witness.at, event: 'helper DONE inside a root run', count: 1, detail: witness.marker })) });
  } else {
    once('helper.result-delivery-not-exactly-once', delivered, 'root.history and root run_start', []);
  }

  if (measured.helper.found !== 1) findings.push({ name: 'helper.not-found-exactly-once', kind: 'defect', cause: 'The retained helper ledger did not identify exactly one canary task hire.',
    evidence: [{ at: null, event: 'inspectSubordinate', count: measured.helper.found, detail: measured.helper.helpers.map((helper) => helper.name).join(', ') }] });

  for (const helper of measured.helper.helpers) {
    if (helper.failure !== null) {
      findings.push({ name: 'helper.ledger-unavailable', kind: 'measurement', cause: helper.failure,
        evidence: [{ at: null, event: 'inspectSubordinate', count: 1, detail: helper.name }] });
      continue;
    }

    findings.push(...markerFindings(`helper.${helper.name}`, helper.markers));
    once(`helper.${helper.name}.result-not-exactly-once`, helper.done.count, 'step_finish/assistant', helper.done.evidence);
  }

  if (measured.jobs.completed !== measured.jobs.planned) findings.push({ name: 'jobs.not-completed', kind: 'defect', cause: 'Planned detached shell jobs did not all settle completed.',
    evidence: [{ at: null, event: 'listBackgroundJobs', count: measured.jobs.completed, detail: `planned ${String(measured.jobs.planned)}; ${measured.jobs.rows.map((job) => `${job.id}:${job.status}`).join(', ')}` }] });

  if (measured.swarm.nodes.length !== measured.swarm.expectedNodes || measured.swarm.nodes.some((node) => node.done !== 1 || node.incomplete !== null)) {
    findings.push({ name: 'swarm.results-not-intact', kind: 'defect', cause: 'Each of the five ideate candidates must retain one NODE_DONE.',
      evidence: [{ at: null, event: 'agents.swarm/candidates', count: measured.swarm.done, detail: JSON.stringify(measured.swarm.nodes) }] });
  }

  return findings;
}
