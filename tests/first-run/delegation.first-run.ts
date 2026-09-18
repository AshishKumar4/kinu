/**
 * FIRST RUN: delegation settles — a hired helper answers, reports back, and retires.
 *
 * THE ASK. Turn one hires a task-lifetime helper to say one specific word and
 * relays its answer; turn two hires a durable helper and lists the roster;
 * turn three dismisses it and lists again. Every check reads durable state —
 * the ledger's `tool_call_end` rows, the stored transcript — never the model's
 * own account of what it did.
 *
 * WHY EVERY GATE STAYED GREEN. `every-tool` deliberately EXCLUDES `hire` and
 * asserts `agents` was never called; unit proofs drive the agents tool against
 * fixtures the test author wrote. Nothing asked the deployed agent to hire a
 * helper and then read back whether the hire settled, whether the helper's
 * answer reached the parent, and whether the roster retired the row.
 *
 * SYNCHRONOUS BY DESIGN. Every subgoal is checkable the moment its turn
 * closes: a task hire answers inside the call that asked for it, a durable
 * hire/list/dismiss all settle in-turn. Nothing here waits on a subordinate
 * report wake, so this row needs no poll loop and no wall clock of its own.
 *
 * SYSTEM-CARD CEILING, AND ITS BLIND SPOT. The conversation must gain no
 * "system, to be shown to the agent" cards beyond SYSTEM_CARD_CEILING, counted
 * over history rows whose role is `system`. What this count CANNOT see: the
 * public session's history drops every row's id and metadata, so a
 * harness-stamped user row (a queued signal's durable message, which the chat
 * renders as an event card rather than a user bubble) is invisible to it. A
 * product that moves its unbounded growth into metadata-stamped user rows
 * passes this subgoal; that half needs a product seam to see, and this row
 * does not add one.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import type { JsonValue, RunEvent } from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';

const SUITE = 'First-run · delegation';

const CASE = 'delegation' as const;

/** The one word the task helper is told to say and the root is told to relay. */
const WORD = 'bramblelight';

const TASK_ASK = 'Use your agents tool to hire one helper: action hire, lifetime task, role task, '
  + `mission "Reply with exactly the word ${WORD} and nothing else." `
  + 'The hire waits for its single answer and returns it in the call result. '
  + 'When it answers, reply with one line: HIRED <its answer>.';

const ROSTER_ASK = 'Use your agents tool to hire one durable helper: action hire, role task, '
  + 'mission "Stand by for one question." A durable hire omits the lifetime field and stays '
  + 'in the roster. Then list the roster (agents action list) and reply with one line: '
  + 'ROSTER <every name the roster shows>.';

/** The exact bound the card subgoal holds: delegation may drain at most this many cards. */
const SYSTEM_CARD_CEILING = 2;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

/**
 * Say what each subgoal measured, from inside the case.
 *
 * `runFirstRunCase` prints the same lines AFTER it collects the episode's
 * evidence, and that collection can itself refuse — a row whose product never
 * called a model fails on the model-call contract before any verdict is
 * printed, which is how the first live drive of this row lost its subgoals to
 * a one-line budget error. Printing here costs one line per subgoal and keeps
 * the measurement readable whatever the harness decides afterwards.
 */
function announce(subgoals: readonly EvalSubgoal[]): readonly EvalSubgoal[] {
  for (const subgoal of subgoals) {
    console.warn(`    [delegation] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
  }

  return subgoals;
}

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

/** The one field every action-shaped tool call carries; anything else is the tool's own business. */
const ActionArgsSchema = v.looseObject({ action: v.optional(v.string()) });

function actionOf(call: ToolCallEnd): string {
  const parsed = v.safeParse(ActionArgsSchema, call.args);

  return parsed.success ? (parsed.output.action ?? '') : '';
}

/** A result as the text a reader greps: a string as-is, anything else as JSON. */
function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

function excerpt(value: string, length = 160): string {
  return JSON.stringify(value.slice(0, length));
}

/** A call answered: closed with no transport error and no refusal outcome. */
function answered(call: ToolCallEnd): boolean {
  return call.error === undefined && call.outcome?.success !== false;
}

function describeFailure(call: ToolCallEnd): string {
  const outcome = call.outcome !== undefined && !call.outcome.success
    ? ` outcome=${call.outcome.reason ?? 'null'}` : '';

  return `${call.name}#${call.toolCallId}${outcome}`
    + (call.error === undefined ? '' : ` error=${excerpt(call.error, 200)}`);
}

/** The hired name, read off the hire result the deployment answered — never off the reply. */
const HireResultSchema = v.looseObject({ name: v.optional(v.string()), agent: v.optional(v.string()) });

function hiredName(call: ToolCallEnd): string | null {
  const parsed = v.safeParse(HireResultSchema, call.result);

  if (!parsed.success) return null;

  return parsed.output.name ?? parsed.output.agent ?? null;
}

function agentsCalls(calls: readonly ToolCallEnd[], action: string): ToolCallEnd[] {
  return calls.filter((call) => call.name === 'agents' && actionOf(call) === action);
}

describe(SUITE, () => {
  // THE ROW MUST TERMINATE under the same contract as background-settle: the
  // tier runs with testTimeout 0, so an episode the product leaves open would
  // hold the tier open with it. The case's BUDGET ends the wait the product
  // owes no more of; the harness retains the ledger as found and the verdict
  // reads it. No wall clock of this row's own: no setTimeout, no Date
  // comparison, no per-test timeout beyond this shared shape.
  liveTest(`MEASURED: ${CASE}`, { timeout: 24 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A lead that has one helper answer one word, shows a second on the roster, and retires it.',
      // Three live turns on the product's own path, each of which may splice
      // into the workspace's opening turn and wait for it. Sized from the
      // first live drive, where the opening turn alone had not closed at ten
      // minutes: a row that only ever fails on its own budget has measured
      // nothing about delegation.
      budgetMs: 20 * 60_000,
      async run({ session }) {
        const subgoals: EvalSubgoal[] = [];

        await session.prompt(TASK_ASK);
        await session.prompt(ROSTER_ASK);

        const calls = (await session.runEvents())
          .filter((event): event is ToolCallEnd => event.type === 'tool_call_end');

        // A `tool_call_end` row exists only for a call that CLOSED: a hire
        // the product left open has no row here, so a settled result IS the
        // settle — there is no "call left open" state this row could miss.
        const taskHire = agentsCalls(calls, 'hire')
          .find((call) => answered(call) && call.result !== undefined);

        subgoals.push({
          what: 'hire-settles',
          reached: taskHire !== undefined,
          detail: taskHire !== undefined
            ? `agents#${taskHire.toolCallId} (hire) closed with ${excerpt(textOf(taskHire.result))}`
            : `no settled hire call: ${agentsCalls(calls, 'hire').map(describeFailure).join('; ') || 'none'}`,
        });

        const runHistory = await session.history();
        const firstAnswer = runHistory.filter((row) => row.role === 'assistant').at(0)?.text ?? '';

        subgoals.push({
          what: 'word-reported',
          reached: taskHire !== undefined && textOf(taskHire.result).includes(WORD) && firstAnswer.includes(WORD),
          detail: taskHire === undefined
            ? 'no settled hire result to read the word off'
            : `hire result ${textOf(taskHire.result).includes(WORD) ? 'carries' : 'lacks'} ${JSON.stringify(WORD)}; `
              + `first assistant row ${firstAnswer.includes(WORD) ? 'relays' : 'misses'} it: ${excerpt(firstAnswer, 240)}`,
        });

        const taskHireName = taskHire === undefined ? null : hiredName(taskHire);

        const durableName = agentsCalls(calls, 'hire')
          .map(hiredName)
          .find((candidate) => candidate !== null && candidate !== taskHireName) ?? null;

        const listRows = agentsCalls(calls, 'list').filter(answered);

        // The durable hire is dismissed by name, so the retire prompt names
        // the row the roster actually showed — never a name the reply guessed.
        if (durableName !== null) {
          await session.prompt(
            `Dismiss the durable helper with your agents tool: action dismiss, agent ${JSON.stringify(durableName)}. `
            + 'Then list the roster (agents action list) and reply with one line: RETIRED.',
          );
        }

        const later = (await session.runEvents())
          .filter((event): event is ToolCallEnd => event.type === 'tool_call_end');

        const dismisses = agentsCalls(later, 'dismiss').filter(answered);
        const laterRosters = agentsCalls(later, 'list').filter(answered);
        const firstDismiss = dismisses.at(0);
        const shown = durableName !== null && listRows.some((call) => textOf(call.result).includes(durableName));

        // `eventIndex` counts within ONE run, so "after the dismiss" is only a
        // question inside the dismiss's own run: an earlier turn's roster read
        // can carry a larger index and would otherwise read as the later one.
        const retired = durableName !== null && firstDismiss !== undefined
          && laterRosters.some((call) => call.runId === firstDismiss.runId
            && call.eventIndex > firstDismiss.eventIndex
            && !textOf(call.result).includes(durableName));

        subgoals.push({
          what: 'roster-shows-and-retires',
          reached: durableName !== null && shown && retired,
          detail: durableName === null
            ? 'no durable hired name on any settled hire result, so the roster cannot be read for it'
            : `helper ${JSON.stringify(durableName)}: roster ${shown ? 'showed' : 'never showed'} it; `
              + `${String(dismisses.length)} settled dismiss call(s); a later roster `
              + `${retired ? 'no longer names' : 'still names or never re-read'} it`,
        });

        const systemRows = (await session.history()).filter((row) => row.role === 'system').length;

        subgoals.push({
          what: 'system-cards-bounded',
          reached: systemRows <= SYSTEM_CARD_CEILING,
          detail: `${String(systemRows)} system row(s) in the conversation against a ceiling of `
            + `${String(SYSTEM_CARD_CEILING)} (blind spot: metadata-stamped harness rows read as `
            + 'user rows over this session — see the header)',
        });

        return announce(subgoals);
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
