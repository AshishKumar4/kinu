/**
 * The durability canary: one long agent turn on a deployment with nobody connected, then an idle tail, and the three
 * numbers the owner judges execution by (docs: kinu-logs/onstart/DESIGN.md, S0).
 *   1. Autonomy: the turn reaches its end with no client connected.
 *   2. Disruptions per hour of active work, by cause: `turn.resumed` rows, beside the invocation outcomes
 *      (exceededMemory, exceededCpu, exceededWallTime, canceled) the platform logged for the object.
 *   3. True rest: startups of the object during the idle tail after the turn ended; the target is zero.
 * Plus what a resume must never cost: a step bought twice (a marker printed twice) or an effect run twice.
 *
 * Two workloads (`scripts/canary-script.ts`): an inline turn of steps under the 30 s detach threshold, which stays
 * open for steps x sleep, and a few steps past it, which detach into background jobs that must settle on their own.
 *
 * Driven by `scripts/durability-canary.sh`, which resolves the `scripted` eval account the way the first-run tier does,
 * so the turn runs on the scripted model at zero model tokens.
 *   bun scripts/durability-canary.ts [--steps 720] [--sleep 20] [--jobs 3] [--job-sleep 900] [--helper-steps 30]
 *     [--tail-minutes 10] [--worker kinu-staging]
 */
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';
import { SCRIPTED_MODEL_SPEC } from '../packages/test-utils/src/scripted-model-spec';
import { resolvePublicSessionPlan } from '../evals/src/session';
import { CANARY_PREFIX, canaryAsk, canaryMarker, type CanaryLoad } from './canary-script';
import type { RunEvent } from '../packages/core/src/index';

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);

  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}

const load: CanaryLoad = {
  steps: Number(flag('steps', '720')),
  sleepSeconds: Number(flag('sleep', '20')),
  jobs: Number(flag('jobs', '3')),
  jobSleepSeconds: Number(flag('job-sleep', '900')),
  helperSteps: Number(flag('helper-steps', '30')),
};

// A step at or past the threshold detaches, and the inline workload would measure nothing.
if (load.sleepSeconds >= 30 || load.jobSleepSeconds <= 30) throw new Error('inline steps must sleep under 30 s and job steps past it');

const tailMs = Number(flag('tail-minutes', '10')) * 60_000;

const worker = flag('worker', 'kinu-staging');

const resolution = resolvePublicSessionPlan('durability-canary', SCRIPTED_MODEL_SPEC);

if (resolution.kind === 'unavailable') throw new Error(resolution.remedy);

const session = await resolution.plan.open({ subject: 'canary', purpose: 'Durability canary: one long turn, nobody connected.', genesis: false });

const MARKER = new RegExp(`${CANARY_PREFIX}_[A-Z]+_STEP_\\d+`, 'g');

/** One count per marker in the given texts. */
function markerCounts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const marker of texts.flatMap((text) => text.match(MARKER) ?? [])) counts.set(marker, (counts.get(marker) ?? 0) + 1);

  return counts;
}

const TimelineSchema = v.looseObject({
  object: v.string(),
  startupsByHour: v.array(v.looseObject({ startups: v.number() })),
  outcomes: v.array(v.looseObject({ eventType: v.string(), outcome: v.string(), count: v.number() })),
  topEvents: v.array(v.looseObject({ event: v.string(), count: v.number() })),
  sampling: v.number(),
});

/** One object's telemetry over a window, read through `prod-logs.ts timeline`, which owns the query shapes. The
 *  target is the workspace's name while the object id is unknown: a window with no startup (a resting tail) cannot
 *  resolve a name, so the tail is read by the id the active window named. A failed read is reported, not thrown, so
 *  the ledger half of the report still prints. */
function timeline(target: string, from: number, to: number): v.InferOutput<typeof TimelineSchema> | { readonly failed: string } {
  const run = spawnSync('bun', ['scripts/prod-logs.ts', 'timeline', target, '--worker', worker,
    '--since', new Date(from).toISOString(), '--until', new Date(to).toISOString(), '--json'], { encoding: 'utf8' });

  if (run.status !== 0) return { failed: run.stderr.slice(-500) };

  return v.parse(TimelineSchema, JSON.parse(run.stdout));
}

/** The canary's root runs, oldest first: a resumed turn may continue under a run of its own. */
function canaryRuns(events: readonly RunEvent[]): { readonly runId: string; readonly start: string; readonly end: RunEvent | undefined }[] {
  return events
    .filter((event) => event.type === 'run_start' && event.userMessage?.startsWith(CANARY_PREFIX) === true)
    .map((start) => ({
      runId: start.runId,
      start: start.timestamp,
      end: events.find((event) => event.runId === start.runId && event.type === 'run_end'),
    }));
}

/** The canary's own run starts it has seen, by run id. */
const known = new Map<string, { readonly start: string; cursor: number; end: RunEvent | undefined }>();

/**
 * Waits until the canary's newest run ends as completed, or until no run of it has been open for `quietMs`. It reads
 * the run list and each canary run's new events once per `pollMs`: nobody watches the turn meanwhile, and a poll every
 * five minutes is sparser than the platform's idle eviction, so it keeps nothing alive the product would not.
 */
async function waitForCompletion(pollMs: number, quietMs: number): Promise<void> {
  let quietSince = Date.now();

  for (;;) {
    for (const runId of await session.runIds()) {
      const seen = known.get(runId);

      if (seen?.end !== undefined) continue;
      const added = await session.runEventsOf(runId, seen === undefined ? 0 : seen.cursor + 1);
      const start = added.find((event) => event.type === 'run_start');

      if (seen === undefined && (start?.type !== 'run_start' || start.userMessage?.startsWith(CANARY_PREFIX) !== true)) continue;
      const entry = seen ?? { start: start?.timestamp ?? '', cursor: 0, end: undefined };

      for (const event of added) {
        entry.cursor = Math.max(entry.cursor, event.eventIndex);

        if (event.type === 'run_end') entry.end = event;
      }

      known.set(runId, entry);
    }

    const runs = [...known.values()].sort((a, b) => a.start.localeCompare(b.start));
    const newest = runs.at(-1);

    if (newest?.end?.type === 'run_end' && newest.end.reason === 'completed') return;

    if (runs.some((run) => run.end === undefined)) quietSince = Date.now();
    else if (Date.now() - quietSince > quietMs) return;

    await Bun.sleep(pollMs);
  }
}

try {
  const startedAt = Date.now();
  const submission = session.submit(canaryAsk(load));
  await session.awaitChunk(submission.requestId, (body) => body.includes('"tool-output-available"'));
  const opened = (await session.runEvents()).find((event) => event.type === 'run_start' && event.userMessage?.startsWith(CANARY_PREFIX) === true);

  if (opened === undefined) throw new Error('the canary turn opened no run');
  // Nobody is connected from here to the end of the turn: only the product keeps it running.
  session.disconnect();
  console.log(`canary ${session.workspace}: run ${opened.runId} open; client gone at ${new Date().toISOString()}`);

  await waitForCompletion(5 * 60_000, 20 * 60_000);

  const endedAt = Date.now();
  console.log(`canary ${session.workspace}: run ended at ${new Date(endedAt).toISOString()}; idle tail ${String(tailMs / 60_000)} min`);
  await Bun.sleep(tailMs);
  // Telemetry lands within a minute or two; the read waits it out rather than reading an empty tail.
  await Bun.sleep(120_000);

  await session.connect();
  const events = await session.runEvents();
  const runs = canaryRuns(events);
  const runIds = new Set(runs.map((run) => run.runId));

  const inline = markerCounts(events
    .filter((event) => runIds.has(event.runId) && event.type === 'tool_call_end')
    .map((event) => JSON.stringify(event.type === 'tool_call_end' ? event.result ?? null : null)));

  const expected = Array.from({ length: load.steps }, (_, step) => canaryMarker('root', step));
  const jobs = await session.backgroundJobs();
  const jobMarkers = markerCounts(jobs.map((job) => job.result ?? ''));

  const last = runs.at(-1)?.end;
  const runMs = runs.length > 0 && last !== undefined ? Date.parse(last.timestamp) - Date.parse(runs[0].start) : 0;
  const stepsLost = expected.filter((marker) => !inline.has(marker)).length;
  const stepsBoughtTwice = [...inline.entries(), ...jobMarkers.entries()].filter(([, n]) => n > 1).map(([marker, n]) => ({ marker, n }));

  // The ledger half first: it needs nothing but the object's own rows.
  console.log(JSON.stringify({
    ledger: {
      runs: runs.map((run) => ({ runId: run.runId, start: run.start, end: run.end?.type === 'run_end' ? run.end.reason : null })),
      stepsLost, stepsBoughtTwice, jobs: jobs.map((job) => job.status),
    },
  }));

  const active = timeline(session.workspace, startedAt, endedAt);
  const object = 'failed' in active ? null : active.object;
  const idle = object === null ? { failed: 'no object id from the active window' } : timeline(object, endedAt + 30_000, endedAt + tailMs);
  const hours = (endedAt - startedAt) / 3_600_000;
  const resumed = 'failed' in active ? null : active.topEvents.find((e) => e.event === 'turn.resumed')?.count ?? 0;

  const report = {
    workspace: session.workspace,
    object,
    load,
    activeHours: Number(hours.toFixed(2)),
    autonomy: {
      completed: last?.type === 'run_end' && last.reason === 'completed',
      runsOpened: events.filter((e) => e.type === 'run_start' && e.userMessage?.startsWith(CANARY_PREFIX) === true).length,
      // The inline workload held the turn open for its planned length, or it measured something else.
      runMinutes: Number((runMs / 60_000).toFixed(1)),
      plannedMinutes: Number((load.steps * load.sleepSeconds / 60).toFixed(1)),
      heldPlannedLength: runMs >= load.steps * load.sleepSeconds * 1000,
    },
    detached: {
      planned: load.jobs,
      settled: jobs.filter((job) => job.status === 'completed').length,
      statuses: jobs.map((job) => job.status),
      markersSeen: Array.from({ length: load.jobs }, (_, j) => canaryMarker('job', j)).filter((marker) => jobMarkers.has(marker)).length,
    },
    disruptions: 'failed' in active ? active : {
      resumed,
      perHour: Number(((resumed ?? 0) / hours).toFixed(2)),
      outcomes: active.outcomes.filter((o) => o.outcome !== 'ok'),
    },
    stepsLost,
    stepsBoughtTwice,
    idleStartups: 'failed' in idle ? idle : idle.startupsByHour.reduce((sum, h) => sum + h.startups, 0),
  };

  console.log(JSON.stringify(report, null, 1));
} finally {
  await session.teardown();
}
