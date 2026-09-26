/**
 * The durability canary: one long agent turn on a deployment with nobody connected, then an idle tail, and the three
 * numbers the owner judges execution by (docs: kinu-logs/onstart/DESIGN.md, S0).
 *   1. Autonomy: the turn reaches its end with no client connected.
 *   2. Disruptions per hour of active work, by cause: `turn.resumed` rows, beside the invocation outcomes
 *      (exceededMemory, exceededCpu, exceededWallTime, canceled) the platform logged for the object.
 *   3. True rest: startups of the object during the idle tail after the turn ended; the target is zero.
 * Plus what a resume must never cost: a step bought twice (a marker printed twice) or an effect run twice.
 *
 * Driven by `scripts/durability-canary.sh`, which resolves the `scripted` eval account the way the first-run tier does,
 * so the turn runs on the scripted model at zero model tokens (`scripts/canary-script.ts`).
 *   bun scripts/durability-canary.ts [--steps 240] [--helper-steps 30] [--sleep 55] [--tail-minutes 10] [--worker kinu-staging]
 */
import { spawnSync } from 'node:child_process';
import * as v from 'valibot';
import type { RunEvent } from '../packages/core/src/index';
import { SCRIPTED_MODEL_SPEC } from '../packages/test-utils/src/scripted-model-spec';
import { resolvePublicSessionPlan } from '../evals/src/session';
import { CANARY_PREFIX, canaryAsk, canaryMarker, type CanaryLoad } from './canary-script';

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);

  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}

const load: CanaryLoad = {
  steps: Number(flag('steps', '240')),
  helperSteps: Number(flag('helper-steps', '30')),
  sleepSeconds: Number(flag('sleep', '55')),
};

const tailMs = Number(flag('tail-minutes', '10')) * 60_000;

const worker = flag('worker', 'kinu-staging');

const resolution = resolvePublicSessionPlan('durability-canary', SCRIPTED_MODEL_SPEC);

if (resolution.kind === 'unavailable') throw new Error(resolution.remedy);

const session = await resolution.plan.open({ subject: 'canary', purpose: 'Durability canary: one long turn, nobody connected.', genesis: false });

/** One count per marker the root's ledger printed, from the tool results it recorded. */
function markerCounts(events: readonly RunEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    if (event.type !== 'tool_call_end') continue;

    for (const marker of JSON.stringify(event.result ?? null).match(new RegExp(`${CANARY_PREFIX}_[A-Z]+_STEP_\\d+`, 'g')) ?? []) {
      counts.set(marker, (counts.get(marker) ?? 0) + 1);
    }
  }

  return counts;
}

const TimelineSchema = v.looseObject({
  object: v.string(),
  startupsByHour: v.array(v.looseObject({ startups: v.number() })),
  outcomes: v.array(v.looseObject({ eventType: v.string(), outcome: v.string(), count: v.number() })),
  topEvents: v.array(v.looseObject({ event: v.string(), count: v.number() })),
  sampling: v.number(),
});

/** One object's telemetry over a window, read through `prod-logs.ts timeline`, which owns the query shapes. */
function timeline(from: number, to: number): v.InferOutput<typeof TimelineSchema> {
  const run = spawnSync('bun', ['scripts/prod-logs.ts', 'timeline', session.workspace, '--worker', worker,
    '--since', new Date(from).toISOString(), '--until', new Date(to).toISOString(), '--json'], { encoding: 'utf8' });

  if (run.status !== 0) throw new Error(`prod-logs timeline failed: ${run.stderr.slice(0, 500)}`);

  return v.parse(TimelineSchema, JSON.parse(run.stdout));
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

  let cursor = 0;
  let ended = false;

  while (!ended) {
    for await (const event of session.followRun(opened.runId, cursor)) {
      cursor = event.eventIndex;
      ended = event.type === 'run_end';

      if (ended) break;
    }

    // The follow stream ends when the object does; the next follow resumes at the cursor.
    if (!ended) await Bun.sleep(5_000);
  }

  const endedAt = Date.now();
  console.log(`canary ${session.workspace}: run ended at ${new Date(endedAt).toISOString()}; idle tail ${String(tailMs / 60_000)} min`);
  await Bun.sleep(tailMs);
  // Telemetry lands within a minute or two; the read waits it out rather than reading an empty tail.
  await Bun.sleep(120_000);

  await session.connect();
  const events = await session.runEvents();
  const counts = markerCounts(events.filter((event) => event.runId === opened.runId));
  const expected = Array.from({ length: load.steps }, (_, step) => canaryMarker('root', step));
  const active = timeline(startedAt, endedAt);
  const idle = timeline(endedAt + 30_000, endedAt + tailMs);
  const hours = (endedAt - startedAt) / 3_600_000;
  const resumed = active.topEvents.find((e) => e.event === 'turn.resumed')?.count ?? 0;

  const report = {
    workspace: session.workspace,
    object: active.object,
    load,
    activeHours: Number(hours.toFixed(2)),
    autonomy: { runEnded: true, runsOpened: events.filter((e) => e.type === 'run_start' && e.userMessage?.startsWith(CANARY_PREFIX) === true).length },
    disruptions: {
      resumed,
      perHour: Number((resumed / hours).toFixed(2)),
      outcomes: active.outcomes.filter((o) => o.outcome !== 'ok'),
    },
    stepsLost: expected.filter((marker) => !counts.has(marker)).length,
    stepsBoughtTwice: [...counts.entries()].filter(([, n]) => n > 1).map(([marker, n]) => ({ marker, n })),
    idleStartups: idle.startupsByHour.reduce((sum, h) => sum + h.startups, 0),
    sampling: Math.max(active.sampling, idle.sampling),
  };

  console.log(JSON.stringify(report, null, 1));
} finally {
  await session.teardown();
}
