/**
 * FIRST RUN: a delegation tree of uneven depth settles, every branch reporting
 * back through its own parent.
 *
 * THE ASK. Hosted subordinates that delegate in turn: the root hires two
 * task helpers; one hires a helper of its own and relays its answer, the other
 * answers itself. So one branch is two levels deep and the other one, and the
 * tree settles only when the deep answer has climbed both levels and the
 * shallow one its single level. Every check reads the ledger's `agents`
 * rows and the stored reply, never the model's account of what it did.
 *
 * WHY `delegation` DOES NOT COVER IT. That row hires at one level only. A
 * nested hire runs in a subordinate hosted by the same workspace object, with
 * its own delegation budget one level down, and its answer reaches the root
 * only through the middle helper's settlement — none of which a one-level
 * hire exercises.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import type { RunEvent } from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · delegation-tree';

const CASE = 'delegation-tree' as const;

/** The word the deep helper says, two levels below the root. */
const DEEP = 'emberfall';

/** The word the shallow helper says, one level below the root. */
const SHALLOW = 'tidewater';

const ASK = 'Use your agents tool to hire two helpers, each with action hire, lifetime task and role task. '
  + 'The first helper\'s mission: "Use your agents tool to hire one helper with action hire, lifetime task '
  + `and role task, whose mission is: Reply with exactly the word ${DEEP} and nothing else. When it `
  + 'answers, reply with exactly its answer and nothing else." '
  + `The second helper's mission: "Reply with exactly the word ${SHALLOW} and nothing else." `
  + 'When both have answered, reply with one line: TREE <first helper\'s answer> <second helper\'s answer>.';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const HireArgsSchema = v.looseObject({ action: v.literal('hire'), lifetime: v.literal('task') });

const TaskAnswerSchema = v.looseObject({
  status: v.literal('completed'), lifetime: v.literal('task'), agent: v.string(), answer: v.string(),
});

/** One settled task hire: the run that made it, whom it hired, what came back. */
interface SettledHire {
  readonly runId: string;
  readonly agent: string;
  readonly answer: string;
}

/** Every task hire in the ledger that settled with an answer, from any level. */
function settledHires(events: readonly RunEvent[]): SettledHire[] {
  return events
    .filter((event): event is ToolCallEnd => event.type === 'tool_call_end' && event.name === 'agents')
    .filter((call) => v.safeParse(HireArgsSchema, call.args).success && call.error === undefined)
    .flatMap((call) => {
      const answer = v.safeParse(TaskAnswerSchema, call.result);

      return answer.success ? [{ runId: call.runId, agent: answer.output.agent, answer: answer.output.answer.trim() }] : [];
    });
}

/** How much of a message a run's start keeps (`turn-lifecycle.ts`, `slice(0, 500)`). */
const RUN_START_MESSAGE_CHARS = 500;

/** The runs this row's own message opened: the root's turn, never a helper's.
 *  This ask is longer than a run's start keeps, so it is matched as cut. */
function rootRuns(events: readonly RunEvent[]): ReadonlySet<string> {
  const opened = ASK.slice(0, RUN_START_MESSAGE_CHARS);

  return new Set(events.filter((event) => event.type === 'run_start' && event.userMessage === opened).map((event) => event.runId));
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      genesis: false,
      purpose: 'A precise coordinator that delegates exactly as asked and relays answers verbatim.',
      async run({ session }) {
        await session.prompt(ASK);

        const events = await session.runEvents();
        const root = rootRuns(events);
        const hires = settledHires(events);
        const top = hires.filter((hire) => root.has(hire.runId));
        const nested = hires.filter((hire) => !root.has(hire.runId));
        const deep = nested.find((hire) => hire.answer === DEEP);
        const middle = deep === undefined ? undefined : top.find((hire) => hire.answer === DEEP);
        const shallow = top.find((hire) => hire.answer === SHALLOW);
        const reply = (await session.history()).filter((row) => row.role === 'assistant').at(-1)?.text ?? '';
        const seen = hires.map((hire) => `${root.has(hire.runId) ? 'root' : 'helper'}→${hire.agent}: ${JSON.stringify(hire.answer.slice(0, 40))}`).join('; ');

        return [
          {
            what: 'nested-hire-settled',
            reached: deep !== undefined,
            detail: nested.length > 0 ? `below the root: ${seen}` : `no hire settled below the root; settled hires: ${seen || 'none'}`,
          },
          {
            what: 'deep-branch-climbed-both-levels',
            reached: middle !== undefined,
            detail: middle !== undefined ? `${middle.agent} relayed ${DEEP} from its own helper` : `no root hire relayed ${DEEP} from a helper of its own: ${seen || 'none'}`,
          },
          {
            what: 'shallow-branch-settled',
            reached: shallow !== undefined,
            detail: shallow !== undefined ? `${shallow.agent} answered ${SHALLOW} at one level` : `no root hire answered ${SHALLOW}: ${seen || 'none'}`,
          },
          {
            what: 'root-reported-both',
            reached: reply.includes(DEEP) && reply.includes(SHALLOW),
            detail: `the stored reply: ${JSON.stringify(reply.slice(0, 200))}`,
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
