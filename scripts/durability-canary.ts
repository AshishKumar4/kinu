/** A staging measurement, never a repair: no workspace read between disconnect and the planned inspection,
 * and none during the idle tail. Account lease beats update only UserDO's roster, not the workspace object. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SCRIPTED_MODEL_SPEC } from '../packages/test-utils/src/scripted-model-spec';
import { resolvePublicSessionPlan, type KinuPublicSession } from '../evals/src/session';
import { BACKGROUND_POLICY } from '../packages/core/src/index';
import { CANARY_PREFIX, canaryAsk, type CanaryLoad } from './canary-script';
import { ledgerFindings, measureCanaryLedger, readCanaryLedger, type CanaryFinding, type CanaryMeasurement } from './durability-canary-ledger';
import { measureCanaryTelemetry, telemetryFindings, type CanaryTelemetryMeasurement, type CanaryTouch, type CanaryWindow } from './durability-canary-telemetry';

const MINUTE = 60_000;

const TELEMETRY_LAG = 2 * MINUTE;

const RECHECK = 15 * MINUTE;

const iso = (at: number): string => new Date(at).toISOString();

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);

  if (at < 0) return fallback;
  const value = process.argv[at + 1];

  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);

  return value;
}

function numberFlag(name: string, fallback: string): number {
  const value = Number(flag(name, fallback));

  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} requires a non-negative finite number`);

  return value;
}

const load: CanaryLoad = {
  steps: numberFlag('steps', '540'), sleepSeconds: numberFlag('sleep', '20'),
  helperSteps: numberFlag('helper-steps', '540'), jobs: numberFlag('jobs', '3'), jobSleepSeconds: numberFlag('job-sleep', '900'),
};

if (Object.values(load).some((value) => !Number.isSafeInteger(value))) throw new Error('canary load knobs must be integers (the deployed script parses integer loads)');

if (load.steps < 1 || load.helperSteps < 1 || load.sleepSeconds < 1 || load.sleepSeconds >= 30 || load.jobSleepSeconds <= 30) {
  throw new Error('root/helper steps must be positive, inline sleep must be 1..29 s, and job sleep must be past 30 s');
}

const tailMs = numberFlag('tail-minutes', '60') * MINUTE;

const marginMs = numberFlag('margin-minutes', '10') * MINUTE;

const recheckCapMs = numberFlag('max-recheck-minutes', '60') * MINUTE;

if (tailMs <= TELEMETRY_LAG) throw new Error('--tail-minutes must exceed 2 so the idle window after the settling margin is nonempty');

const worker = flag('worker', 'kinu-staging');

const out = flag('out', `/mnt/local/kinu/logs/bg-canary-${iso(Date.now()).replaceAll(':', '-')}.json`);

const detachMs = BACKGROUND_POLICY.interactive.detachAfterMs;

const swarmMs = load.helperSteps * load.sleepSeconds * 1000;

const swarmForegroundMs = Math.min(swarmMs, detachMs);

const prefixMs = swarmForegroundMs + load.jobs * detachMs;

const rootMs = prefixMs + load.steps * load.sleepSeconds * 1000;

const helperMs = swarmForegroundMs + swarmMs;

const jobsMs = load.jobs === 0 ? 0 : swarmForegroundMs + (load.jobs - 1) * detachMs + load.jobSleepSeconds * 1000;

const plannedMs = Math.max(rootMs, helperMs, jobsMs, swarmMs);

const plan = {
  model: SCRIPTED_MODEL_SPEC, worker, load, ask: canaryAsk(load),
  timelineMinutes: { swarmNodesParallel: swarmMs / MINUTE, root: rootMs / MINUTE, helper: helperMs / MINUTE,
    lastDetachedShellJob: jobsMs / MINUTE, work: plannedMs / MINUTE, inspectionMargin: marginMs / MINUTE,
    firstWorkspaceTouch: (plannedMs + marginMs) / MINUTE, recheckEvery: RECHECK / MINUTE,
    maxRecheckAfterFirstTouch: recheckCapMs / MINUTE, idleTail: tailMs / MINUTE,
    idleMeasurementStartsAfterLastTouch: TELEMETRY_LAG / MINUTE, telemetryLagAfterTail: TELEMETRY_LAG / MINUTE,
    earliestReport: (plannedMs + marginMs + tailMs + TELEMETRY_LAG) / MINUTE },
  noWorkspaceTraffic: 'Disconnect after the first tool output; inspect only at the planned work end plus margin, then at most every 15 minutes up to the cap. Disconnect again for the entire idle tail.',
  accountLeaseHeartbeat: 'Every 60 s, POST /api/user/workspaces/:name/touch updates UserDO.last_visited only; no workspace RPC. Idle object telemetry includes any invocation it might unexpectedly cause.',
  assumptions: ['The ideate swarm has five parallel nodes, each using helper steps.',
    'The swarm and detached shell calls return after the 30 s interactive foreground window; hire returns immediately.',
    'Provider/tool/queue overhead is not included in the sleep arithmetic; the inspection margin and capped rechecks disclose overruns.'],
  out,
};

if (process.argv.includes('--plan')) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

async function waitUntil(until: number, phase: string): Promise<void> {
  while (Date.now() < until) {
    console.error(`canary ${phase}: workspace untouched; ${String(Math.ceil((until - Date.now()) / MINUTE))} min to ${iso(until)}`);
    await Bun.sleep(Math.min(MINUTE, until - Date.now()));
  }
}

const createdAt = Date.now();

let session: KinuPublicSession | null = null;

let opened: { readonly runId: string; readonly timestamp: string } | null = null;

let disconnectedAt: number | null = null;

let firstTouch: number | null = null;

let measured: CanaryMeasurement | null = null;

let telemetry: CanaryTelemetryMeasurement | null = null;

let idle: CanaryWindow | null = null;

const touches: CanaryTouch[] = [];

const findings: CanaryFinding[] = [];

let integrityFindings: CanaryFinding[] = [];

let fatal: string | null = null;

let cleanup: string | null = null;

async function inspect(sessionToRead: KinuPublicSession, reason: string): Promise<CanaryMeasurement> {
  const from = Date.now();
  firstTouch ??= from;

  try {
    return measureCanaryLedger(await readCanaryLedger(sessionToRead), load);
  } finally {
    sessionToRead.disconnect();
    touches.push({ from, to: Date.now(), reason });
  }
}

try {
  const resolution = resolvePublicSessionPlan('durability-canary', SCRIPTED_MODEL_SPEC);

  if (resolution.kind === 'unavailable') throw new Error(resolution.remedy);
  session = await resolution.plan.open({ subject: 'background', purpose: 'Durability canary: root and hired agent work with nobody connected.', genesis: false });
  const submission = session.submit(canaryAsk(load));
  await Promise.race([session.awaitChunk(submission.requestId, (body) => body.includes('"tool-output-available"')), submission.settled]);
  const start = (await session.runEvents()).find((event) => event.type === 'run_start' && event.userMessage?.startsWith(`${CANARY_PREFIX} root`) === true);

  if (start === undefined) throw new Error('the scripted canary opened no root run');
  opened = { runId: start.runId, timestamp: start.timestamp };
  session.disconnect();
  disconnectedAt = Date.now();
  console.error(`canary ${session.workspace}: ${start.runId}; client disconnected ${iso(disconnectedAt)}; first inspection ${iso(Date.parse(start.timestamp) + plannedMs + marginMs)}`);
  await waitUntil(Math.max(disconnectedAt, Date.parse(start.timestamp) + plannedMs + marginMs), 'active window');
  measured = await inspect(session, 'planned end plus margin');
  const inspectionStarted = firstTouch ?? Date.now();
  const cap = inspectionStarted + recheckCapMs;
  let recheckAt = inspectionStarted + RECHECK;

  while (!measured.ended && recheckAt <= cap) {
    await waitUntil(recheckAt, 'completion recheck');
    measured = await inspect(session, '15-minute completion recheck');
    recheckAt += RECHECK;
  }

  integrityFindings = ledgerFindings(measured);
  findings.push(...integrityFindings);
  const lastTouch = touches.at(-1)?.to ?? Date.now();

  if (measured.ended) {
    idle = { from: lastTouch + TELEMETRY_LAG, to: lastTouch + tailMs };
    await waitUntil(idle.to, 'idle tail');
  } else {
    findings.push({ name: 'work.not-finished-at-inspection-cap', kind: 'defect', cause: 'Work remained unfinished at the configured observation cap; no idle-rest claim is made.',
      evidence: [{ at: iso(lastTouch), event: 'ledger inspection', count: touches.length,
        detail: `root DONE ${String(measured.root.done.count)}, helper DONE ${String(measured.helper.helpers.reduce((sum, helper) => sum + helper.done.count, 0))}, jobs completed ${String(measured.jobs.completed)}/${String(load.jobs)}` }] });
  }

  await waitUntil((idle?.to ?? lastTouch) + TELEMETRY_LAG, 'telemetry landing');
} catch (error) {
  fatal = String(error);
  session?.disconnect();
  findings.push({ name: 'canary.deployment-or-driver-failure', kind: 'measurement', cause: fatal,
    evidence: [{ at: iso(Date.now()), event: 'driver', count: 1, detail: 'No product code was changed or repaired.' }] });
  await waitUntil(Date.now() + TELEMETRY_LAG, 'failure telemetry landing');
}

const observedTo = idle?.to ?? touches.at(-1)?.to ?? Date.now() - TELEMETRY_LAG;

const activeFrom = opened === null ? createdAt : Date.parse(opened.timestamp);

const activeTo = measured?.finishedAt ?? touches.at(-1)?.to ?? observedTo;

if (session !== null) {
  try {
    telemetry = await measureCanaryTelemetry({ worker, workspace: session.workspace,
      observed: { from: createdAt, to: observedTo }, active: { from: activeFrom, to: activeTo }, idle, touches,
      helperActors: measured?.helper.helpers.flatMap((helper) => helper.actor === null ? [] : [helper.actor]) ?? [] });
    findings.push(...telemetryFindings(telemetry));
  } catch (error) {
    findings.push({ name: 'telemetry.unavailable', kind: 'measurement', cause: String(error), evidence: [] });
  }

  try {
    await session.teardown();
    cleanup = 'workspace deleted after measurement';
  } catch (error) {
    cleanup = `teardown failed: ${String(error)}`;
    findings.push({ name: 'canary.teardown-failed', kind: 'measurement', cause: cleanup, evidence: [] });
  }
}

const beforeFirstTouch = measured?.finishedAt == null || firstTouch === null ? null : measured.finishedAt < firstTouch;

if (measured?.ended === true && beforeFirstTouch !== true) findings.push({ name: 'work.autonomy-not-proven', kind: 'defect',
  cause: beforeFirstTouch === false ? 'Work finished only after the first driver inspection; the inspection may have woken the object.'
    : 'Work ended, but at least one completion timestamp was unavailable, so finishing before the first touch cannot be proven.',
  evidence: [{ at: measured.finishedAt === null ? null : iso(measured.finishedAt), event: 'run_end/helper DONE/jobs settledAt', count: 1,
    detail: `first touch ${firstTouch === null ? 'none' : iso(firstTouch)}` }] });

const intact = measured !== null && integrityFindings.length === 0;

const idleRest = telemetry?.complete === true && telemetry.idle !== null && telemetry.idle.startups === 0
  && telemetry.idle.alarms === 0 && telemetry.idle.otherInvocations === 0;

const passed = fatal === null && intact && beforeFirstTouch === true && idleRest
  && !findings.some((finding) => finding.kind === 'measurement' || finding.kind === 'defect');

const report = {
  schema: 'kinu.background-agent-canary.v1', recordedAt: iso(Date.now()), worker, workspace: session?.workspace ?? null,
  model: SCRIPTED_MODEL_SPEC, load, plan, out, passed, fatal, cleanup,
  accountLeaseHeartbeat: { intervalSeconds: 60, target: 'UserDO roster only, no workspace RPC',
    source: 'evals/src/session.ts markLive; cf-backend/src/user/workspaces.ts touchWorkspace',
    idleWorkspaceInvocationCount: telemetry?.idle?.invocations ?? null },
  timing: { createdAt: iso(createdAt), runStartedAt: opened?.timestamp ?? null,
    disconnectedAt: disconnectedAt === null ? null : iso(disconnectedAt),
    firstWorkspaceTouchAt: firstTouch === null ? null : iso(firstTouch),
    lastWorkspaceTouchAt: touches.length === 0 ? null : iso(touches[touches.length - 1].to),
    touches: touches.map((touch) => ({ from: iso(touch.from), to: iso(touch.to), reason: touch.reason })),
    finishedAt: measured?.finishedAt == null ? null : iso(measured.finishedAt),
    activeWindowCensored: measured?.finishedAt == null,
    activeHours: (activeTo - activeFrom) / 3_600_000 },
  autonomy: { ended: measured?.ended ?? false, finishedBeforeFirstTouch: beforeFirstTouch, exactlyOnceAndResultIntact: intact },
  ledger: measured, telemetry, findings,
};

await mkdir(dirname(out), { recursive: true });

await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);

console.error(`canary ${session?.workspace ?? '(not created)'}: finished before first touch=${String(beforeFirstTouch)}; intact=${String(intact)}; disruptions=${String(telemetry?.active.disruptions ?? 'unmeasured')}; idle startups/alarms/other=${String(telemetry?.idle?.startups ?? 'unmeasured')}/${String(telemetry?.idle?.alarms ?? 'unmeasured')}/${String(telemetry?.idle?.otherInvocations ?? 'unmeasured')}; report ${out}`);

for (const finding of findings) {
  console.error(`${finding.kind} ${finding.name}: ${finding.cause}`);

  for (const row of finding.evidence.slice(0, 3)) console.error(`  ${row.at ?? 'timestamp unavailable'} ${row.event} count=${String(row.count)} ${row.detail.slice(0, 240)}`);

  if (finding.evidence.length > 3) console.error(`  ${String(finding.evidence.length - 3)} more evidence rows in the JSON report`);
}

console.log(JSON.stringify(report, null, 2));

process.exitCode = passed ? 0 : 1;
