import { afterAll, describe, test } from 'vitest';
import type { RunEvent } from '../../packages/core/src/index';
import type { EvalObservation } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · background-wake';

const CASE = 'background-wake' as const;

/** The three commands the turn runs, one call each: what "no tool ran twice"
 *  is counted over. */
const STEPS = ['KINU_WAKE_STEP_ONE', 'KINU_WAKE_STEP_TWO', 'KINU_WAKE_STEP_THREE'] as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** Every tool call the ledger holds, oldest first, with the command it ran
 *  when it ran one. */
function commandsRun(events: readonly RunEvent[]): string[] {
  return events
    .filter((event): event is Extract<RunEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end')
    .map((call) => JSON.stringify(call.args ?? null))
    .flatMap((args) => STEPS.filter((step) => args.includes(step)));
}

/**
 * A multi-step turn continues across two ended activations with no client
 * connected. The product has no natural way to end an activation on demand,
 * so the row uses the eval-only abort (ARCHITECTURE-DECISIONS C3): the
 * workspace object is reset while the turn is inside its tool steps, twice,
 * and what re-drives the turn is the durable wake alone — the turn-open row
 * and the tick that keeps a row while the run is open. The ledger is the
 * oracle: the run the first activation opened is the run that closes, once;
 * the answer is the final step's; no tool ran twice.
 *
 * WHAT IS NOT OBSERVABLE HERE: the schedule rows themselves. `cf_agents_schedules`
 * has no public read, so "a wake row existed while owed and none remains
 * after" is asserted through its consequence — a turn nothing but a wake could
 * have re-driven closed — and the rows are pinned in `unit-alarm-wake-chain`.
 */
describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      purpose: 'Run three commands in order, one call each, and report what each printed.',
      modelCalls: 'expected',
      budgetMs: 10 * 60_000,
      async run({ session, budget }) {
        const submission = session.submit(
          `Use your run tool with runtime 'workspace' three times, one command per call, in this order, `
          + `and wait for each result before the next: echo ${STEPS[0]}; then echo ${STEPS[1]}; then echo ${STEPS[2]}. `
          + 'Do not combine them into one command. When all three have printed, reply with exactly the three '
          + 'words they printed, one per line, and nothing else.',
        );

        // Not awaited: the client leaves. The ledger is what the row reads.
        void submission;

        const openRunId = async (): Promise<string | undefined> => (await session.runEvents())
          .find((event) => event.type === 'run_start' && event.userMessage?.includes(STEPS[0]) === true)?.runId;

        const closed = (events: readonly RunEvent[], runId: string): boolean =>
          events.some((event) => event.type === 'run_end' && event.runId === runId);

        // The turn is inside its work: its run is open and its first command ran.
        let runId: string | undefined;

        while (!budget.aborted) {
          const events = await session.runEvents();
          runId = await openRunId();

          if (runId !== undefined && commandsRun(events).length >= 1) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }

        session.disconnect();
        const aborts: string[] = [];

        // Two ended activations, each while the run is still open, with no
        // client connected in between: the wake is the only driver left.
        for (const nth of ['first', 'second']) {
          if (budget.aborted || runId === undefined) break;

          const before = (await session.runEvents()).filter((event) => event.runId === runId).length;

          if (closed(await session.runEvents(), runId)) break;
          await session.abortActivation();
          aborts.push(nth);

          // The continuation is under way: the same run grew after the abort.
          while (!budget.aborted) {
            const events = await session.runEvents();

            if (closed(events, runId) || events.filter((event) => event.runId === runId).length > before) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
          }
        }

        while (!budget.aborted && runId !== undefined && !closed(await session.runEvents(), runId)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }

        const events = await session.runEvents();
        const starts = events.filter((event) => event.type === 'run_start' && event.userMessage?.includes(STEPS[0]) === true);
        const ends = events.filter((event) => event.type === 'run_end' && starts.some((start) => start.runId === event.runId));
        const ran = commandsRun(events);
        const history = await session.history();
        const answer = history.filter((row) => row.role === 'assistant').at(-1)?.text ?? '';

        return [
          {
            what: 'aborted-twice',
            reached: aborts.length === 2,
            detail: `activations ended: ${aborts.length} (${aborts.join(', ')}); run ${String(runId)}`,
          },
          {
            what: 'one-run-closed',
            reached: runId !== undefined && starts.length === 1 && ends.length === 1 && ends[0]?.runId === runId,
            detail: `runs opened for the ask: ${String(starts.length)}; closed: ${String(ends.length)}; `
              + `the first activation's run ${String(runId)} ${runId !== undefined && closed(events, runId) ? 'closed' : 'is still open'}`,
          },
          {
            what: 'no-tool-ran-twice',
            reached: ran.length === STEPS.length && new Set(ran).size === STEPS.length,
            detail: `commands run, in order: ${JSON.stringify(ran)}`,
          },
          {
            what: 'answer-is-final-step',
            reached: STEPS.every((step) => answer.includes(step)) && !/echo/i.test(answer),
            detail: `last assistant row: ${JSON.stringify(answer.slice(0, 300))}`,
          },
        ];
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
