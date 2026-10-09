/**
 * FIRST RUN: two machines are two machines.
 *
 * THE DEFECT. The owner had a Mac and a Linux box connected at once. The
 * executor answered as if the account had one: the hub picked "the first live
 * socket", which is whichever machine map iteration yielded, so two calls in one
 * turn could land on different machines and neither the user nor the agent could
 * say which.
 *
 * WHY EVERY GATE STAYED GREEN. Every device test in this tree attaches ONE fake
 * daemon. With one machine, "the first live socket" and "the machine the user
 * named" are the same machine, so the routing bug is unobservable — not
 * under-tested, UNOBSERVABLE. The fixture could not express the account the
 * owner has.
 *
 * SO THIS CASE BRINGS TWO REAL DAEMONS. Two registrations, two homes, two
 * processes, two names, each with its own `hostname` on its own PATH — because
 * two laptops answer that question differently and two daemons on one host would
 * not. Each machine's shim appends to that machine's own exec log, so "the other
 * machine never ran it" is something the OTHER MACHINE recorded rather than
 * something this file inferred from a reply.
 *
 * THE TWO DIRECTIONS, both hard:
 *
 *   named     ask, in plain words, for `hostname` on the machine called
 *             <alpha>. The reply carries ALPHA's answer, alpha's exec log holds
 *             the call, and BETA'S EXEC LOG IS EMPTY. The last clause is the
 *             defect: a run that answered from beta, or from both, is red.
  *   unnamed   ask for `hostname` with no machine named, FIRST, before any
  *             answer sits in context — a recalled answer never reaches the
  *             executor, which is what this half probes. With two live
  *             machines the executor must refuse and ASK — naming both
  *             machines — rather than picking one. A silent pick is the
  *             original bug wearing a different hat, and it is red here even
  *             though it "works".
 *
 * THEN THE FLEET WITHOUT A MODEL, as the account and the workspace's CLI RPC
 * see it: both machines listed live by name; beta's daemon stops, and a call
 * named for alpha still lands on alpha alone while one named for beta runs on
 * no machine rather than being stood in for.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import { infraBoundary, scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { attachMachine, detachMachine, grantDeviceConsent, type AttachedMachine } from './daemon';
import { listDevicesOverCliRoute, type DeviceAccount } from './device-session';
import { FLEET_ALPHA as ALPHA, FLEET_BETA as BETA, NAMED_MACHINE_ASK, UNNAMED_MACHINE_ASK } from './asks';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · two-machines';

const CASE = 'two-machines' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account: DeviceAccount = {
      origin: PLAN.origin,
      cliToken: workerSession(PLAN.llm).token,
      identity: PLAN.identity,
    };

    const attached: AttachedMachine[] = [];

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        modelCalls: 'expected',
        // Genesis independently probes both machines before the unnamed ask.
        // This row measures routing for the two explicit asks, not orientation.
        genesis: false,
        purpose: 'An assistant working across the owner\'s two machines, which it must never '
          + 'confuse for one.',
        async run({ session }) {
          // SEQUENTIALLY, and that is not fussiness: both registrations write
          // the same account's device table, and the second machine must arrive
          // knowing the first is already there.
          for (const name of [ALPHA, BETA]) {
            const machine = await attachMachine({
              account, name, home: scratchDir(`first-run-${name}`),
            });

            attached.push(machine);
            // Named: with two live the fleet refuses an unnamed call with the
            // ask and raises no card, so the second grant can never mint one
            // unnamed (docs/EXECUTION-LAYER-SPEC.md "The user's account is a
            // fleet"). The name is what the owner would tap.
            await grantDeviceConsent(account, machine.deviceId, session.workspace, name);
          }

          const [alpha, beta] = attached;

          if (alpha === undefined || beta === undefined) {
            throw new Error('both machines must attach before this case can ask either of them '
              + 'anything');
          }

          // ── unnamed, FIRST ──────────────────────────────────────────
          // Before any answer sits in context: a recalled `hostname` never
          // reaches the executor, which is what this half probes — and trying
          // each machine in turn bypasses it the same way (measured
          // 2026-09-05: seven recalls, then a fan-out that ran beta and left
          // alpha behind a consent prompt). The trailing sentence closes the
          // fan-out hatch; the executor's own refusal names both machines, so
          // a model that asks on its own cannot reach both names any other way.
          const unnamed = await session.prompt(UNNAMED_MACHINE_ASK);

          const unnamedReply = await lastAnswer(session, unnamed.landed === 'turn' ? unnamed.text : '');
          // The ask the executor is required to raise, by its own words
          // (`deviceFleetAsk`): both machines named, so the person or the model
          // can choose. Matched on the two NAMES rather than on the sentence:
          // the wording is the product's to change, the naming is the contract.
          const bothOffered = unnamedReply.includes(ALPHA) && unnamedReply.includes(BETA);
          const alphaLogAfterUnnamed = alpha.execLog();
          const betaLogAfterUnnamed = beta.execLog();

          // ── named ───────────────────────────────────────────────────
          // Plain words. The prompt names the MACHINE and the COMMAND, and
          // nothing about how the tool takes a device: writing `device:` here
          // would test whether the model can copy an argument name.
          const named = await session.prompt(NAMED_MACHINE_ASK);

          const namedReply = await lastAnswer(session, named.landed === 'turn' ? named.text : '');
          const alphaLog = alpha.execLog();
          const betaLog = beta.execLog();

          // ── the fleet without a model ───────────────────────────────
          const listed = await listDevicesOverCliRoute(account);
          const liveNow = (rows: typeof listed.rows, name: string) => rows?.some((row) => row.label === name && row.connected) === true;

          // Beta's own end, which its daemon process reports: nothing here waits on a duration.
          beta.stop();
          const betaExit = await beta.exited;
          const alphaBefore = alpha.execLog().length;
          const stayed = await runOnMachine(account, session.workspace, 'hostname', ALPHA);
          const left = await runOnMachine(account, session.workspace, 'hostname', BETA);
          const alphaAfter = alpha.execLog().length;
          const betaAfter = beta.execLog().length;

          return [
            {
              what: 'unnamed-call-asks',
              reached: bothOffered,
              detail: bothOffered
                ? 'the unnamed call was refused with both machines named'
                : 'an unnamed call did NOT ask which machine — with two live machines the '
                  + `executor picked one silently, or said nothing about either: `
                  + JSON.stringify(unnamedReply.slice(0, 240)),
            },
            {
              what: 'unnamed-call-ran-nothing-new',
              reached: alphaLogAfterUnnamed.length === 0 && betaLogAfterUnnamed.length === 0,
              detail: `after the unnamed ask: ${ALPHA} ${String(alphaLogAfterUnnamed.length)} call(s), `
                + `${BETA} ${String(betaLogAfterUnnamed.length)} call(s)`,
            },
            {
              what: 'named-machine-answered',
              reached: namedReply.includes(ALPHA) && !namedReply.includes(BETA),
              detail: `the reply to a call named for ${ALPHA}: `
                + JSON.stringify(namedReply.slice(0, 240)),
            },
            {
              what: 'named-machine-ran-it',
              reached: alphaLog.length === 1,
              detail: `${ALPHA} recorded ${String(alphaLog.length)} hostname call(s): `
                + JSON.stringify(alphaLog),
            },
            {
              what: 'other-machine-untouched',
              reached: betaLog.length === 0,
              detail: betaLog.length === 0
                ? `${BETA} ran nothing, which is what naming the other machine has to mean`
                : `${BETA} RAN THE COMMAND TOO — a call named for ${ALPHA} reached both machines: `
                  + JSON.stringify(betaLog),
            },
            {
              what: 'both-machines-listed',
              reached: liveNow(listed.rows, ALPHA) && liveNow(listed.rows, BETA),
              detail: `GET /api/cli/devices answered ${String(listed.status)}: ${listed.body}; `
                + JSON.stringify(listed.rows?.map((row) => ({ label: row.label, connected: row.connected })) ?? null),
            },
            {
              what: 'other-machine-survives-leave',
              reached: stayed.stdout.includes(ALPHA) && alphaAfter === alphaBefore + 1,
              detail: `${BETA}'s daemon exited ${String(betaExit)}; a call named for ${ALPHA} answered ${stayed.detail}; `
                + `${ALPHA} recorded ${String(alphaAfter - alphaBefore)} call(s) across both named calls`,
            },
            {
              what: 'gone-machine-not-stood-in-for',
              // Its refusal may name the machine it could not reach; what matters is that no machine ran it.
              reached: !left.stdout.includes(`${ALPHA}\n`) && alphaAfter === alphaBefore + 1 && betaAfter === betaLog.length,
              detail: `a call named for the stopped ${BETA} answered ${left.detail}; ${BETA} recorded `
                + `${String(betaAfter - betaLog.length)} more call(s)`,
            },
          ] satisfies EvalSubgoal[];
        },
      }, observations);
    } finally {
      // Every machine, even after one teardown fails: a stranded registration
      // is a real machine a workspace can still reach.
      for (const machine of attached) {
        const left = await detachMachine(account, machine);

        if (left !== null) console.warn(`    [first-run] ${CASE} teardown: ${left}`);
      }
    }
  });
});

const ExecAnswerSchema = v.object({ result: v.object({ error: v.optional(v.string()), stdout: v.optional(v.string()) }) });

/** One command on the named machine through the workspace's CLI RPC, as `grantDeviceAccess` raises its card. */
async function runOnMachine(
  account: DeviceAccount, workspace: string, command: string, machine: string,
): Promise<{ readonly stdout: string; readonly error: string | null; readonly detail: string }> {
  const url = `${account.origin}/api/cli/workspaces/${encodeURIComponent(workspace)}/rpc`;

  return infraBoundary(`POST ${url} (${command} on ${machine})`, async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.cliToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'executeInExecutor', args: ['device', command, machine] }),
    });

    const text = await response.text();
    const parsed = response.ok ? v.safeParse(ExecAnswerSchema, JSON.parse(text)) : null;

    if (parsed === null || !parsed.success) {
      return { stdout: '', error: `HTTP ${String(response.status)}`, detail: `${String(response.status)} ${text.slice(0, 240)}` };
    }

    const { stdout = '', error = null } = parsed.output.result;

    return { stdout, error, detail: JSON.stringify(parsed.output.result).slice(0, 240) };
  });
}

/** The durable answer to the last turn, which is what a person reads when they
 *  come back. Falls back to the streamed text only when the transcript has not
 *  caught up. */
async function lastAnswer(
  session: { history(): Promise<readonly { role: string; text: string }[]> },
  streamed: string,
): Promise<string> {
  const history = await session.history();

  return history.filter((row) => row.role === 'assistant').at(-1)?.text ?? streamed;
}

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
