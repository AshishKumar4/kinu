/**
 * FIRST RUN: commands run in the sandbox at once all return their output.
 *
 * THE DEFECT. On staging 690e3a6040 (2026-09-28) the background-settle case's
 * `sleep 45 && echo KINU_SETTLED_AFTER_DETACH` exited 0 and the product answered
 * "(no output)". The SDK's process lane carries a command's output through FIFOs
 * its own monitor can delete before the command opens them; the command then
 * writes into a plain file nothing reads, and the lane records empty stdout for
 * good. Measured through startProcess at 16 at once: 143 of 1175 final lines
 * lost. The lane is now the container runtime's own exec: 0 of 1200.
 *
 * THE ASSERTION, hard: one program runs 200 commands, 16 at a time, through
 * `sandbox.exec` with no deadline (the lane the defect lived in), and every
 * command's mark comes back.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { firstRunSpliceStep, firstRunTurnEvents } from './turn-settlement';
import { EXEC_OUTPUT_ASK as ASK, EXEC_OUTPUT_COMMANDS as COMMANDS } from './asks';
import type { RunEvent } from '../../packages/core/src/index';

const SUITE = 'First-run · sandbox-exec-output';

const CASE = 'sandbox-exec-output' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const isToolCallEnd = (event: RunEvent): event is ToolCallEnd => event.type === 'tool_call_end';

/** The line the program returns: how many marks came back, and the first few that did not. */
const CountSchema = v.pipe(v.string(), v.regex(/EXEC (\d+)\/(\d+) LOST (\S+)/u));

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A terse assistant that runs the program it is given and reports its line.',
      async run({ session }) {
        const landing = await session.prompt(ASK);

        const calls = firstRunTurnEvents(await session.runEvents(), ASK, {
          splicedAtStep: firstRunSpliceStep(await session.history(), ASK),
          absorbedBy: landing.landed === 'mid-turn' ? landing.absorbedBy : undefined,
        }).filter(isToolCallEnd);

        const program = calls.find((call) => call.name === 'eval');
        const line = JSON.stringify(program?.result ?? program?.error ?? '');
        const counted = v.safeParse(CountSchema, line);
        const match = counted.success ? /EXEC (\d+)\/(\d+) LOST (\S+)/u.exec(counted.output) : null;

        return [
          {
            what: 'every-output-returned',
            reached: match !== null && match[1] === String(COMMANDS) && match[2] === String(COMMANDS),
            detail: program === undefined
              ? 'no eval call ran the program in this turn'
              : `the program answered ${line.slice(0, 300)}`,
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
