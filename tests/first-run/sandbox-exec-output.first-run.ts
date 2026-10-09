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
 * THE ASSERTION, hard: one program runs its commands, many at a time, through
 * `sandbox.exec` with no deadline (the lane the defect lived in), and every
 * command's mark comes back.
 *
 * WHERE THE LINE ARRIVES. A program that outruns the 30 s foreground window is
 * detached and settles as a background job (docs/TOOLS.md: detached work has no
 * deadline), and on a freshly reset deployment the execs are held while the base
 * snapshot builds (D79): staging d930f2537 (2026-10-09) answered the call with a
 * job handle. The line is then the settled job's own result, read off its row.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { firstRunSpliceStep, firstRunTurnEvents, settledJob } from './turn-settlement';
import { EXEC_OUTPUT_ASK as ASK, EXEC_OUTPUT_COMMANDS as COMMANDS } from './asks';
import { isBackgroundHandle, type RunEvent } from '../../packages/core/src/index';

const SUITE = 'First-run · sandbox-exec-output';

const CASE = 'sandbox-exec-output' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const isToolCallEnd = (event: RunEvent): event is ToolCallEnd => event.type === 'tool_call_end';

/** The line the program returns: how many marks came back, and the first few that did not. */
const CountSchema = v.pipe(v.string(), v.regex(/EXEC (\d+)\/(\d+) LOST (\S+)/u));

/** Where the program's line came from: its call, or the job it detached into, and what that job came to. */
function programDetail(absent: boolean, jobId: string | undefined, status: string | undefined, line: string): string {
  if (absent) return 'no eval call ran the program in this turn';

  if (jobId === undefined) return `the program answered ${line.slice(0, 300)}`;

  return status === undefined
    ? `the program detached as ${jobId}, which had not settled when the budget was spent`
    : `the program detached as ${jobId}, which settled ${status} with ${line.slice(0, 300)}`;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A terse assistant that runs the program it is given and reports its line.',
      // A base snapshot built after a reset, then the program itself, detached: the wait ends when its job settles.
      budgetMs: 10 * 60_000,
      async run({ session, budget }) {
        const landing = await session.prompt(ASK);

        const calls = firstRunTurnEvents(await session.runEvents(), ASK, {
          splicedAtStep: firstRunSpliceStep(await session.history(), ASK),
          absorbedBy: landing.landed === 'mid-turn' ? landing.absorbedBy : undefined,
        }).filter(isToolCallEnd);

        const program = calls.find((call) => call.name === 'eval');
        const handle = isBackgroundHandle(program?.result) ? program.result : undefined;
        const job = handle === undefined ? undefined : await settledJob(session, handle.jobId, budget);
        const line = JSON.stringify(handle === undefined ? program?.result ?? program?.error ?? '' : job?.result ?? job?.error ?? '');
        const counted = v.safeParse(CountSchema, line);
        const match = counted.success ? /EXEC (\d+)\/(\d+) LOST (\S+)/u.exec(counted.output) : null;

        return [
          {
            what: 'every-output-returned',
            reached: match !== null && match[1] === String(COMMANDS) && match[2] === String(COMMANDS),
            detail: programDetail(program === undefined, handle?.jobId, job?.status, line),
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
