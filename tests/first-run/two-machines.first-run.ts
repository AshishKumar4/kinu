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
 *   unnamed   ask for `hostname` with no machine named. With two live machines
 *             the executor must refuse and ASK — naming both machines — rather
 *             than picking one. A silent pick is the original bug wearing a
 *             different hat, and it is red here even though it "works".
 */
import { afterAll, describe, test } from 'vitest';

import { scratchDir, workerSession, type EvalObservation } from '@kinu.run/test-utils';
import { attachMachine, detachMachine, grantDeviceConsent, type AttachedMachine } from './daemon';
import type { DeviceAccount } from '../evals/device-session';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
  type FirstRunSubgoal,
} from './first-run';

const SUITE = 'First-run · two-machines';
const CASE = 'two-machines' as const;

/**
 * The two machines, by the names a person would type.
 *
 * Deliberately unlike each other and unlike any hostname on the box: the reply
 * has to carry ONE of them, and two names that share a prefix would let a
 * substring check pass on the wrong machine.
 */
const ALPHA = 'kinu-first-run-alpha';
const BETA = 'kinu-first-run-beta';

const PLAN = firstRunCasePlan(SUITE, CASE);
const liveTest = test.skipIf(PLAN === null);
const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, [CASE], observations); });

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
            await grantDeviceConsent(account, machine.deviceId, session.workspace);
          }
          const [alpha, beta] = attached;
          if (alpha === undefined || beta === undefined) {
            throw new Error('both machines must attach before this case can ask either of them '
              + 'anything');
          }

          // ── named ───────────────────────────────────────────────────
          // Plain words. The prompt names the MACHINE and the COMMAND, and
          // nothing about how the tool takes a device: writing `device:` here
          // would test whether the model can copy an argument name.
          const named = await session.prompt(
            `Run the command hostname on my machine called ${ALPHA}, and reply with exactly what `
            + 'it printed and nothing else.',
          );
          const namedReply = await lastAnswer(session, named.text);
          const alphaLog = alpha.execLog();
          const betaLog = beta.execLog();

          // ── unnamed ─────────────────────────────────────────────────
          const unnamed = await session.prompt(
            'Now run hostname on my laptop and reply with exactly what it printed.',
          );
          const unnamedReply = await lastAnswer(session, unnamed.text);
          // The ask the executor is required to raise, by its own words
          // (`deviceFleetAsk`): both machines named, so the person or the model
          // can choose. Matched on the two NAMES rather than on the sentence:
          // the wording is the product's to change, the naming is the contract.
          const bothOffered = unnamedReply.includes(ALPHA) && unnamedReply.includes(BETA);

          return [
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
              reached: alpha.execLog().length === 1 && beta.execLog().length === 0,
              detail: `after the unnamed ask: ${ALPHA} ${String(alpha.execLog().length)} call(s), `
                + `${BETA} ${String(beta.execLog().length)} call(s)`,
            },
          ] satisfies FirstRunSubgoal[];
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
