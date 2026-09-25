import { afterAll, describe, test } from 'vitest';
import { isBackgroundHandle, type RunEvent } from '../../packages/core/src/index';
import type { EvalObservation } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { firstRunReplyText } from './turn-settlement';

const SUITE = 'First-run · background-settle';

const CASE = 'background-settle' as const;

/** The word the detached command prints after its sleep — what a settled wake
 *  must carry back to the assistant's transcript. */
const MARKER = 'KINU_SETTLED_AFTER_DETACH';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/**
 * The settle a detached `shell` owes the agent, measured the way the missing
 * recovery surfaced: `public-failure-recovery` on build 2fbe8695f backgrounded
 * its test run at the 30s window and the episode's ledger closed with the
 * result still on the job row — the wake either never ran or ran where nobody
 * scoring could see it. This row asks for a sleep that must detach, then asks
 * the transcript whether the settlement ever reached the assistant.
 */
describe(SUITE, () => {
  // THE ROW MUST TERMINATE: the tier runs every row with testTimeout 0 (an
  // episode's completion decides, never elapsed wall time), so an episode the
  // product leaves open would hold the tier open with it. The wait loop below
  // ends when the wake run closes; the case's BUDGET ends it when the product
  // owes no more waiting — the 45 s sleep, one detach window, the settle, and
  // the retry the runner guarantees before a wake is re-queued. If the budget
  // gives first, the harness retains the ledger as found and the verdict
  // reads it: a still-open wake is red, not unknown. (The runner's own
  // timeout, wider, retained nothing: build fddd4f9d6 timed out at 600 s with
  // an empty episode directory.)
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      // No genesis turn: the detach this row measures is its own prompt's,
      // and a reply spliced into a genesis turn under way is that turn's.
      genesis: false,
      purpose: 'Run a slow command on the container, let it settle out of turn, and report what it printed.',
      modelCalls: 'expected',
      budgetMs: 10 * 60_000,
      async run({ session, budget }) {
        const first = await session.prompt(
          `Use your shell tool with runtime 'sandbox' to execute exactly: sleep 45 && echo ${MARKER}. `
          + 'The command sleeps before it prints — let it run to completion, do not kill it. '
          + 'When it has finished, tell me the marker it printed.',
        );

        // The answer to THIS prompt, wherever it landed: a send that spliced
        // into the genesis turn has no turn result of its own, and its reply
        // is on the transcript. Read now, before the wake adds its own rows.
        const replyText = first.landed === 'turn'
          ? first.text
          : firstRunReplyText(await session.history(), MARKER);

        // The handle the detach left behind: `result` carries the job id the
        // wake run's opening message will name. No handle means the call ran
        // to completion in-window — possible only if the detach window moved
        // past 45s — and then the wake half of this case never engaged.
        const eventsAfterFirst = await session.runEvents();

        const handle = eventsAfterFirst
          .filter((event): event is Extract<RunEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end')
          .map((call) => call.result)
          .find(isBackgroundHandle);

        const jobId = handle?.jobId;

        // THE WAKE'S COMPLETION IS THE BOUND, not a clock: the run to wait on
        // names the job id in its `run_start.userMessage`, and the wait ends
        // when that run has closed — or, when no such run ever opened, once
        // the job row is settled and nothing is still running, on two reads
        // that agree. A wake that never arrives is this row's finding, not
        // its timeout.
        let settledWakeSeen = false;
        let quiet = 0;

        while (!budget.aborted) {
          const [jobs, events] = await Promise.all([session.backgroundJobs(), session.runEvents()]);

          const openRuns = new Set(
            events.filter((event) => event.type === 'run_start').map((event) => event.runId)
              .filter((runId) => !events.some((end) => end.type === 'run_end' && end.runId === runId)),
          );

          const wakeRuns = jobId === undefined ? [] : events
            .filter((event) => event.type === 'run_start' && event.userMessage?.includes(jobId) === true)
            .map((event) => event.runId);

          if (wakeRuns.length > 0) {
            if (wakeRuns.every((runId) => !openRuns.has(runId))) {
              settledWakeSeen = true;
              break;
            }

            quiet = 0;
          } else {
            const job = jobs.find((candidate) => candidate.id === jobId);
            const settled = job !== undefined && job.status !== 'running';

            if (!settled || openRuns.size > 0) {
              quiet = 0;
            } else {
              quiet += 1;

              if (quiet >= 2) break;
            }
          }

          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }

        const history = await session.history();
        const markerReply = history.find((row) => row.role === 'assistant' && row.text.includes(MARKER));

        return [
          {
            what: 'detach-announced',
            reached: jobId !== undefined
              && (/bgjob-|background/i.test(replyText) || replyText.includes(jobId)),
            detail: `first reply ${first.landed === 'turn' ? 'ended its turn' : 'spliced into the open turn'}; `
              + `handle jobId=${String(jobId)}; reply=${JSON.stringify(replyText.slice(0, 300))}`,
          },
          {
            what: 'wake-ran',
            reached: settledWakeSeen,
            detail: jobId === undefined
              ? 'no background handle in the first run\'s calls — the command never detached'
              : `wake run for ${jobId} ${settledWakeSeen ? 'opened and closed' : 'never closed'}`,
          },
          {
            what: 'marker-reported',
            reached: markerReply !== undefined,
            detail: markerReply === undefined
              ? `no assistant reply carries ${MARKER}`
              : `reply: ${JSON.stringify(markerReply.text.slice(0, 300))}`,
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
