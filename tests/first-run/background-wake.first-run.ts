import { afterAll, describe, test } from 'vitest';
import type { RunEvent } from '../../packages/core/src/index';
import type { EvalObservation } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { WAKE_ASK, WAKE_STEPS as STEPS } from './asks';

const SUITE = 'First-run · background-wake';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A multi-step turn whose activation ended mid-turn — an isolate killed, an alarm-boundary '
    + 'reset — sat un-driven: the run row stayed open with nothing scheduled to notice it. The '
    + 'turn-open wake added at 4fe96cf72 was released by the first tick that fired inside the turn, '
    + 'so an ordinary turn held a wake for about one second (REVIEW-chat-loop C2).',
  missedBecause: 'the wake-chain suite listed schedules right after a turn opened and never fired a '
    + 'tick with the turn parked; the workerd background-wake case holds the turn in-process and '
    + 'ends no activation; and the deployed product had no way to end one, so no row could ask it.',
  provedRedAt: 'fddd4f9d6',
  redDirection: 'RED by reading on build fddd4f9d6: `_kinuTerminalRetryTick` cancelled its armed row '
    + 'whenever `nextOwedAt()` was null, and an open run row is untimed, so every mid-turn tick left '
    + 'the registry empty (packages/cf-backend/src/actor-agent.ts:1929-1932 at that build). '
    + 'Unit red: unit-alarm-wake-chain "a tick that fires inside a parked turn keeps a wake row" '
    + 'found 0 rows before 14909875d. This row is the live proof; it needs the eval-only abort '
    + '(ARCHITECTURE-DECISIONS C3) to end an activation on the deployed build, so its first live '
    + 'run is on the build that carries both.',
};

const PLAN = firstRunCasePlan(SUITE, 'bgwake');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

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
 * WHAT IS NOT OBSERVABLE HERE: the wake rows themselves. `cf_agents_jobs`
 * has no public read, so "a wake row existed while owed and none remains
 * after" is asserted through its consequence — a turn nothing but a wake could
 * have re-driven closed — and the rows are pinned in `unit-alarm-wake-chain`.
 */
describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      defect: DEFECT,
      // No genesis turn: the row's prompt must open its OWN run — the wake
      // it measures is that run's, and a send that spliced into a genesis
      // turn already under way streams under that turn's request id, which
      // is a chunk this row would wait on until its budget ended.
      genesis: false,
      purpose: 'Run three commands in order, one call each, and report what each printed.',
      modelCalls: 'expected',
      budgetMs: 10 * 60_000,
      async run({ session, budget }) {
        const submission = session.submit(WAKE_ASK);

        // The turn is inside its work: its first tool result has streamed to
        // this socket (a wait on the socket's own output). The run row is
        // durable before any tool result, so one read names it.
        await session.awaitChunk(submission.requestId, (body) => body.includes('"tool-output-available"'));
        const ledger = await session.runEvents();
        const runId = ledger.find((event) => event.type === 'run_start' && event.userMessage?.includes(STEPS[0]) === true)?.runId;
        let cursor = ledger.filter((event) => event.runId === runId).reduce((max, event) => Math.max(max, event.eventIndex), 0);

        // The client leaves; the turn's own promise is abandoned on purpose
        // (`disconnect` documents why) and the ledger is what the row reads.
        session.disconnect();
        const aborts: string[] = [];
        let ended = runId === undefined;

        // Two ended activations, each while the run is still open, with no
        // client connected in between: the wake is the only driver left. Each
        // continuation lands its next call before the next abort, read on the
        // run's own stream: a turn that dies twice at one step on one build is
        // closed as stalled, by design.
        for (const nth of ['first', 'second']) {
          if (budget.aborted || runId === undefined || ended) break;
          await session.abortActivation();
          aborts.push(nth);

          for await (const event of session.followRun(runId, cursor)) {
            cursor = event.eventIndex;
            ended = event.type === 'run_end';

            if (ended || event.type === 'tool_call_end' || budget.aborted) break;
          }
        }

        if (runId !== undefined && !ended && !budget.aborted) {
          for await (const event of session.followRun(runId, cursor)) {
            cursor = event.eventIndex;
            ended = event.type === 'run_end';

            if (ended || budget.aborted) break;
          }
        }

        // The socket the case dropped on purpose comes back for the reads the
        // harness makes after this returns: spend is a socket RPC.
        await session.connect();
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
              + `the first activation's run ${String(runId)} ${ended ? 'closed' : 'is still open'}`,
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
