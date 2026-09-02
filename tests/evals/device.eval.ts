/**
 * THE DEVICE TIER: one machine linked to a deployment, and one command run on
 * it from a workspace, over the surfaces a person uses.
 *
 * WHY IT EXISTS. `kinu connect` reported failure on a Mac and a Linux PC on
 * 2026-09-01 while the daemon on each was connected and rotating its token. The
 * cause was `GET /api/cli/devices` answering 500 — `SELECT`ing `unstopped_at`
 * from a `user_devices` table created before that column existed — and the
 * connect command's own success check reads that route. Nothing in the tree
 * exercised it against a deployment, so the whole device path shipped with zero
 * deployed coverage: every device test was a unit test over a mock socket.
 *
 * WHAT IT MEASURES, in one sequence, because the steps depend on each other:
 *
 *   devices-route  `GET /api/cli/devices` answers 200 and the THIRTEEN fields
 *                  `UserDO.listDevices` declares. Read BEFORE anything is
 *                  registered, so a 500 is attributed to the route rather than
 *                  to the daemon that had not started yet.
 *   connect        `connectDevice` — the CLI's one connect implementation —
 *                  registers this machine, installs the daemon the CLI ships,
 *                  starts it, and confirms it connected.
 *   listed         the new device is in the list with `connected: true`.
 *   command        a fresh workspace runs `echo` ON THE MACHINE through
 *                  `executeInExecutor('laptop', …)`, the RPC the Env tab's
 *                  terminal is bound to, after the owner grants consent through
 *                  the route Account settings uses.
 *   revoked        `DELETE /api/user/devices/:id` lands, the deployment stops
 *                  reporting the device connected, and the daemon's own log
 *                  records its socket closing.
 *   refused        a further command answers a CLASSIFIED refusal rather than
 *                  running on a machine nobody is allowed to reach.
 *
 * WHERE IT RUNS. Cloud only, and it needs BOTH authorities: the CLI bearer for
 * `/api/cli/*` and the browser identity for `/api/user/*`. Under
 * `KINU_EVAL_BACKEND=cloud` a missing half is a FAILURE, never a skip — the tier
 * refuses that backend without a credential precisely so an arm cannot exit 0
 * having measured nothing.
 *
 * WHICH MACHINE. This one. The daemon is installed into the runner's throwaway
 * `KINU_HOME` and `requireIsolatedAgentHome` refuses to start otherwise, so the
 * developer's own `~/.kinu` — and the daemon their real `kinu connect` left
 * running — is never touched.
 *
 * WHY THE RECORD READS `ADMISSIBLE: NO`. `assessAdmissibility` is written over
 * AGENT EPISODES: it requires a closed turn and a tool call, and this arm closes
 * no turn because it calls no model. The record is this family's ARTIFACT — what
 * ran, what it cost, which steps held — and the assertions below are its gate.
 * The tier knows: the device arm carries `self` liveness in `scripts/eval-tier.sh`,
 * so it is never held to a model call it does not claim to make.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  EVAL_MODELS, assessAdmissibility, outcomeRow, publishRunRecord,
  recordWorkspaceSpend, reportLiveModelSpend, resolveEvalBackend, subgoalOutcome, workerSession,
  type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalTier,
} from '@kinu.run/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import {
  DEVICE_CONNECT_DEADLINE_MS, connectDevice, daemonStatus, killSessionDaemon, readDaemonLogTail,
} from '../../packages/cli/src/device-connect';
import { disposeFailedCase } from './episode-failure';
import { resolvePublicSessionPlan, type KinuPublicSession, type PublicSessionPlan } from './public-session';
import {
  DEVICE_STEPS, completeSubgoals, deviceArmGate, grantDeviceConsent, listDevicesOverCliRoute,
  readDeviceCommand, removeDeviceFiles, requireIsolatedAgentHome, revokeDeviceOverUserRoute,
  runTeardown, type DeviceAccount, type DeviceStep, type DeviceSubgoal,
} from './device-session';

const SUITE = 'Device Evals';
const REPO_ROOT = join(import.meta.dirname, '../..');
const TASK_ID = 'device-connect-e2e';

/** Which arm this process is — the same split the five sibling arms declare. */
const TIER: EvalTier = process.env.KINU_EVAL_TIER === 'pro' ? 'pro' : 'flash';

/**
 * The string the round-trip carries. A fixed marker rather than prose: a check
 * that greps for a paraphrase measures the grep, and this one has to prove the
 * bytes came back off another machine's shell.
 */
const ROUNDTRIP_MARKER = 'KINU_DEVICE_ROUNDTRIP_OK';

/** How long the deployment's device state is given to settle after a revoke.
 *  The PRODUCT's own figure — `connectDevice` waits exactly this long for a
 *  device to appear connected — rather than a number invented here, so the two
 *  directions of the same state change are held to one bound. */
const SETTLE_DEADLINE_MS = DEVICE_CONNECT_DEADLINE_MS;
const SETTLE_POLL_MS = 1_000;

/**
 * WHERE THIS RUN GOES, and what a missing half means.
 *
 * The knob first, the plan second, the decision third — `deviceArmGate` owns
 * that decision so the credential-free tier can drive all three of its
 * directions. A skip is only ever "this backend has no device plane"; under
 * cloud a missing credential fails the arm.
 */
const BACKEND = resolveEvalBackend();
const RESOLUTION = resolvePublicSessionPlan(SUITE, EVAL_MODELS[TIER]);
const GATE = deviceArmGate(BACKEND.kind === 'ready' ? BACKEND.backend : 'refused', RESOLUTION);
if (GATE.kind === 'skip') console.warn(`[skip] ${SUITE} — ${GATE.reason}`);
const PLAN: PublicSessionPlan | null = RESOLUTION.kind === 'ready' ? RESOLUTION.plan : null;
if (PLAN !== null) console.warn(`[live] ${SUITE} — ${PLAN.describe}`);
const liveTest = test.skipIf(GATE.kind === 'skip');

/**
 * The arm, recorded because a measurement whose mechanism was switched off is
 * not a measurement of that mechanism. No tool surface and no evolution: this
 * family drives the deployed ROUTES and the device tunnel, and never a model.
 */
const ARM: EvalArmState = { evolution: false, settle: 'none', tools: [] };

/** Retained beside the record, never under a swept root — the same
 *  `resolveArtifactRoot` rule every other family states. */
const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `device-${TIER}-${String(Date.now())}`,
);

const observations: EvalObservation[] = [];

/**
 * What the walk below discovers and the teardown undoes.
 *
 * ONE NAMED OWNER rather than four loose bindings, and it is load-bearing: the
 * walk is a closure, so after it a plain `let` still reads as its initializer
 * and every line that consumes the session would be unreachable code the
 * compiler is right about.
 */
interface DeviceCaseState {
  /** The device this case registered, or null before `connectDevice` answered. */
  deviceId: string | null;
  /** The workspace it opened, or null before the command step. */
  session: KinuPublicSession | null;
  /** Whether the measured revoke already landed, so teardown does not repeat it. */
  revoked: boolean;
  /** Executor invocations this case made — the device plane's own `exec` tool,
   *  reached through the deployed router. The record's covariate. */
  execCalls: number;
}

/** Poll until the deployment's own view settles, bounded by the product's
 *  connect deadline. A state change on another machine's socket is observed,
 *  never assumed — and the bound is evidence of "it never settled", not a
 *  correctness deadline. */
async function settles(check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, SETTLE_POLL_MS);
    await tick.promise;
  }
}

afterAll(() => {
  const spend = reportLiveModelSpend(SUITE);
  publishRunRecord({
    family: 'device', tier: TIER, modelId: PLAN?.llm.model ?? EVAL_MODELS[TIER],
    repeats: 1, seed: 1, arm: ARM, declaredTasks: [TASK_ID], observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
});

describe('Device evals — one machine, linked and driven through the deployed API', () => {
  /**
   * CREDENTIAL-FREE: the run this arm publishes measures what it declared.
   *
   * Driven over a synthetic observation because the property is about the
   * RECORD's shape: a device run that reports no step verdict is a record of
   * nothing, and this family's primary metric is the step count.
   */
  test('the record carries a step outcome or it is not evidence', () => {
    const scored: EvalObservation = {
      taskId: TASK_ID, repetition: 0, outcome: 'scored',
      scores: [outcomeRow(subgoalOutcome(
        DEVICE_STEPS.length, DEVICE_STEPS.length, 'every step reached',
      ))],
      turns: 0, toolCalls: 2, tokensIn: 0, tokensOut: 0, ms: 1_000,
    };
    expect(assessAdmissibility([TASK_ID], [scored]).outcomesScored).toBe(1);

    // And a run that recorded activity without a step verdict is NOT evidence
    // about the device path, however many calls it made.
    const activityOnly: EvalObservation = { ...scored, scores: [] };
    expect(assessAdmissibility([TASK_ID], [activityOnly]).failures.join(' '))
      .toContain('task_outcome');
  });

  liveTest(`MEASURED: ${TASK_ID}`, async () => {
    if (GATE.kind !== 'run' || PLAN === null) {
      throw new Error(GATE.kind === 'run' ? 'unreachable: a running gate carries a plan' : GATE.reason);
    }
    // Before the daemon exists, so a developer's own device credential can never
    // be the one this case overwrites.
    requireIsolatedAgentHome();

    const startedAt = Date.now();
    // The bearer is RECOVERED from the resolved target rather than re-read from
    // the environment: two readings are two answers to where this run went.
    const account: DeviceAccount = {
      origin: PLAN.origin,
      cliToken: workerSession(PLAN.llm).token,
      identity: PLAN.identity,
    };
    const observed: DeviceSubgoal[] = [];
    const note = (what: DeviceStep, reached: boolean, detail: string): boolean => {
      observed.push({ what, reached, detail });
      return reached;
    };

    const state: DeviceCaseState = {
      deviceId: null, session: null, revoked: false, execCalls: 0,
    };

    const walk = async (): Promise<void> => {
      // ── devices-route ──────────────────────────────────────────────────
      // The production defect, first and cheapest: this is the read
      // `connectDevice` itself polls, so a 500 here explains a connect that
      // reported failure while the daemon was up.
      const before = await listDevicesOverCliRoute(account);
      if (!note('devices-route', before.status === 200 && before.rows !== null,
        `GET /api/cli/devices → ${String(before.status)}; ${before.rows === null
          ? `the deployment did not answer the declared device list: ${before.body}`
          : `${String(before.rows.length)} device(s), every declared field present`}`)) return;

      // ── connect ────────────────────────────────────────────────────────
      // The CLI's ONE implementation. Session mode, so the daemon is this
      // process's child and dies with it even if teardown never runs.
      const result = await connectDevice({ origin: account.origin, token: account.cliToken }, {
        session: true,
        label: `kinu-eval-${String(Date.now())}`,
      });
      if (result.kind !== 'already-running') state.deviceId = result.deviceId;
      if (!note('connect', result.kind === 'connected',
        `connectDevice → ${result.kind}${result.kind === 'timeout'
          ? ` after ${String(DEVICE_CONNECT_DEADLINE_MS)}ms; daemon log tail: `
            + readDaemonLogTail(6)
          : ''}`)) return;

      // ── listed ─────────────────────────────────────────────────────────
      const listed = await listDevicesOverCliRoute(account);
      const row = listed.rows?.find((device) => device.id === state.deviceId) ?? null;
      if (!note('listed', row?.connected === true,
        row === null
          ? `the new device ${String(state.deviceId)} is absent from the list (${String(listed.status)}): `
            + listed.body
          : `${row.id} "${row.label}" on ${String(row.hostname)} — connected ${String(row.connected)}, `
            + `lastSeenAt ${String(row.lastSeenAt)}, expiresAt ${String(row.expiresAt)}`)) return;

      // ── command ────────────────────────────────────────────────────────
      // A fresh workspace, created through the REST the web app creates one
      // with, then the consent the owner grants in Account settings, then the
      // RPC the Env tab's terminal is bound to.
      const session = await PLAN.open({
        subject: TASK_ID,
        purpose: 'Run one command on a linked device through the laptop executor.',
      });
      state.session = session;
      if (state.deviceId !== null) {
        await grantDeviceConsent(account, state.deviceId, session.workspace);
      }
      state.execCalls += 1;
      const answer = readDeviceCommand(await session.execute('laptop', `echo ${ROUNDTRIP_MARKER}`));
      if (!note('command', answer.kind === 'output' && answer.stdout.includes(ROUNDTRIP_MARKER),
        answer.kind === 'output'
          ? `laptop echo → ${JSON.stringify(answer.stdout.slice(0, 200))}`
          : `laptop echo refused (${answer.reason}): ${answer.text.slice(0, 300)}`)) return;

      // ── revoked ────────────────────────────────────────────────────────
      const revocation = state.deviceId === null
        ? { status: 0, body: 'no device id was recorded' }
        : await revokeDeviceOverUserRoute(account, state.deviceId);
      state.revoked = revocation.status === 200;
      const gone = state.revoked && await settles(async () => {
        const now = await listDevicesOverCliRoute(account);
        return now.rows?.some((device) => device.id === state.deviceId && device.connected) !== true;
      });
      // The daemon is still ALIVE and retrying — a revoked device is a closed
      // socket, not a dead process, and the CLI's own reconnect loop is what
      // makes that true. So the proof is its log, not its exit status.
      const log = readDaemonLogTail(12);
      const closed = /Disconnected|credentials were rejected/.test(log);
      if (!note('revoked', state.revoked && gone && closed,
        `DELETE → ${String(revocation.status)}${revocation.status === 200 ? '' : ` ${revocation.body}`}; `
        + `deployment reports it disconnected: ${String(gone)}; daemon socket closed: ${String(closed)}; `
        + `daemon child still running: ${String(daemonStatus().sessionActive)}`)) return;

      // ── refused ────────────────────────────────────────────────────────
      state.execCalls += 1;
      const after = readDeviceCommand(
        await session.execute('laptop', `echo ${ROUNDTRIP_MARKER}`),
      );
      note('refused', after.kind === 'refused' && !after.text.includes(ROUNDTRIP_MARKER),
        after.kind === 'refused'
          ? `laptop echo refused (${after.reason}): ${after.text.slice(0, 300)}`
          : `THE COMMAND STILL RAN on a revoked machine: ${after.stdout.slice(0, 300)}`);
    };

    let thrown: Error | null = null;
    let teardown: readonly string[] = [];
    try {
      await walk();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      // FOUR AUTHORITIES, four steps, every one of them run. The device row is
      // undone first: it is the only thing here that outlives the process, and
      // a case that stranded a linked machine on the account would leave a real
      // machine reachable by a workspace nobody is watching.
      teardown = await runTeardown([
        {
          what: 'revoke the device',
          run: async () => {
            if (state.deviceId === null || state.revoked) return;
            const answer = await revokeDeviceOverUserRoute(account, state.deviceId);
            if (answer.status !== 200) {
              throw new Error(`DELETE /api/user/devices/${state.deviceId} → `
                + `${String(answer.status)} ${answer.body}`);
            }
          },
        },
        { what: 'stop the session daemon', run: () => { killSessionDaemon(); } },
        { what: 'delete the workspace', run: async () => { await state.session?.teardown(); } },
        { what: 'remove the device credential', run: () => { removeDeviceFiles(); } },
      ]);
    }

    const subgoals = completeSubgoals(observed);
    const reached = subgoals.filter((subgoal) => subgoal.reached).length;
    const detail = subgoals
      .map((subgoal) => `${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`)
      .join('; ');

    // WHAT THIS RUN SAW, printed whichever way it went: the transcript is the
    // deliverable, and a failure whose server text lives only in an assertion
    // message is a failure nobody can act on.
    console.warn(`    [device] ${PLAN.describe}`);
    for (const subgoal of subgoals) {
      console.warn(`    [device] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
    }
    if (teardown.length > 0) console.warn(`    [device] teardown: ${teardown.join('; ')}`);

    if (thrown !== null) {
      observations.push({
        taskId: TASK_ID, repetition: 0,
        outcome: disposeFailedCase(thrown).outcome,
        reason: thrown.message,
      });
      throw thrown;
    }

    // The spend the workspace reported, recorded before any assertion can throw:
    // what a run cost is a fact about the run, not a reward for passing. It is
    // usually zero here — this arm calls no model — and the tier holds the
    // device arm to its own steps rather than to a model call.
    if (state.session !== null) recordWorkspaceSpend(await state.session.spend());

    const scores: EvalScoreRow[] = [
      outcomeRow(subgoalOutcome(reached, subgoals.length, detail, {
        turns: 0, toolCalls: state.execCalls,
      })),
    ];
    observations.push({
      taskId: TASK_ID, repetition: 0, outcome: 'scored', scores,
      turns: 0, toolCalls: state.execCalls, toolNames: ['laptop.exec'],
      tokensIn: 0, tokensOut: 0, ms: Date.now() - startedAt,
    });

    for (const subgoal of subgoals) {
      expect(subgoal.reached, `${TASK_ID}/${subgoal.what}: ${subgoal.detail}`).toBe(true);
    }
    expect(teardown, 'the case left something behind').toEqual([]);
  });
});
