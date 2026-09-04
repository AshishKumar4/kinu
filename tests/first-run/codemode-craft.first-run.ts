/**
 * FIRST RUN: the agent builds a tool and uses it, and the tool RUNS.
 *
 * THE DEFECT. The owner asked for a small tool in plain words and the tool came
 * back built and broken: the body reached the executor and failed instead of
 * answering. Crafting is the product's headline capability, and a tool that
 * cannot run is worse than no tool — the model plans on top of it.
 *
 * WHY EVERY GATE STAYED GREEN. Every crafted-tool test in this tree hands the
 * executor a body the TEST AUTHOR wrote: `async (args) => args.a + args.b`,
 * valid by construction, sometimes typed. The behaviour eval drives a real model
 * and refuses instructed crafting on purpose (`INSTRUCTED_CRAFTING`). So the one
 * input a user actually supplies — a body the MODEL wrote, compiled by the
 * platform the deployment runs on — was executed by nothing.
 *
 * WHAT THIS CASE DRIVES. A fresh deployed workspace, the real model, and one
 * sentence of plain English asking for a tool and for its answer on an input
 * this file knows the answer to. The prompt names no code, no signature and no
 * API: writing the body here would rebuild the very fixture that missed the
 * defect. What is named is the OUTCOME the reply must carry, because a case
 * whose ground truth is prose cannot be graded.
 *
 * THE ASSERTIONS, all hard:
 *
 *   crafted    the workspace's crafted set holds a tool that was not there when
 *              the case opened. Read off `getToolDescriptions`, the RPC the
 *              Tools pane is bound to.
 *   executed   an `execute_tools` call closed with NO error, and its own
 *              arguments show the crafted tool being CALLED (`tools.<name>(`),
 *              not merely created. A tool that was created and never invoked is
 *              exactly the half-success this case exists to refuse.
 *   answered   the reply carries the arithmetic answer this file computed
 *              independently. A refusal, an apology, a plan, or the right shape
 *              with the wrong number is RED.
 *
 * WHY `execute_tools` AND NOT A ROW PER CRAFTED CALL: a crafted tool runs INSIDE
 * the codemode program — the preamble splices its body into the sandbox arrow —
 * so the ledger's unit is the `execute_tools` call that ran it. Confirmed with
 * the lane rebuilding crafted execution on codemode's modules+prelude
 * (2026-09-03): the dispatch shape `tools.<name>(` inside `execute_tools` is
 * preserved by that rebuild, and no per-tool row is planned.
 *
 * RED, DELIBERATELY, AS THIS TIER'S OWN RULE APPLIED TO ITSELF. Crafted
 * execution is being rebuilt in a sibling lane. This case is written against the
 * deployed product BEFORE that rebuild lands, so it is red on the mechanism the
 * owner hit rather than green on the mechanism its author imagined. It goes
 * green when the rebuild ships, and never because this file was adjusted.
 */
import { afterAll, describe, test } from 'vitest';

import type { EvalObservation } from '@kinu.run/test-utils';
import type { RunEvent } from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
  type FirstRunSubgoal,
} from './first-run';

const SUITE = 'First-run · codemode-craft';
const CASE = 'codemode-craft' as const;

/**
 * The input, and the answer this file computed without the product.
 *
 * Two three-digit numbers rather than one obvious pair: the answer must not be
 * something a model can produce by pattern rather than by running the tool it
 * just wrote, and it must not collide with any number the surrounding prose
 * contains. The tool is asked for a SUM OF DIGITS, which is a real loop — a body
 * with no branch or accumulator cannot answer it.
 */
const INPUT = '4827516390';
/** 4+8+2+7+5+1+6+3+9+0 = 45, computed here, in this file, from the string
 *  above — never read back off the deployment. */
const ANSWER = [...INPUT].reduce((sum, digit) => sum + Number(digit), 0);

/**
 * The ask, in the words a person uses.
 *
 * It names the CAPABILITY ("a reusable tool of your own") and the OUTCOME ("the
 * number on its own line"), and nothing else: no function signature, no
 * `createTool`, no mention of codemode. A prompt that spelled the API would test
 * whether the model can transcribe an instruction, which is not the thing that
 * broke.
 */
const ASK = 'Build yourself a small reusable tool that adds up the digits of a number, then '
  + `use that tool on ${INPUT} and reply with the resulting number on its own line. `
  + 'Do the arithmetic with the tool rather than in your head.';

const PLAN = firstRunCasePlan(SUITE, CASE);
const liveTest = test.skipIf(PLAN === null);
const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, [CASE], observations); });

function isToolCallEnd(event: RunEvent): event is Extract<RunEvent, { type: 'tool_call_end' }> {
  return event.type === 'tool_call_end';
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE,
      purpose: 'A precise engineer who builds small reusable tools and uses them rather than '
        + 'describing what they would do.',
      async run({ session }) {
        // The crafted set BEFORE the ask, so "a tool appeared" is a difference
        // this case observed rather than a name it hoped for. A fresh workspace
        // should hold none, and asserting the delta rather than the absolute
        // keeps the case honest if a deployment ever seeds one.
        const before = new Set((await session.craftedTools()).map((tool) => tool.name));

        const turn = await session.prompt(ASK);
        const events = await session.runEvents();
        const calls = events.filter(isToolCallEnd);
        const codemode = calls.filter((call) => call.name === 'execute_tools');

        const crafted = (await session.craftedTools()).filter((tool) => !before.has(tool.name));
        const names = crafted.map((tool) => tool.name);

        // A call that RAN the crafted tool: closed with no transport error, and
        // its own program calls `tools.<name>(`. Both halves are required — a
        // program that only creates the tool satisfies neither, and a call that
        // threw satisfies the first only by accident.
        const invoked = codemode.filter((call) => {
          if (call.error !== undefined) return false;
          // The ARGUMENTS digest is where a crafted call is visible: the
          // codemode program is what the model sent, and `tools.<name>(` inside
          // it is the call. The result is searched too, because a program that
          // printed the tool's output names it there.
          const text = JSON.stringify({ args: call.args ?? null, result: call.result ?? null });
          return names.some((name) => text.includes(`tools.${name}(`));
        });

        // The reply, from the durable transcript rather than from the streamed
        // turn: what a user reads when they come back is the stored answer.
        const history = await session.history();
        const reply = history.filter((row) => row.role === 'assistant').at(-1)?.text ?? turn.text;
        // Digits-only comparison, so a reply that writes `45` inside a sentence
        // counts and one that writes `450` or `4.5` does not.
        const carriesAnswer = new RegExp(`(?<![0-9.])${String(ANSWER)}(?![0-9.])`).test(reply);

        const failures = codemode
          .filter((call) => call.error !== undefined)
          .map((call) => `${call.name}: ${String(call.error).slice(0, 200)}`);

        const subgoals: FirstRunSubgoal[] = [
          {
            what: 'crafted',
            reached: crafted.length > 0,
            detail: crafted.length > 0
              ? `the workspace now holds ${names.join(', ')}`
              : 'the model built no tool at all: the crafted set is unchanged after the ask',
          },
          {
            what: 'executed',
            reached: invoked.length > 0,
            detail: invoked.length > 0
              ? `${String(invoked.length)} execute_tools call(s) ran the crafted tool clean`
              : `no execute_tools call ran the crafted tool and closed clean — `
                + `${String(codemode.length)} codemode call(s), `
                + `${String(failures.length)} of them failed`
                + (failures.length > 0 ? `: ${failures.join('; ')}` : ''),
          },
          {
            what: 'answered',
            reached: carriesAnswer,
            detail: `the reply ${carriesAnswer ? 'carries' : 'does NOT carry'} ${String(ANSWER)}: `
              + JSON.stringify(reply.slice(0, 240)),
          },
        ];
        return subgoals;
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing five case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
